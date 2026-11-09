// src/apple/Maple/Backup/ChangeObserverWiring.swift
//
// Wire PhotoKitChangeObserver → EngineHost.queue for incremental backup.
//
// On every library-change event (new capture, edit, delete in Apple Photos),
// enumerate PHAsset.fetchAssets(.image) + .video and enqueue any localIdentifier
// the state store hasn't seen yet. The change observer fires on a private
// PhotoKit thread; we hop to MainActor before touching EngineHost state.
//
// Concurrency: the enum is MainActor-isolated so callers on the UI can
// invoke start/stop without ceremony. The actual PhotoKit walk (fetch +
// enumerate) is heavy — for a 100k-photo library it can take several
// seconds — so the walk runs on a detached Task at userInitiated priority
// and only the result is brought back to MainActor. Without that hop, a
// settings-screen tap freezes the UI until enumeration finishes, which
// looks indistinguishable from a broken button.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §10.

import Foundation
import MapleBackup
import MapleCore
import OSLog
import Photos

private let log = Logger(subsystem: "app.justmaple.aperture", category: "Backup.ChangeObserver")

@MainActor
enum ChangeObserverWiring {

  /// Holds the subscription token between start() and stop(). Re-entering
  /// start() while already started replaces the token (cancels the old sub
  /// before adding a new one).
  private static var token: UUID?
  private static var walkTask: Task<Void, Never>?
  private static var walkAgain = false
  private static var generation = UUID()
  private static var configuration: BackupSettings?

  /// The set of phasset localIdentifiers seen on the most recent walk.
  /// Used to detect deletions: any id present in the previous walk but
  /// absent in the current walk was deleted from Apple Photos.
  /// Starts empty — no deletions are reported on the first walk after launch.
  private static var lastSeenPhids: Set<String> = []

