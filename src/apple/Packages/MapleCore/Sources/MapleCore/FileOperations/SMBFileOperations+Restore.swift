import CryptoKit
import Foundation

extension SMBFileOperations {
  /// Server-side copies remain private until both members are verified; SMB rename
  /// is exclusive (replace_if_exist = 0), so publication never replaces an occupant.
  static func restoreFilePair(_ source: String, to directory: String, transport: SMBFileTransport)
    async throws -> RelocateOutcome
  {
    let sidecars = try await restorePairedSidecars(source, transport: transport)
    var originals: [(path: String, identity: RestoreSMBFile)] = []
    for path in sidecars + [source] {
      originals.append((path, try await RestoreSMBFile.capture(path, transport: transport)))
    }
    try await ensureRestoreDirectory(directory, transport: transport)
    let original = posixJoin(directory, (source as NSString).lastPathComponent)
    let stagePrefix = original + ".tmp." + UUID().uuidString
    var members:
      [(source: String, original: RestoreSMBFile, staged: String, copy: RestoreSMBFile)] = []
    do {
      for (index, original) in originals.enumerated() {
        let staged = stagePrefix + "." + String(index)
        try await transport.copyItem(
          atPath: original.path, toPath: staged, recursive: false, progress: nil)
        let copied = try await RestoreSMBFile.capture(staged, transport: transport)
        guard !originals.contains(where: { $0.identity.inode == copied.inode }) else {
          throw FileOperationError.verificationFailed("Restore staging aliases an original")
        }
        members.append((original.path, original.identity, staged, copied))
        guard copied.hash == original.identity.hash else {
          throw FileOperationError.verificationFailed(
            "Restore copy differs from source: \(original.path)")
        }
      }
      for attempt in -1...CollisionResolver.maxAttempts {
        try Task.checkCancellation()
        let target = RestoreCollisionNaming.candidate(original, attempt: attempt)
        guard !(try await RestoreSMBFile.exists(target, transport: transport)),
          try await restorePairedSidecars(target, transport: transport).isEmpty
        else { continue }
        let destinations = try members.map { member in
          member.source == source
            ? target : try RestoreSidecarPairing.target(member.source, from: source, to: target)
        }
        var published: [Int] = []
        do {
          for member in members {
            try await member.original.assertUnchanged(member.source, transport: transport)
          }
          for (index, member) in members.enumerated() {
            try await member.copy.assertUnchanged(member.staged, transport: transport)
            try await member.copy.moveIfUnchanged(
              member.staged, to: destinations[index], transport: transport)
            published.append(index)
            try await member.copy.assertUnchanged(destinations[index], transport: transport)
          }
        } catch {
          try await restoreUnpublish(
            published, members: members, destinations: destinations, transport: transport)
          if let error = error as? POSIXError, error.code == .EEXIST { continue }
          throw error
        }
        let finalSidecars = try await restorePairedSidecars(target, transport: transport)
        if Set(finalSidecars) != Set(destinations.dropLast()) {
          try await restoreUnpublish(
            published, members: members, destinations: destinations, transport: transport)
          continue
        }
        do {
          for (index, member) in members.enumerated() {
            try await member.copy.assertUnchanged(destinations[index], transport: transport)
          }
          for member in members {
            try await member.original.assertUnchanged(member.source, transport: transport)
          }
        } catch {
          try await restoreUnpublish(
            published, members: members, destinations: destinations, transport: transport)
          throw error
        }
        for member in members {
          try await member.original.removeIfUnchanged(member.source, transport: transport)
        }
        await invalidateDerivedCaches(forOldPrimaryPath: source, transport: transport)
        let canonical = sidecarPath(for: target)
        let selected =
          destinations.dropLast().first { $0 == canonical } ?? destinations.dropLast().first
        return RelocateOutcome(
          primaryPath: target, sidecarPath: selected,
          renamedDueToCollision: attempt >= 0, sidecarFollowed: !sidecars.isEmpty)
      }
      throw FileOperationError.destinationExists(
        "Restore exhausted collision candidates for \(original)")
    } catch {
      // Copy/publication failures retain all originals. Once every member is
      // published, a source-cleanup failure leaves the verified complete pair.
      for member in members {
        try? await member.copy.removeIfUnchanged(member.staged, transport: transport)
      }
      throw error
    }
  }

