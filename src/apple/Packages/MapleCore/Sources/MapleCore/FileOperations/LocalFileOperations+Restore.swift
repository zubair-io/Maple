import CryptoKit
import Darwin
import Foundation

extension LocalFileOperations {
  /// Stage the complete pair before publishing either member. `link` claims each
  /// destination exclusively, so a concurrent writer is a collision, never replaced.
  static func restoreFilePair(_ source: URL, to directory: URL) throws -> RelocatePlan {
    try restoreFilePair(source, to: directory, beforeClaim: nil)
  }

  // Release-available, per-operation immutable fence for the current actual
  // publication-substitution tests (#4139). Calls are serial within this job;
  // no shared mutable hook or public configuration exists.
  static func restoreFilePair(
    _ source: URL, to directory: URL,
    beforeClaim: (@Sendable (URL, URL) throws -> Void)?,
    beforeRemoval: (@Sendable (URL) throws -> Void)? = nil
  ) throws -> RelocatePlan {
    let fm = FileManager.default
    let names = try fm.contentsOfDirectory(atPath: source.deletingLastPathComponent().path)
    let sidecars = try RestoreSidecarPairing.matchedNames(names, primary: source.path).map {
      source.deletingLastPathComponent().appendingPathComponent($0)
    }
    let originals = try (sidecars + [source]).map { try RestoreLocalFile.capture($0) }
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let stage = directory.appendingPathComponent(".maple-restore.tmp." + UUID().uuidString)
    try fm.createDirectory(at: stage, withIntermediateDirectories: false)
    defer { _ = rmdir(stage.path) }
    var members: [(source: URL, original: RestoreLocalFile, staged: URL, copy: RestoreLocalFile)] =
      []
    defer {
      for member in members { try? member.copy.removeIfUnchanged(member.staged) }
    }
    for (index, original) in originals.enumerated() {
      let url = URL(fileURLWithPath: original.path)
      let staged = stage.appendingPathComponent(String(index))
      try fm.copyItem(at: url, to: staged)
      let copy = try RestoreLocalFile.capture(staged)
      guard !originals.contains(where: { $0.device == copy.device && $0.inode == copy.inode })
      else {
        throw FileOperationError.verificationFailed("Restore staging aliases an original")
      }
      members.append((url, original, staged, copy))
      guard copy.hash == original.hash else {
        throw FileOperationError.verificationFailed("Restore copy differs from source: \(url.path)")
      }
    }
    let original = directory.appendingPathComponent(source.lastPathComponent)
    for attempt in -1...CollisionResolver.maxAttempts {
      try Task.checkCancellation()
      let target = URL(
        fileURLWithPath: RestoreCollisionNaming.candidate(original.path, attempt: attempt))
      guard !(try RestoreLocalFile.exists(target)) else { continue }
      let occupied = try RestoreSidecarPairing.matchedNames(
        fm.contentsOfDirectory(atPath: directory.path), primary: target.path)
      guard occupied.isEmpty else { continue }
      let destinations = try members.map { member in
        member.source == source
          ? target
          : URL(
            fileURLWithPath:
              try RestoreSidecarPairing.target(
                member.source.path, from: source.path, to: target.path))
      }
      var published: [Int] = []
      do {
        for member in members { try member.original.assertUnchanged(member.source) }
        for (index, member) in members.enumerated() {
          try member.copy.assertUnchanged(member.staged)
          try beforeClaim?(member.staged, destinations[index])
          try exclusiveRestoreLink(member.staged, destinations[index])
          published.append(index)
          try member.copy.assertUnchanged(destinations[index])
        }
      } catch {
        for index in published.reversed() {
          try members[index].copy.removeIfUnchanged(destinations[index])
        }
        if let error = error as? POSIXError, error.code == .EEXIST { continue }
        throw error
      }
      // A writer may have added an unrelated paired XMP during the claims.
      // Refuse to associate it with this photograph, retaining all originals.
      let finalNames = try RestoreSidecarPairing.matchedNames(
        fm.contentsOfDirectory(atPath: directory.path), primary: target.path)
      let expected = Set(destinations.dropLast().map(\.lastPathComponent))
      if Set(finalNames) != expected {
        for index in published.reversed() {
          try members[index].copy.removeIfUnchanged(destinations[index])
        }
        continue
      }
      do {
        for (index, member) in members.enumerated() {
          try member.copy.assertUnchanged(destinations[index])
        }
        for member in members { try member.original.assertUnchanged(member.source) }
      } catch {
        for index in published.reversed() {
          try members[index].copy.removeIfUnchanged(destinations[index])
        }
        throw error
      }
      for member in members {
        try member.original.removeIfUnchanged(member.source, beforeRemoval: beforeRemoval)
      }
      let canonical = SidecarPath.sidecarURL(for: target)
      let selected =
        destinations.dropLast().first { $0 == canonical } ?? destinations.dropLast().first
      return RelocatePlan(
        mode: .move, sourcePrimaryPath: source.path,
        sourceSidecarPath: sidecars.first?.path, finalPrimaryPath: target.path,
        finalSidecarPath: selected?.path, renamedDueToCollision: attempt >= 0,
        createdPaths: [], sourceAlreadyRelocated: true)
    }
    throw FileOperationError.destinationExists(
      "Restore exhausted collision candidates for \(original.path)")
  }