  /// Subscribe to library changes. Idempotent.
  /// `settings` controls which asset types and categories are enqueued.
  /// `libraryId` and `serverBaseURL` are passed to the walk for delete
  /// reconciliation notifications.
  ///
  /// `retryFailed` controls the initial seeding walk only: pass `true` for an
  /// explicit user-initiated Restart so `.failedRetry` tasks are reset and
  /// re-enqueued. The change-observer-triggered walks that follow always run
  /// new-only (retryFailed: false) — incremental capture/edit events should
  /// never reset retry counts on the whole backlog.
  static func start(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL,
    retryFailed: Bool = false
  ) {
    // Registering a `PHPhotoLibraryChangeObserver` while authorization is
    // `.notDetermined` IS an authorization request (#2454) — starting the
    // wiring without access in hand raised the system Photos dialog at
    // launch with zero user interaction (#2851). Callers re-invoke start()
    // once the user grants access through the in-app flow.
    let status = PhotoKitLibrary.authorizationStatus()
    guard status == .authorized || status == .limited else {
      log.info(
        "start skipped: Photos authorization is \(status.rawValue) — not subscribing, not walking")
      return
    }
    if token != nil && configuration == settings { return }
    stop()
    configuration = settings
    let generation = self.generation
    log.info(
      "start subscribe deviceId=\(deviceId, privacy: .public) libraryId=\(libraryId, privacy: .public) server=\(serverBaseURL.absoluteString, privacy: .public) retryFailed=\(retryFailed)"
    )
    // Reset cross-walk delete-diff state so a library change doesn't mark
    // assets in the new library as deleted (they weren't in the old set).
    lastSeenPhids = []

    if let prior = token {
      PhotoKitChangeObserver.shared.unsubscribe(prior)
    }
    token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
      Task { @MainActor in
        guard generation == self.generation else { return }
        // Incremental change events are always new-only — a fresh
        // capture must not reset the whole backlog's retry counters.
        await scheduleWalk(
          deviceId: deviceId, settings: settings,
          libraryId: libraryId, serverBaseURL: serverBaseURL,
          retryFailed: false)
      }
    }
    // Kick off an initial walk so we don't wait for a change event to seed
    // the queue on first launch. This is the one walk that honours the
    // caller's `retryFailed` (so a user Restart retries the failures).
    Task {
      guard generation == self.generation else { return }
      await scheduleWalk(
        deviceId: deviceId, settings: settings,
        libraryId: libraryId, serverBaseURL: serverBaseURL,
        retryFailed: retryFailed)
    }
  }

  /// Unsubscribe from library changes. Idempotent.
  static func stop() {
    generation = UUID()
    configuration = nil
    walkTask?.cancel()
    walkTask = nil
    walkAgain = false
    if let t = token {
      PhotoKitChangeObserver.shared.unsubscribe(t)
      token = nil
    }
  }

  /// Stops the wiring and waits for a walk already in flight to exit, so
  /// nothing is still writing the shared state DB when the caller hands the
  /// engine lock to the backup helper (#4988).
  static func stopAndDrain() async {
    let inFlight = walkTask
    stop()
    await inFlight?.value
  }

  /// Public entry point for the periodic safety walk (called by EngineHost's
  /// weekly timer and the iOS BGProcessingTask handler). Always new-only —
  /// the periodic walk picks up new captures, it does not reset failed-retry
  /// tasks (that's reserved for an explicit user Restart).
  static func runWalk(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL
  ) async {
    // Same gate as start(): without access the walk sees an empty library,
    // which the delete-reconciliation diff would misread as "everything
    // was deleted" on a later authorized walk's lastSeenPhids baseline.
    let status = PhotoKitLibrary.authorizationStatus()
    guard status == .authorized || status == .limited else {
      log.info("runWalk skipped: Photos authorization is \(status.rawValue)")
      return
    }
    await scheduleWalk(
      deviceId: deviceId, settings: settings,
      libraryId: libraryId, serverBaseURL: serverBaseURL,
      retryFailed: false)
  }

  /// Coalesce PhotoKit notifications while one walk is active.
  private static func scheduleWalk(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL,
    retryFailed: Bool
  ) async {
    // `configuration` is cleared by stop(): a periodic or background walk
    // racing a stop must not start once the wiring is down.
    guard !Task.isCancelled, !BackupSettings.isStoppedByUser, configuration != nil,
      EngineHost.shared.progress.phase == .running
    else {
      return
    }
    if let walkTask {
      walkAgain = true
      await walkTask.value
      return
    }
    let generation = self.generation
    let task = Task {
      defer {
        // Always release this walk, including cancellation, without clearing
        // a replacement started after stop() advanced the generation.
        if generation == self.generation { walkTask = nil }
      }
      guard generation == self.generation, !Task.isCancelled else { return }
      var retryFailures = retryFailed
      repeat {
        walkAgain = false
        await enqueueAllNew(
          deviceId: deviceId, settings: settings,
          libraryId: libraryId, serverBaseURL: serverBaseURL,
          retryFailed: retryFailures)
        retryFailures = false
      } while walkAgain && !Task.isCancelled
    }
    walkTask = task
    await task.value
  }

  /// Walk every PHAsset and enqueue any we don't yet have in BackupStateStore.
  /// PHAsset.fetchAssets is SQLite-backed; the state lookup is also SQLite.
  /// For a 100k-asset library this is seconds, not minutes — but on the main
  /// thread, "seconds" is enough to freeze the UI, so the enumeration runs
  /// on a detached Task and only the resulting id list returns to MainActor.
  ///
  /// Applies inclusion filters from `settings`:
  ///  - `includeVideos`: skip video assets when false.
  ///  - `includeBursts`: skip non-representative burst frames when false.
  ///  - `includeSharedLibrary`: skip iCloud Shared Library assets
  ///    (PHAsset.sourceType == .typeCloudShared) when false.
  ///  - `includeSharedAlbums`: skip assets that belong to at least one
  ///    iCloud Shared Album (albumCloudShared) when false.
  private static func enqueueAllNew(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL,
    retryFailed: Bool
  ) async {
    log.info("walk begin libraryId=\(libraryId, privacy: .public) retryFailed=\(retryFailed)")
    guard let state = EngineHost.shared.state else {
      BackupIssueStatus.log(.error, "Backup scan stopped: engine state is unavailable")
      EngineHost.shared.progress.setWalkPhase(.failed("the backup engine never finished starting"))
      return
    }
    let queue = EngineHost.shared.queue
    guard !Task.isCancelled else { return }

    let cursor =
      (try? await state.cursor(deviceId: deviceId)) ?? BackupCursor(deviceId: deviceId)
    let isFastTokenCheck =
      !retryFailed && cursor.initialScanCompleted && cursor.phChangeToken != nil
      && EngineHost.shared.progress.lastWalkSummary != nil
    if !isFastTokenCheck {
      EngineHost.shared.progress.setWalkPhase(.enumerating)
    }

    let walkStarted = Date()
    let enumeration = Task.detached(priority: .userInitiated) {
      discoverAssets(cursor: cursor, settings: settings, retryFailed: retryFailed)
    }
    let outcome = await withTaskCancellationHandler {
      await enumeration.value
    } onCancel: {
      enumeration.cancel()
    }
    guard !Task.isCancelled else { return }

    let discoveredAssets: [DiscoveredAsset]
    let isFullScan: Bool
    let tokenDeletedPhids: Set<String>
    let newToken: Data?
    let fingerprint: String
    let completedInitialScan: Bool

    switch outcome {
    case .noChanges(let token):
      try? await state.updatePhotoKitChangeToken(deviceId: deviceId, token: token)
      if EngineHost.shared.progress.lastWalkSummary != nil {
        EngineHost.shared.progress.setWalkPhase(.idle)
        return
      }
      discoveredAssets = []
      isFullScan = false
      tokenDeletedPhids = []
      newToken = token
      fingerprint = settingsFingerprint(settings)
      completedInitialScan = true

    case .incremental(let inserted, let deleted, let token, let fp, let completed):
      if inserted.isEmpty, deleted.isEmpty, EngineHost.shared.progress.lastWalkSummary != nil {
        try? await state.updatePhotoKitChangeToken(deviceId: deviceId, token: token)
        EngineHost.shared.progress.setWalkPhase(.idle)
        return
      }
      discoveredAssets = inserted
      isFullScan = false
      tokenDeletedPhids = deleted
      newToken = token
      fingerprint = fp
      completedInitialScan = completed

    case .fullScan(let assets, let token, let fp):
      discoveredAssets = assets
      isFullScan = true
      tokenDeletedPhids = []
      newToken = token
      fingerprint = fp
      completedInitialScan = true
    }

    log.info(
      "walk discovered \(discoveredAssets.count) assets (fullScan=\(isFullScan)) in \(Int(Date().timeIntervalSince(walkStarted) * 1000))ms"
    )

    // Delete reconciliation: combine persistent-token deletions with full-scan diff.
    let currentPhids = Set(discoveredAssets.map(\.phid))
    var deletedPhids = tokenDeletedPhids
    if isFullScan {
      deletedPhids.formUnion(lastSeenPhids.subtracting(currentPhids))
      lastSeenPhids = currentPhids
    } else if !lastSeenPhids.isEmpty {
      lastSeenPhids.subtract(deletedPhids)
      lastSeenPhids.formUnion(currentPhids)
    }
    if !deletedPhids.isEmpty {
      await notifyDeleted(
        deviceId: deviceId, libraryId: libraryId,
        serverBaseURL: serverBaseURL, phids: Array(deletedPhids))
    }
    guard !Task.isCancelled else { return }

    // Load local SQLite task records once.
    let local: LocalTaskIndex
    do {
      local = LocalTaskIndex(tasks: try await state.allTasks(), deviceId: deviceId)
    } catch {
      BackupIssueStatus.log(.error, "Backup state read failed: \(error)")
      EngineHost.shared.progress.setWalkPhase(
        .failed("couldn't read local backup records. Details are in the logs."))
      return
    }

    guard !Task.isCancelled else { return }
    let libraryPhotoIDs: Set<String> =
      isFullScan
      ? currentPhids
      : local.allPhids.subtracting(deletedPhids).union(currentPhids)

    let discoveredPending = currentPhids.filter {
      local.stateByPhid[$0] != .uploaded && local.stateByPhid[$0] != .skippedPolicy
    }
    EngineHost.shared.progress.setPendingPhotoIDs(
      local.pendingPhids.subtracting(deletedPhids).union(discoveredPending))
    EngineHost.shared.progress.recordLibrarySnapshot(
      photoIDs: libraryPhotoIDs,
      backedUpIDs: local.backedUpPhids.intersection(libraryPhotoIDs))

    // Server PHID reconciliation using incremental `since` cursor when available.
    EngineHost.shared.progress.setWalkPhase(.checkingServer)
    let sinceCursor =
      (retryFailed || local.allPhids.isEmpty) ? nil : cursor.lastServerReconciledAt
    let (serverKnownPhids, serverHeld, maxServerFirstSeen) = await fetchServerState(
      deviceId: deviceId, libraryId: libraryId,
      serverBaseURL: serverBaseURL, since: sinceCursor)
    guard !Task.isCancelled else { return }

    EngineHost.shared.progress.recordLibrarySnapshot(
      photoIDs: libraryPhotoIDs,
      backedUpIDs: local.backedUpPhids.union(serverKnownPhids).intersection(libraryPhotoIDs))
    EngineHost.shared.progress.removePendingPhotoIDs(serverKnownPhids)

    var newAssets: [DiscoveredAsset] = []
    var reconciledTasks: [BackupTask] = []
    var cancelledPendingIds: [BackupTaskID] = []
    var retryTasks: [BackupTask] = []
    var datesToBackfill: [String: Date] = [:]

    for asset in discoveredAssets {
      guard !Task.isCancelled else { return }
      let phid = asset.phid
      let localState = local.stateByPhid[phid]
      if localState == .uploading { continue }
      let id = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
      if serverKnownPhids.contains(phid) {
        if localState != .uploaded {
          reconciledTasks.append(
            BackupTask(
              id: id, state: .uploaded, priority: .background, capturedAt: asset.capturedAt))
        }
        if localState == .pending { cancelledPendingIds.append(id) }
        continue
      }
      if localState == .pending {
        if let capturedAt = asset.capturedAt, local.nullDatePendingPhids.contains(phid) {
          datesToBackfill[phid] = capturedAt
        }
        continue
      }
      if localState == nil {
        newAssets.append(asset)
      } else if localState == .failedRetry && retryFailed {
        retryTasks.append(
          BackupTask(
            id: id, state: .pending, priority: .background, capturedAt: asset.capturedAt))
      }
    }

    for phid in serverKnownPhids where !currentPhids.contains(phid) {
      let localState = local.stateByPhid[phid]
      guard localState != .uploaded, localState != .uploading else { continue }
      let id = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
      reconciledTasks.append(BackupTask(id: id, state: .uploaded, priority: .background))
      if localState == .pending { cancelledPendingIds.append(id) }
    }

    guard await batchUpsert(reconciledTasks, into: state) else { return }
    if !cancelledPendingIds.isEmpty { await queue.cancel(cancelledPendingIds) }
    if let maxServerFirstSeen {
      try? await state.updateServerReconciledAt(deviceId: deviceId, since: maxServerFirstSeen)
    }
    if !datesToBackfill.isEmpty,
      let backfilled = try? await state.backfillPendingCapturedDates(
        datesToBackfill, deviceId: deviceId),
      !backfilled.isEmpty
    {
      await queue.enqueue(backfilled, priority: nil)
    }
    if !retryTasks.isEmpty {
      guard await batchUpsert(retryTasks, into: state) else { return }
      guard !Task.isCancelled else { return }
      await queue.enqueue(retryTasks, priority: nil)
    }

    let retriedCount = retryTasks.count
    let reconciledUploaded = reconciledTasks.count
    var enqueuedCount = 0
    let discoveredNewest = discoveredAssets.compactMap(\.capturedAt).max()
    let discoveredOldest = discoveredAssets.compactMap(\.capturedAt).min()

    for offset in stride(from: 0, to: newAssets.count, by: 256) {
      guard !Task.isCancelled else { return }
      let end = min(offset + 256, newAssets.count)
      let slice = newAssets[offset..<end]
      let tasks = slice.map { asset in
        BackupTask(
          id: BackupTaskID(deviceId: deviceId, phassetLocalId: asset.phid),
          state: .pending, priority: .background, capturedAt: asset.capturedAt)
      }
      guard await batchUpsert(tasks, into: state) else { return }
      guard !Task.isCancelled else { return }
      await queue.enqueue(tasks, priority: .background)
      enqueuedCount += tasks.count
      try? await state.advanceScanWatermarks(
        deviceId: deviceId,
        newestScannedAt: discoveredNewest,
        oldestScannedAt: slice.compactMap(\.capturedAt).min(),
        oldestScannedPhid: slice.last?.phid,
        libraryEligibleCount: libraryPhotoIDs.count,
        settingsFingerprint: fingerprint,
        initialScanCompleted: cursor.initialScanCompleted)
      EngineHost.shared.progress.setWalkPhase(
        .reconciling(checked: end, total: newAssets.count))
    }

    guard !Task.isCancelled else { return }
    try? await state.advanceScanWatermarks(
      deviceId: deviceId,
      newestScannedAt: discoveredNewest,
      oldestScannedAt: discoveredOldest,
      oldestScannedPhid: discoveredAssets.last?.phid,
      libraryEligibleCount: libraryPhotoIDs.count,
      settingsFingerprint: fingerprint,
      initialScanCompleted: completedInitialScan)
    try? await state.updatePhotoKitChangeToken(deviceId: deviceId, token: newToken)

    log.info(
      "walk done: enqueued=\(enqueuedCount) retried=\(retriedCount) reconciled-uploaded=\(reconciledUploaded) totalEligible=\(libraryPhotoIDs.count)"
    )

    if let engine = EngineHost.shared.engine, !serverHeld.isEmpty {
      await engine.resendNewerEdits(serverHeld)
    }

    guard !Task.isCancelled else { return }
    let failedPermanently = (try? await state.count(in: .failedRetry)) ?? 0
    guard !Task.isCancelled else { return }
    EngineHost.shared.progress.recordWalkSummary(
      BackupProgressViewModel.WalkSummary(
        enumerated: libraryPhotoIDs.count,
        enqueued: enqueuedCount + retriedCount,
        failedPermanently: failedPermanently,
        finishedAt: Date()))
  }

  private struct LocalTaskIndex {
    var stateByPhid: [String: BackupState] = [:]
    var nullDatePendingPhids: Set<String> = []
    var allPhids: Set<String> = []
    var backedUpPhids: Set<String> = []
    var pendingPhids: Set<String> = []

    init(tasks: [BackupTask], deviceId: String) {
      stateByPhid.reserveCapacity(tasks.count)
      for task in tasks where task.id.deviceId == deviceId {
        let phid = task.id.phassetLocalId
        stateByPhid[phid] = task.state
        if task.state != .skippedPolicy { allPhids.insert(phid) }
        if task.state == .uploaded {
          backedUpPhids.insert(phid)
        } else if task.state != .skippedPolicy {
          pendingPhids.insert(phid)
        }
        if task.state == .pending && task.capturedAt == nil {
          nullDatePendingPhids.insert(phid)
        }
      }
    }
  }

  private static func fetchServerState(
    deviceId: String, libraryId: String, serverBaseURL: URL, since: String?
  ) async -> (Set<String>, [ServerHeldAsset], String?) {
    let stateClient = BackupStateClient(
      baseURL: LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL),
      libraryId: libraryId, deviceId: deviceId,
      transport: makeBackupTransport(server: serverBaseURL))
    do {
      let known = try await stateClient.fetchKnownAssets(since: since)
      let phids = Set(known.map(\.phassetLocalId))
      let maxFirstSeen = known.compactMap(\.firstSeen).max()
      let held = known.compactMap { asset in
        asset.relPath.map {
          ServerHeldAsset(
            id: BackupTaskID(deviceId: deviceId, phassetLocalId: asset.phassetLocalId),
            targetRelPath: $0, mapleId: asset.mapleId)
        }
      }
      log.info(
        "walk server-state reconciliation: server returned \(phids.count) phids (since=\(since ?? "nil", privacy: .public))"
      )
      return (phids, held, maxFirstSeen)
    } catch {
      if !Task.isCancelled {
        BackupIssueStatus.log(
          .warning, "Backup server check unavailable; using local records: \(error)")
      }
      return ([], [], nil)
    }
  }

  private static func batchUpsert(
    _ tasks: [BackupTask], into state: BackupStateStore
  ) async -> Bool {
    for offset in stride(from: 0, to: tasks.count, by: 256) {
      guard !Task.isCancelled else { return false }
      do {
        try await state.upsert(Array(tasks[offset..<min(offset + 256, tasks.count)]))
      } catch {
        BackupIssueStatus.log(.error, "Backup state write failed: \(error)")
        EngineHost.shared.progress.setWalkPhase(
          .failed("couldn't save local backup records. Details are in the logs."))
        return false
      }
    }
    return true
  }
}
