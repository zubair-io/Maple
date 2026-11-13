// src/apple/Maple/Backup/ChangeObserverWiring.swift
//
// Wire PhotoKitChangeObserver → EngineHost.queue for incremental backup.
//
// On every library-change event (new capture, edit, delete in Apple Photos),
// discover eligible assets (`BackupCursor.discovery` picks a change replay or a
// full listing) and enqueue any localIdentifier the state store hasn't seen
// yet. The change observer fires on a private PhotoKit thread; we hop to
// MainActor before touching EngineHost state.
//
// Concurrency: the enum is MainActor-isolated so callers on the UI can
// invoke start/stop without ceremony. The actual PhotoKit walk (fetch +
// enumerate) is heavy — for a 100k-photo library it can take several
// seconds — so the walk runs on a detached Task at userInitiated priority
// and only the result is brought back to MainActor. Without that hop, a
// settings-screen tap freezes the UI until enumeration finishes, which
// looks indistinguishable from a broken button.
//
// What a walk forgets, settles, retries and enqueues is decided by
// `BackupWalkPlanner` (MapleBackup, tested); this file applies the plan.

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
  private static var fullScanRequested = false
  private static var generation = UUID()
  private static var configuration: BackupSettings?

  /// The phasset localIdentifiers in the library as of the most recent walk.
  /// A full scan reports as deleted any id here that its listing lacks; a
  /// change replay uses PhotoKit's own deletions and folds them in. Starts
  /// empty — a full scan reports no deletions until a walk has filled it.
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
    fullScanRequested = false
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
  /// weekly timer and the iOS BGProcessingTask handler). Always a full scan
  /// reconciled against everything the server holds, so it repairs anything
  /// the change-token shortcut missed. It does not reset failed-retry tasks
  /// (that's reserved for an explicit user Restart).
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
      retryFailed: false, fullScan: true)
  }

  /// Coalesce PhotoKit notifications while one walk is active. A full-scan
  /// request that arrives mid-walk is carried into the walk that follows.
  private static func scheduleWalk(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL,
    retryFailed: Bool, fullScan: Bool = false
  ) async {
    // `configuration` is cleared by stop(): a periodic or background walk
    // racing a stop must not start once the wiring is down.
    guard !Task.isCancelled, !BackupSettings.isStoppedByUser, configuration != nil,
      EngineHost.shared.progress.phase == .running
    else {
      return
    }
    if fullScan { fullScanRequested = true }
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
        let fullScan = fullScanRequested
        fullScanRequested = false
        await enqueueAllNew(
          deviceId: deviceId, settings: settings,
          libraryId: libraryId, serverBaseURL: serverBaseURL,
          retryFailed: retryFailures, forceFullScan: fullScan)
        retryFailures = false
      } while walkAgain && !Task.isCancelled
    }
    walkTask = task
    await task.value
  }

  /// Find eligible PHAssets and enqueue any we don't yet have in BackupStateStore.
  /// Discovery runs on a detached Task so the main thread never freezes on a
  /// large library; it replays PhotoKit's changes since the last walk once a
  /// full scan has finished for the current settings, and lists the whole
  /// library otherwise. The full-scan cursor is written only after every
  /// discovered asset is recorded, so an interrupted scan starts over.
  private static func enqueueAllNew(
    deviceId: String, settings: BackupSettings,
    libraryId: String, serverBaseURL: URL,
    retryFailed: Bool, forceFullScan: Bool
  ) async {
    log.info(
      "walk begin libraryId=\(libraryId, privacy: .public) retryFailed=\(retryFailed) forceFullScan=\(forceFullScan)"
    )
    guard let state = EngineHost.shared.state else {
      BackupIssueStatus.log(.error, "Backup scan stopped: engine state is unavailable")
      EngineHost.shared.progress.setWalkPhase(.failed("the backup engine never finished starting"))
      return
    }
    let queue = EngineHost.shared.queue
    let progress = EngineHost.shared.progress
    guard !Task.isCancelled else { return }

    let cursor =
      (try? await state.cursor(deviceId: deviceId)) ?? BackupCursor(deviceId: deviceId)
    let fullLibraryAccess = PhotoKitLibrary.authorizationStatus() == .authorized
    let fingerprint = settingsFingerprint(settings, fullLibraryAccess: fullLibraryAccess)
    // A replay counts the library as this session last saw it. A launch has no
    // such baseline, and the local rows alone cannot say which photos the
    // listing leaves out (a setting, a hidden photo, limited access), so the
    // first walk of a session lists the library.
    let discovery = cursor.discovery(
      settingsFingerprint: fingerprint, retryFailed: retryFailed, forceFullScan: forceFullScan,
      hasEligibleBaseline: !lastSeenPhids.isEmpty)
    let hasWalked = progress.lastWalkSummary != nil
    if discovery == .fullScan || !hasWalked {
      progress.setWalkPhase(.enumerating)
    }

    let walkStarted = Date()
    let enumeration = Task.detached(priority: .userInitiated) {
      discoverAssets(discovery, settings: settings)
    }
    // A detached task does not inherit cancellation: forward Stop to it, so
    // draining the walk never waits out the rest of a large scan.
    let outcome = await withTaskCancellationHandler {
      await enumeration.value
    } onCancel: {
      enumeration.cancel()
    }
    guard !Task.isCancelled else { return }

    let isFullScan = outcome.isFullScan
    let hasUndeliveredEdits =
      if isFullScan {
        false
      } else {
        await EngineHost.shared.engine?.hasUndeliveredEdits(deviceId: deviceId) ?? false
      }
    if !isFullScan, outcome.assets.isEmpty, outcome.deletedPhids.isEmpty, hasWalked,
      !hasUndeliveredEdits
    {
      try? await state.updatePhotoKitChangeToken(deviceId: deviceId, token: outcome.newToken)
      progress.setWalkPhase(.idle)
      return
    }
    log.info(
      "walk discovered \(outcome.assets.count) assets (fullScan=\(isFullScan)) in \(Int(Date().timeIntervalSince(walkStarted) * 1000))ms"
    )

    let local: LocalTaskIndex
    do {
      local = LocalTaskIndex(tasks: try await state.allTasks(), deviceId: deviceId)
    } catch {
      BackupIssueStatus.log(.error, "Backup state read failed: \(error)")
      progress.setWalkPhase(
        .failed("couldn't read local backup records. Details are in the logs."))
      return
    }
    guard !Task.isCancelled else { return }
    let owingCompanions = (try? await state.phidsOwingCompanions(deviceId: deviceId)) ?? []

    // A row is forgotten only for a photo PhotoKit no longer returns: one a
    // setting merely excludes keeps its record of what the server holds.
    let fullAccessNow = fullLibraryAccess && PhotoKitLibrary.authorizationStatus() == .authorized
    let stillInPhotoKit = await identifiersStillInPhotoKit(
      among: BackupWalkPlanner.unlisted(
        local: local, outcome: outcome, fullLibraryAccess: fullAccessNow))
    guard !Task.isCancelled else { return }
    guard
      let library = BackupWalkPlanner.planLibrary(
        local: local, outcome: outcome, previouslySeen: lastSeenPhids,
        stillInPhotoKit: stillInPhotoKit, owingCompanions: owingCompanions,
        fullLibraryAccess: fullAccessNow)
    else {
      log.error(
        "walk skipped: PhotoKit listed no photos while \(local.stateByPhid.count) local records exist; nothing forgotten, scan not recorded"
      )
      progress.setWalkPhase(.idle)
      return
    }

    // Delete reconciliation: photos PhotoKit confirms gone, told to the server.
    if !library.deleted.isEmpty {
      await notifyDeleted(
        deviceId: deviceId, libraryId: libraryId,
        serverBaseURL: serverBaseURL, phids: Array(library.deleted))
    }
    guard !Task.isCancelled else { return }
    let currentPhids = Set(outcome.assets.map(\.phid))
    if isFullScan {
      lastSeenPhids = currentPhids
    } else if !lastSeenPhids.isEmpty {
      lastSeenPhids = lastSeenPhids.subtracting(library.deleted).union(currentPhids)
    }

    if !library.forget.isEmpty {
      let removedPending =
        (try? await state.removeDeleted(
          library.forget.map { BackupTaskID(deviceId: deviceId, phassetLocalId: $0) })) ?? []
      await queue.cancel(removedPending)
    }
    if !library.dropExcluded.isEmpty {
      let removedPending =
        (try? await state.removeExcluded(
          library.dropExcluded.map { BackupTaskID(deviceId: deviceId, phassetLocalId: $0) })) ?? []
      await queue.cancel(removedPending)
    }
    if !library.suspend.isEmpty {
      let suspended =
        (try? await state.suspendExcluded(
          library.suspend.map { BackupTaskID(deviceId: deviceId, phassetLocalId: $0) })) ?? []
      await queue.cancel(suspended)
    }
    guard !Task.isCancelled else { return }
    progress.setPendingPhotoIDs(library.pendingPhotoIDs)
    progress.recordLibrarySnapshot(
      photoIDs: library.libraryPhotoIDs, backedUpIDs: library.backedUpPhotoIDs)

    // Server PHID reconciliation: only what the server recorded since the
    // last walk, unless this walk needs the full set.
    progress.setWalkPhase(.checkingServer)
    let server = await fetchServerState(
      deviceId: deviceId, libraryId: libraryId, serverBaseURL: serverBaseURL,
      since: cursor.serverSince(fullScan: isFullScan, hasUndeliveredEdits: hasUndeliveredEdits))
    guard !Task.isCancelled else { return }

    // A server-held original whose companions are still owed is not backed up.
    // Read after the server answers: a worker may have marked a photo owing
    // while the request was in flight.
    let owingNow = (try? await state.phidsOwingCompanions(deviceId: deviceId)) ?? []
    let reconcile = BackupWalkPlanner.planReconcile(
      local: local, library: library, outcome: outcome, deviceId: deviceId,
      serverKnownPhids: server.knownPhids, owingCompanions: owingNow,
      retryFailed: retryFailed)
    progress.recordLibrarySnapshot(
      photoIDs: library.libraryPhotoIDs, backedUpIDs: reconcile.backedUpPhotoIDs)
    progress.removePendingPhotoIDs(reconcile.serverBackedUpPhotoIDs)

    guard
      await writeInBatches(
        reconcile.settle,
        { batch, _ in
          let settled = try await state.markServerHeld(batch)
          await queue.cancel(settled)
        })
    else { return }
    if let maxServerFirstSeen = server.maxFirstSeen {
      try? await state.updateServerReconciledAt(deviceId: deviceId, since: maxServerFirstSeen)
    }

    // Photos recorded as uploaded may still lack a companion an earlier
    // version dropped; only a full scan sees the server's whole listing.
    let repair: Set<String>? =
      isFullScan
      ? await repairMissingCompanions(
        outcome.assets, deviceId: deviceId, settings: settings,
        serverCompanions: server.companions, state: state, queue: queue) : []
    guard let repaired = repair else { return }
    if !repaired.isEmpty {
      progress.recordLibrarySnapshot(
        photoIDs: library.libraryPhotoIDs,
        backedUpIDs: reconcile.backedUpPhotoIDs.subtracting(repaired))
    }

    if !reconcile.datesToBackfill.isEmpty,
      let backfilled = try? await state.backfillPendingCapturedDates(
        reconcile.datesToBackfill, deviceId: deviceId),
      !backfilled.isEmpty
    {
      await queue.enqueue(backfilled, priority: nil)
    }

    // Server-held failures were settled above unless they still owe companions;
    // the store re-queues only rows still failed.
    var retriedCount = 0
    guard
      await writeInBatches(
        reconcile.retry,
        { batch, _ in
          let requeued = try await state.requeueFailed(batch)
          retriedCount += requeued.count
          await queue.enqueue(requeued, priority: nil)
        })
    else { return }

    guard
      await writeInBatches(
        reconcile.resume,
        { batch, _ in
          let resumed = try await state.resumeExcluded(batch)
          await queue.enqueue(resumed, priority: nil)
        })
    else { return }

    guard
      await writeInBatches(
        reconcile.enqueue,
        { batch, written in
          let created = try await state.insertMissing(batch)
          await queue.enqueue(created, priority: .background)
          progress.setWalkPhase(.reconciling(checked: written, total: reconcile.enqueue.count))
        })
    else { return }

    guard !Task.isCancelled else { return }
    if isFullScan {
      try? await state.recordCompletedFullScan(
        deviceId: deviceId, settingsFingerprint: fingerprint, phChangeToken: outcome.newToken)
    } else {
      try? await state.updatePhotoKitChangeToken(deviceId: deviceId, token: outcome.newToken)
    }

    log.info(
      "walk done: enqueued=\(reconcile.enqueue.count) retried=\(retriedCount) companion-repairs=\(repaired.count) reconciled-uploaded=\(reconcile.settle.count) totalEligible=\(library.libraryPhotoIDs.count)"
    )

    // Photos the server already holds can still carry a newer local edit than
    // the one they were uploaded with; send those on top (#4719).
    if let engine = EngineHost.shared.engine, !server.held.isEmpty {
      await engine.resendNewerEdits(server.held)
    }

    guard !Task.isCancelled else { return }
    // Publish the outcome so the status panel can tell "fully backed up"
    // apart from "never started" — both leave the queue empty (#3097).
    let failedPermanently = (try? await state.count(in: .failedRetry)) ?? 0
    guard !Task.isCancelled else { return }
    progress.recordWalkSummary(
      BackupProgressViewModel.WalkSummary(
        enumerated: library.libraryPhotoIDs.count,
        enqueued: reconcile.enqueue.count + retriedCount + repaired.count,
        failedPermanently: failedPermanently,
        finishedAt: Date()))
  }

  /// What the server's backup listing says about this device's photos.
  private struct ServerState {
    let knownPhids: Set<String>
    let held: [ServerHeldAsset]
    let maxFirstSeen: String?
    /// The companions held beside each original, for photos the server
    /// reports them for.
    let companions: [String: BackupCompanions]

    static let unavailable = ServerState(
      knownPhids: [], held: [], maxFirstSeen: nil, companions: [:])
  }

  private static func fetchServerState(
    deviceId: String, libraryId: String, serverBaseURL: URL, since: String?
  ) async -> ServerState {
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
      let companions = Dictionary(
        known.compactMap { asset in asset.companions.map { (asset.phassetLocalId, $0) } },
        uniquingKeysWith: { first, second in first.union(second) })
      log.info(
        "walk server-state reconciliation: server returned \(phids.count) phids (since=\(since ?? "nil", privacy: .public))"
      )
      return ServerState(
        knownPhids: phids, held: held, maxFirstSeen: maxFirstSeen, companions: companions)
    } catch {
      if !Task.isCancelled {
        BackupIssueStatus.log(
          .warning, "Backup server check unavailable; using local records: \(error)")
      }
      return .unavailable
    }
  }

  /// Runs `write` over `tasks` 256 at a time, passing how many have been
  /// written once the batch lands. A failed write fails the walk.
  private static func writeInBatches(
    _ tasks: [BackupTask], _ write: ([BackupTask], Int) async throws -> Void
  ) async -> Bool {
    for offset in stride(from: 0, to: tasks.count, by: 256) {
      guard !Task.isCancelled else { return false }
      let end = min(offset + 256, tasks.count)
      do {
        try await write(Array(tasks[offset..<end]), end)
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