  private static func exclusiveRestoreLink(_ source: URL, _ destination: URL) throws {
    guard link(source.path, destination.path) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }
}

private struct RestoreLocalFile {
  let path: String
  let device: dev_t
  let inode: ino_t
  let hash: SHA256.Digest

  static func exists(_ url: URL) throws -> Bool {
    var info = stat()
    if lstat(url.path, &info) == 0 { return true }
    if errno == ENOENT { return false }
    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }

  static func capture(_ url: URL, cancellable: Bool = true) throws -> Self {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    return try captureDescriptor(descriptor, path: url.path, cancellable: cancellable)
  }

  private static func captureDescriptor(_ descriptor: Int32, path: String, cancellable: Bool) throws
    -> Self
  {
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
      throw FileOperationError.verificationFailed("Restore requires a regular file: \(path)")
    }
    var digest = SHA256()
    while let bytes = try handle.read(upToCount: 1_048_576), !bytes.isEmpty {
      if cancellable { try Task.checkCancellation() }
      digest.update(data: bytes)
    }
    return Self(path: path, device: info.st_dev, inode: info.st_ino, hash: digest.finalize())
  }

  func assertUnchanged(_ url: URL, cancellable: Bool = true) throws {
    let current = try Self.capture(url, cancellable: cancellable)
    guard current.device == device, current.inode == inode, current.hash == hash else {
      throw FileOperationError.verificationFailed("Restore file changed: \(path)")
    }
  }

  func removeIfUnchanged(
    _ url: URL, beforeRemoval: (@Sendable (URL) throws -> Void)? = nil
  ) throws {
    try assertUnchanged(url, cancellable: false)
    try beforeRemoval?(url)
    // Claim the namespace atomically into private custody before validating
    // and deleting. A concurrent replacement is returned exclusively, never
    // unlinked through the original public path (#4139).
    let parent = url.deletingLastPathComponent()
    let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parentFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(parentFD) }
    let custodyName = ".maple-restore.custody." + UUID().uuidString
    guard mkdirat(parentFD, custodyName, 0o700) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer { _ = unlinkat(parentFD, custodyName, AT_REMOVEDIR) }
    let custodyFD = openat(parentFD, custodyName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard custodyFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(custodyFD) }
    guard
      renameatx_np(parentFD, url.lastPathComponent, custodyFD, "claimed", UInt32(RENAME_EXCL)) == 0
    else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    do {
      let descriptor = openat(custodyFD, "claimed", O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      let current = try Self.captureDescriptor(descriptor, path: url.path, cancellable: false)
      guard current.device == device, current.inode == inode, current.hash == hash else {
        throw FileOperationError.verificationFailed(
          "Restore cleanup found a replacement: \(url.path)")
      }
      guard unlinkat(custodyFD, "claimed", 0) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
    } catch {
      // Preserve every unknown claimed entry even if a new public occupant
      // prevents restoring its name. The private recovery path is explicit.
      if renameatx_np(custodyFD, "claimed", parentFD, url.lastPathComponent, UInt32(RENAME_EXCL))
        != 0
      {
        throw FileOperationError.verificationFailed(
          "Restore cleanup retained a file at \(parent.appendingPathComponent(custodyName).path)/claimed"
        )
      }
      throw error
    }
  }
}