  private static func restorePairedSidecars(_ primary: String, transport: SMBFileTransport)
    async throws -> [String]
  {
    let directory = (primary as NSString).deletingLastPathComponent
    let entries = try await transport.contentsOfDirectory(atPath: directory, recursive: false)
    let names = entries.compactMap { $0[.nameKey] as? String }
    return try RestoreSidecarPairing.matchedNames(names, primary: primary).map {
      posixJoin(directory, $0)
    }
  }

  private static func restoreUnpublish(
    _ published: [Int],
    members: [(source: String, original: RestoreSMBFile, staged: String, copy: RestoreSMBFile)],
    destinations: [String], transport: SMBFileTransport
  ) async throws {
    for index in published.reversed() {
      let member = members[index]
      try await member.copy.assertUnchanged(destinations[index], transport: transport)
      try await member.copy.moveIfUnchanged(
        destinations[index], to: member.staged, transport: transport)
    }
  }

  private static func ensureRestoreDirectory(_ directory: String, transport: SMBFileTransport)
    async throws
  {
    let parent = (directory as NSString).deletingLastPathComponent
    if directory != "/" {
      guard parent != directory else { throw FileOperationError.invalidDestination(directory) }
      try await ensureRestoreDirectory(parent, transport: transport)
    }
    if try await RestoreSMBFile.exists(directory, transport: transport) {
      let attributes = try await transport.attributesOfItem(atPath: directory)
      guard (attributes[.isDirectoryKey] as? NSNumber)?.boolValue == true,
        (attributes[.isSymbolicLinkKey] as? NSNumber)?.boolValue != true
      else {
        throw FileOperationError.invalidDestination(directory)
      }
      return
    }
    guard directory != "/" else { throw FileOperationError.invalidDestination(directory) }
    try await transport.createDirectory(atPath: directory)
  }
}

private struct RestoreSMBFile {
  let inode: UInt64
  let hash: SHA256.Digest

  static func exists(_ path: String, transport: SMBFileTransport) async throws -> Bool {
    do {
      _ = try await transport.attributesOfItem(atPath: path)
      return true
    } catch let error as POSIXError where error.code == .ENOENT { return false }
  }

  static func capture(_ path: String, transport: SMBFileTransport) async throws -> Self {
    let attributes = try await transport.attributesOfItem(atPath: path)
    guard (attributes[.isRegularFileKey] as? NSNumber)?.boolValue == true,
      (attributes[.isSymbolicLinkKey] as? NSNumber)?.boolValue != true,
      let inode = (attributes[.documentIdentifierKey] as? NSNumber)?.uint64Value, inode != 0
    else {
      throw FileOperationError.verificationFailed(
        "Restore requires a regular file identity: \(path)")
    }
    let bytes = try await transport.readFile(atPath: path)
    let after = try await transport.attributesOfItem(atPath: path)
    guard (after[.documentIdentifierKey] as? NSNumber)?.uint64Value == inode,
      (after[.isRegularFileKey] as? NSNumber)?.boolValue == true,
      (after[.isSymbolicLinkKey] as? NSNumber)?.boolValue != true,
      (after[.fileSizeKey] as? NSNumber)?.intValue == bytes.count,
      (attributes[.contentModificationDateKey] as? Date)
        == (after[.contentModificationDateKey] as? Date)
    else {
      throw FileOperationError.verificationFailed("Restore file changed while reading: \(path)")
    }
    return Self(inode: inode, hash: SHA256.hash(data: bytes))
  }

  func assertUnchanged(_ path: String, transport: SMBFileTransport) async throws {
    let current = try await Self.capture(path, transport: transport)
    guard current.inode == inode, current.hash == hash else {
      throw FileOperationError.verificationFailed("Restore file changed: \(path)")
    }
  }

  func moveIfUnchanged(_ path: String, to destination: String, transport: SMBFileTransport)
    async throws
  {
    let expected = hash
    try await transport.moveRestoreFile(atPath: path, toPath: destination, expectedIdentity: inode)
    {
      SHA256.hash(data: $0) == expected
    }
  }

  func removeIfUnchanged(_ path: String, transport: SMBFileTransport) async throws {
    let expected = hash
    try await transport.removeRestoreFile(atPath: path, expectedIdentity: inode) {
      SHA256.hash(data: $0) == expected
    }
  }
}
