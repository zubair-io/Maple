import CryptoKit
import Darwin
import Foundation

extension LocalFileOperations {
  /// Stage the complete pair before publishing either member. Each claim is
  /// exclusive — a concurrent writer is a collision, never replaced — via
  /// `link` where hard links exist, with a no-clobber copy fallback on
  /// filesystems without them (exFAT). `confinedTo` pins the trust root the
  /// destination is anchored to for the whole publication.
  static func restoreFilePair(_ source: URL, to directory: URL, confinedTo root: URL) throws
    -> RelocatePlan
  {
    try restoreFilePair(source, to: directory, confinedTo: root, beforeClaim: nil)
  }

  // Release-available, per-operation immutable fence for the current actual
  // publication-substitution tests (#4139). Calls are serial within this job;
  // no shared mutable hook or public configuration exists.
  static func restoreFilePair(
    _ source: URL, to directory: URL, confinedTo root: URL,
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
    // Pin the destination by walking from the library root: every ancestor
    // resolves through an O_NOFOLLOW handle, so a swapped ancestor either
    // breaks the walk or changes the identity the checks below compare
    // against (#4173 review).
    let anchor = try RestoreDirectoryAnchor.capture(directory, under: root)
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
          try anchor.assertSame(directory)
          try beforeClaim?(member.staged, destinations[index])
          members[index].copy = try exclusiveRestorePublish(
            member.staged, destinations[index], expecting: member.copy)
          published.append(index)
          try members[index].copy.assertUnchanged(destinations[index])
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
      // The trash originals go only while the destination still resolves
      // to the anchored directory — never after a redirection.
      try anchor.assertSame(directory)
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

  /// Publish one staged member under an exclusive, never-replace claim.
  /// `link` preserves identity on supporting filesystems; where hard links
  /// are unavailable (exFAT, some providers) a no-clobber copy is the
  /// fallback. The staged file is retained either way so a later collision
  /// retry can publish from it again. Returns the capture subsequent
  /// identity checks must use: the staged capture after a link, a fresh
  /// destination capture after a copy.
  private static func exclusiveRestorePublish(
    _ source: URL, _ destination: URL, expecting: RestoreLocalFile
  ) throws -> RestoreLocalFile {
    // The fast path is byte-identical to the original `link` claim; the
    // post-claim assertUnchanged at the call site still verifies it.
    if link(source.path, destination.path) == 0 {
      return expecting
    }
    guard errno == EPERM || errno == EOPNOTSUPP else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    // COPYFILE_EXCL keeps the no-clobber guarantee `link` provided: an
    // occupant fails with EEXIST and the collision loop advances past it.
    guard
      copyfile(source.path, destination.path, nil, UInt32(COPYFILE_EXCL | COPYFILE_DATA)) == 0
    else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let published = try RestoreLocalFile.capture(destination)
    guard published.hash == expecting.hash else {
      try? published.removeIfUnchanged(destination)
      throw FileOperationError.verificationFailed(
        "Restore copy differs from source: \(source.path)")
    }
    return published
  }
}

/// Identity of a restore destination pinned through O_NOFOLLOW handles.
/// Capture walks from the library root so each ancestor is a pinned file
/// descriptor — never a re-resolved path — and every later `assertSame`
/// re-opens the destination by path and requires the same device+inode.
/// A swapped ancestor either breaks the walk (symlink → ELOOP, missing →
/// ENOENT) or resolves to a different directory, failing the comparison.
private struct RestoreDirectoryAnchor {
  let device: dev_t
  let inode: ino_t

  static func capture(_ directory: URL, under root: URL) throws -> Self {
    let realRoot = root.resolvingSymlinksInPath().standardizedFileURL.path
    let resolved = directory.resolvingSymlinksInPath().standardizedFileURL.path
    let rootPrefix = realRoot == "/" ? "/" : realRoot + "/"
    guard resolved == realRoot || resolved.hasPrefix(rootPrefix) else {
      throw FileOperationError.invalidDestination(directory.path)
    }
    let relative =
      resolved == realRoot
      ? []
      : resolved.dropFirst(rootPrefix.count).split(separator: "/").map(String.init)
    let rootFD = open(realRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(rootFD) }
    var currentFD = rootFD
    var ownsCurrent = false
    defer { if ownsCurrent { close(currentFD) } }
    for component in relative {
      let next = openat(currentFD, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      guard next >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      if ownsCurrent { close(currentFD) }
      currentFD = next
      ownsCurrent = true
    }
    var info = stat()
    guard fstat(currentFD, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
      throw FileOperationError.verificationFailed(
        "Restore destination is not a directory: \(directory.path)")
    }
    return Self(device: info.st_dev, inode: info.st_ino)
  }

  func assertSame(_ directory: URL) throws {
    // Any re-open failure — removed, or replaced by a symlink or file —
    // is a broken anchor, reported uniformly with an identity change.
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw FileOperationError.verificationFailed(
        "Restore destination changed during restore: \(directory.path)")
    }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    guard info.st_dev == device, info.st_ino == inode else {
      throw FileOperationError.verificationFailed(
        "Restore destination changed during restore: \(directory.path)")
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
