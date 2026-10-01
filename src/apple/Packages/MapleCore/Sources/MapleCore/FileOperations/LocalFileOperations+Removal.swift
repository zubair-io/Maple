// Local RAW/XMP snapshot placement and rollback (#3944). Immutable companions
// are never removed here: other photos and history may still reference them.
import Darwin
import Foundation

extension LocalFileOperations {
  static func placeLocalSnapshot(
    _ source: LocalRemovalRelocation, from raw: URL,
    to target: URL, mode: RelocateMode,
    renamed: Bool
  ) async throws -> RelocatePlan {
    let fm = FileManager.default
    let sidecar = SidecarPath.sidecarURL(for: target)
    let descriptor = try lockRelocationDestination(target, sourceSidecar: source.sourceSidecar)
    defer { unlockRelocationDestination(descriptor) }
    try LocalRelocationJournal.recoverIfAbandoned(target: target)
    let backups = try replacementBackups([target, sidecar])
    let lease: LocalRelocationLease
    do {
      lease = try LocalRelocationJournal.create(
        source: source, target: target, backups: backups)
    } catch {
      if !fm.fileExists(atPath: LocalRelocationJournal.url(for: target).path) {
        for backup in backups.values { try? fm.removeItem(atPath: backup) }
      }
      throw error
    }
    do {
      try await source.copyCompanions(to: target)
      try source.verifySnapshot()
      try copyVerified(from: raw, to: target)
      if let snapshot = source.snapshot {
        let temporary = sidecar.deletingLastPathComponent().appendingPathComponent(
          ".\(UUID().uuidString).tmp.xmp")
        defer { try? fm.removeItem(at: temporary) }
        try snapshot.write(to: temporary, options: .withoutOverwriting)
        let attributes = try fm.attributesOfItem(atPath: source.sourceSidecar.path)
        if let date = attributes[.modificationDate] {
          try fm.setAttributes([.modificationDate: date], ofItemAtPath: temporary.path)
        }
        try copyVerified(from: temporary, to: sidecar)
      } else if fm.fileExists(atPath: sidecar.path) {
        try fm.removeItem(at: sidecar)
      }
      try source.verifySnapshot()
      try source.verifyDestination(rawURL: target)
      return RelocatePlan(
        mode: mode, sourcePrimaryPath: raw.path,
        sourceSidecarPath: source.snapshot == nil ? nil : source.sourceSidecar.path,
        finalPrimaryPath: target.path,
        finalSidecarPath: source.snapshot == nil ? nil : sidecar.path,
        renamedDueToCollision: renamed,
        createdPaths: source.snapshot == nil ? [target.path] : [target.path, sidecar.path],
        localSnapshot: source.proof(backups: backups, journalID: lease.id, lease: lease))
    } catch {
      // The previous occupant survives a failure after primary publication.
      // Keep backups if restoration itself fails, allowing manual recovery.
      try restoreReplacementBackups(backups, targets: [target.path, sidecar.path])
      try LocalRelocationJournal.remove(lease.id, target: target)
      throw error
    }
  }

