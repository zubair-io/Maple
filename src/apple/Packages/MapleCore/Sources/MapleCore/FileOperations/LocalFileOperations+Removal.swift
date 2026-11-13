// Local RAW/XMP snapshot placement and rollback (#3944). Immutable companions
// are never removed here: other photos and history may still reference them.
import Darwin
import Foundation
import OSLog

private let removalRelocationLog = Logger(
  subsystem: "app.justmaple.aperture", category: "LocalFileOperations")

extension LocalFileOperations {
  /// Cheap pre-check so ordinary photos never take the removal lock or hash
  /// their original on a move.
  static func sidecarCarriesRemovals(_ sidecar: URL) -> Bool {
    (try? String(contentsOf: sidecar, encoding: .utf8))?.contains("InpaintRemovals") ?? false
  }

  /// A move keeps its source when the source sidecar now carries accepted
  /// removals that differ from the copy the plan staged: deleting it could
  /// discard a newer stack whose companions never reached the destination.
  static func removalSourceChangedSincePlan(_ plan: RelocatePlan) -> Bool {
    guard let sourcePath = plan.sourceSidecarPath, !plan.retainsSourceSidecar,
      sidecarCarriesRemovals(URL(fileURLWithPath: sourcePath))
    else { return false }
    let staged = plan.finalSidecarPath.flatMap { FileManager.default.contents(atPath: $0) }
    guard FileManager.default.contents(atPath: sourcePath) != staged else { return false }
    removalRelocationLog.error(
      "finalizeRelocate: source sidecar changed after planning; source retained (\(sourcePath, privacy: .public))"
    )
    return true
  }

  static func finalizeLocalSnapshot(
    _ plan: RelocatePlan, snapshot: LocalRelocationSnapshot
  ) async {
    defer { snapshot.lease?.release() }
    do {
      let source = try LocalRemovalRelocation.open(
        rawURL: URL(fileURLWithPath: plan.sourcePrimaryPath))
      guard source.snapshot == snapshot.sidecar,
        source.originalDigest == snapshot.originalDigest
      else { throw RemovalError.saveConflict }
      let destinationLock = try lockRelocationDestination(
        URL(fileURLWithPath: plan.finalPrimaryPath), sourceSidecar: source.sourceSidecar)
      defer { unlockRelocationDestination(destinationLock) }
      try LocalRelocationJournal.verifyOwner(
        snapshot.journalID, target: URL(fileURLWithPath: plan.finalPrimaryPath))
      try source.verifyDestination(rawURL: URL(fileURLWithPath: plan.finalPrimaryPath))
      if plan.mode == .move {
        try removeSnapshotSources(plan)
        await invalidateDerivedCaches(forOldPrimaryPath: plan.sourcePrimaryPath)
        await refreshLibraryIndexAfterMove(plan)
      }
      discardReplacementBackups(snapshot)
      try LocalRelocationJournal.remove(
        snapshot.journalID, target: URL(fileURLWithPath: plan.finalPrimaryPath))
    } catch {
      try? sealCopiedSnapshot(plan, snapshot: snapshot)
      removalRelocationLog.error(
        "finalizeRelocate: snapshot changed or delete failed; source or recovery evidence retained: \(error.localizedDescription, privacy: .public)"
      )
    }
  }

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
    // change shares the same sidecar and must retain it at the destination;
    // a sidecar another same-stem photo still uses is never taken (#4707).
    let source = URL(fileURLWithPath: plan.sourcePrimaryPath)
    let sidecarShared = SidecarOwnership.localStemClaimedBySibling(source)
    try FileManager.default.removeItem(atPath: plan.sourcePrimaryPath)
    if let sourceSidecar = plan.sourceSidecarPath, !sidecarShared, !plan.retainsSourceSidecar {
      let original = URL(fileURLWithPath: sourceSidecar).resolvingSymlinksInPath()
      let destination = plan.finalSidecarPath.map {
        URL(fileURLWithPath: $0).resolvingSymlinksInPath()
      }
      if original != destination { try FileManager.default.removeItem(atPath: sourceSidecar) }
    }
  }

  /// Undo a plan that will never be finalized — removes the staged
  /// copies, leaving the source (and everything else) exactly as it was
  /// before `planRelocate` ran. Not applicable to a case-only rename
  /// (`sourceAlreadyRelocated`) — that has no staged copies to revert;
  /// undoing it would mean renaming back, which a caller that actually
  /// needs that can do by calling `planRelocate` again in reverse.
  public static func revertPlan(_ plan: RelocatePlan) {
    if let snapshot = plan.localSnapshot {
      do { try revertLocalSnapshot(plan, snapshot: snapshot) } catch {
        removalRelocationLog.error(
          "revertPlan: destination changed or rollback failed; backup retained: \(error.localizedDescription, privacy: .public)"
        )
      }
      return
    }
    for path in plan.createdPaths {
      try? FileManager.default.removeItem(atPath: path)
    }
  }
}
