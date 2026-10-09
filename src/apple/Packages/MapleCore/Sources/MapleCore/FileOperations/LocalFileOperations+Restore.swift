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
    let anchor = try RestoreDirectoryAnchor.establish(directory, under: root)
    let stageName = ".maple-restore.tmp." + UUID().uuidString
    guard mkdirat(anchor.descriptor, stageName, 0o700) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let stage = directory.appendingPathComponent(stageName)
    var members: [(source: URL, original: RestoreLocalFile, staged: URL, copy: RestoreLocalFile)] =
      []
    defer {
      for member in members { try? member.copy.removeIfUnchanged(member.staged) }
      anchor.discardUnverifiedStaging(
        stageName, indices: members.count..<originals.count, sparing: originals)
      _ = unlinkat(anchor.descriptor, stageName, AT_REMOVEDIR)
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
            member.staged, into: anchor, of: directory, named: destinations[index],
            expecting: member.copy)
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

  /// Publish one staged member under an exclusive, never-replace claim made
  /// relative to the anchored directory descriptor, so a swapped ancestor can
  /// never redirect it. `link` preserves identity; where hard links are
  /// unavailable (exFAT, some providers) an `O_EXCL` copy is the fallback.
  /// The staged file is retained so a later collision retry can publish from
  /// it again. Returns the capture subsequent identity checks must use.
  private static func exclusiveRestorePublish(
    _ source: URL, into anchor: RestoreDirectoryAnchor, of directory: URL, named destination: URL,
    expecting: RestoreLocalFile
  ) throws -> RestoreLocalFile {
    let name = destination.lastPathComponent
    if linkat(AT_FDCWD, source.path, anchor.descriptor, name, 0) == 0 {
      return expecting
    }
    let linkError = errno
    try anchor.assertSame(directory)
    guard [EPERM, ENOTSUP, EOPNOTSUPP].contains(linkError) else {
      throw POSIXError(POSIXErrorCode(rawValue: linkError) ?? .EIO)
    }
    try anchor.copyExclusively(source, named: name)
    let published = try RestoreLocalFile.capture(destination)
    guard published.hash == expecting.hash else {
      try? published.removeIfUnchanged(destination)
      throw FileOperationError.verificationFailed(
        "Restore copy differs from source: \(source.path)")
    }
    return published
  }
}

/// A restore destination held open through `O_NOFOLLOW` handles. Establishing
/// it walks from the library root one component at a time, creating any
/// missing directory with `mkdirat` relative to its already-pinned parent, so
/// a swapped ancestor breaks the walk instead of redirecting a write outside
/// the library. `assertSame` re-resolves the public path and requires the
/// same device+inode before anything is claimed or a trash original removed.
private final class RestoreDirectoryAnchor {
  let descriptor: Int32
  let device: dev_t
  let inode: ino_t

  private init(descriptor: Int32, device: dev_t, inode: ino_t) {
    self.descriptor = descriptor
    self.device = device
    self.inode = inode
  }

  deinit { close(descriptor) }

  static func establish(_ directory: URL, under root: URL) throws -> RestoreDirectoryAnchor {
    let realRoot = root.resolvingSymlinksInPath().standardizedFileURL.path
    let target = directory.standardizedFileURL.path
    guard
      let components = [root.standardizedFileURL.path, realRoot].lazy
        .compactMap({ relativeComponents(of: target, under: $0) }).first
    else { throw FileOperationError.invalidDestination(directory.path) }
    let rootFD = open(realRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    let pinned = try components.reduce(rootFD) { parent, component in
      defer { close(parent) }
      return try openOrCreate(component, in: parent, directory: directory)
    }
    var info = stat()
    guard fstat(pinned, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
      close(pinned)
      throw FileOperationError.verificationFailed(
        "Restore destination is not a directory: \(directory.path)")
    }
    return RestoreDirectoryAnchor(descriptor: pinned, device: info.st_dev, inode: info.st_ino)
  }

  private static func relativeComponents(of target: String, under root: String) -> [String]? {
    guard target != root else { return [] }
    let prefix = root == "/" ? "/" : root + "/"
    guard target.hasPrefix(prefix) else { return nil }
    return target.dropFirst(prefix.count).split(separator: "/").map(String.init)
  }

  private static func openOrCreate(_ name: String, in parent: Int32, directory: URL) throws
    -> Int32
  {
    let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW
    let existing = openat(parent, name, flags)
    if existing >= 0 { return existing }
    if errno == ELOOP || errno == ENOTDIR {
      throw FileOperationError.invalidDestination(directory.path)
    }
    guard errno == ENOENT else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    guard mkdirat(parent, name, 0o755) == 0 || errno == EEXIST else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let created = openat(parent, name, flags)
    guard created >= 0 else {
      if errno == ELOOP || errno == ENOTDIR {
        throw FileOperationError.invalidDestination(directory.path)
      }
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    return created
  }

  /// No-clobber copy into the anchored directory. A partial file this call
  /// created is removed only while the name still holds that same inode.
  func copyExclusively(_ source: URL, named name: String) throws {
    let input = open(source.path, O_RDONLY | O_NOFOLLOW)
    guard input >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(input) }
    let output = openat(descriptor, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
    guard output >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(output) }
    guard fcopyfile(input, output, nil, copyfile_flags_t(COPYFILE_DATA)) == 0, fsync(output) == 0
    else {
      let failure = errno
      var created = stat()
      var current = stat()
      if fstat(output, &created) == 0,
        fstatat(descriptor, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
        created.st_dev == current.st_dev, created.st_ino == current.st_ino
      {
        _ = unlinkat(descriptor, name, 0)
      }
      throw POSIXError(POSIXErrorCode(rawValue: failure) ?? .EIO)
    }
  }

  /// A copy that failed before verification never joined the restore's
  /// members. Remove it through the pinned private stage, sparing any entry
  /// that is itself a trash original.
  func discardUnverifiedStaging(
    _ stageName: String, indices: Range<Int>, sparing originals: [RestoreLocalFile]
  ) {
    let stage = openat(descriptor, stageName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard stage >= 0 else { return }
    defer { close(stage) }
    for index in indices {
      var info = stat()
      guard fstatat(stage, String(index), &info, AT_SYMLINK_NOFOLLOW) == 0,
        !originals.contains(where: { $0.device == info.st_dev && $0.inode == info.st_ino })
      else { continue }
      _ = unlinkat(stage, String(index), 0)
    }
  }

  func assertSame(_ directory: URL) throws {
    // Any re-open failure — removed, or replaced by a symlink or file —
    // is a broken anchor, reported uniformly with an identity change.
    let reopened = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard reopened >= 0 else {
      throw FileOperationError.verificationFailed(
        "Restore destination changed during restore: \(directory.path)")
    }
    defer { close(reopened) }
    var info = stat()
    guard fstat(reopened, &info) == 0 else {
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