  private static func replacementBackups(_ targets: [URL]) throws -> [String: String] {
    let fm = FileManager.default
    var backups: [String: String] = [:]
    do {
      for target in targets where fm.fileExists(atPath: target.path) {
        guard try target.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
          throw FileOperationError.verificationFailed(
            "Replacement target is not a regular file: \(target.path)")
        }
        let backup = URL(fileURLWithPath: target.path + ".tmp.\(UUID().uuidString).rollback")
        try copyVerified(from: target, to: backup)
        backups[target.path] = backup.path
      }
      return backups
    } catch {
      for backup in backups.values { try? fm.removeItem(atPath: backup) }
      throw error
    }
  }

  static func discardReplacementBackups(_ snapshot: LocalRelocationSnapshot) {
    for backup in snapshot.backups.values { try? FileManager.default.removeItem(atPath: backup) }
  }

  private static func restoreReplacementBackups(
    _ backups: [String: String],
    targets: [String]
  ) throws {
    let fm = FileManager.default
    for path in targets {
      if let backup = backups[path] {
        try copyVerified(from: URL(fileURLWithPath: backup), to: URL(fileURLWithPath: path))
      } else if fm.fileExists(atPath: path) {
        try fm.removeItem(atPath: path)
      }
    }
    for backup in backups.values { try? fm.removeItem(atPath: backup) }
  }

  static func revertLocalSnapshot(
    _ plan: RelocatePlan,
    snapshot: LocalRelocationSnapshot
  ) throws {
    defer { snapshot.lease?.release() }
    let target = URL(fileURLWithPath: plan.finalPrimaryPath)
    let descriptor = try lockRelocationDestination(target)
    defer { unlockRelocationDestination(descriptor) }
    try LocalRelocationJournal.verifyOwner(snapshot.journalID, target: target)
    guard
      try RemovalBridge.digest(Data(contentsOf: target, options: .mappedIfSafe))
        == snapshot.originalDigest,
      try LocalRemovalRelocation.sidecarBytes(SidecarPath.sidecarURL(for: target))
        == snapshot.sidecar
    else { throw RemovalError.saveConflict }
    try restoreReplacementBackups(
      snapshot.backups,
      targets: [target.path, SidecarPath.sidecarURL(for: target).path])
    try LocalRelocationJournal.remove(snapshot.journalID, target: target)
  }

  static func lockRelocationDestination(_ target: URL, sourceSidecar: URL? = nil) throws -> Int32 {
    let sidecar = SidecarPath.sidecarURL(for: target)
    if let sourceSidecar,
      sidecar.resolvingSymlinksInPath() == sourceSidecar.resolvingSymlinksInPath()
    {
      return -1
    }
    let lock = sidecar.deletingLastPathComponent().appendingPathComponent(
      ".\(sidecar.lastPathComponent).lock")
    let descriptor = Darwin.open(lock.path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      throw RemovalError.saveConflict
    }
    return descriptor
  }

  static func unlockRelocationDestination(_ descriptor: Int32) {
    if descriptor >= 0 {
      flock(descriptor, LOCK_UN)
      close(descriptor)
    }
  }

  /// Reconcile an interrupted copy/replacement without deleting its source.
  /// An active plan or a later edit leaves recovery evidence untouched.
  public static func recoverLocalRelocation(at target: URL) throws {
    guard FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path)
    else { return }
    let descriptor = try lockRelocationDestination(target)
    defer { unlockRelocationDestination(descriptor) }
    try LocalRelocationJournal.recoverIfAbandoned(target: target)
  }

  static func sealCopiedSnapshot(
    _ plan: RelocatePlan,
    snapshot: LocalRelocationSnapshot
  ) throws {
    let target = URL(fileURLWithPath: plan.finalPrimaryPath)
    let descriptor = try lockRelocationDestination(target)
    defer { unlockRelocationDestination(descriptor) }
    try LocalRelocationJournal.verifyOwner(snapshot.journalID, target: target)
    guard try LocalRelocationJournal.digestIfPresent(target) == snapshot.originalDigest,
      try LocalRemovalRelocation.sidecarBytes(SidecarPath.sidecarURL(for: target))
        == snapshot.sidecar
    else {
      throw RemovalError.saveConflict
    }
    if let data = snapshot.sidecar, let records = try RemovalXMPRecords.read(data) {
      try RemovalBridge.verifySource(records: records, rawURL: target)
      _ = try LocalRemovalAssetStore.readAssets(
        records: records,
        directory: target.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
    }
    discardReplacementBackups(snapshot)
    try LocalRelocationJournal.remove(snapshot.journalID, target: target)
  }

  static func synchronizeLocalDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  }

  static func removeSnapshotSources(_ plan: RelocatePlan) throws {
    // Remove XMP only after primary unlink succeeds. A same-stem extension
    // change shares the same sidecar and must retain it at the destination.
    try FileManager.default.removeItem(atPath: plan.sourcePrimaryPath)
    if let sourceSidecar = plan.sourceSidecarPath {
      let original = URL(fileURLWithPath: sourceSidecar).resolvingSymlinksInPath()
      let destination = plan.finalSidecarPath.map {
        URL(fileURLWithPath: $0).resolvingSymlinksInPath()
      }
      if original != destination { try FileManager.default.removeItem(atPath: sourceSidecar) }
    }
  }
}
