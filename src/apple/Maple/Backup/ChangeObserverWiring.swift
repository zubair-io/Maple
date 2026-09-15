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
    guard !Task.isCancelled, !BackupSettings.isStoppedByUser,
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
    // Phase is published to the status panel (#3386) so the minutes-long
    // scan on a large library reads as progress, not a wedged engine.
    EngineHost.shared.progress.setWalkPhase(.enumerating)
    guard let state = EngineHost.shared.state else {
      log.error("walk bail: EngineHost.shared.state is nil — backup engine never finished starting")
      EngineHost.shared.progress.setWalkPhase(.failed("the backup engine never finished starting"))
      return
    }
    let queue = EngineHost.shared.queue
    guard !Task.isCancelled else { return }

    // PhotoKit enumeration off main. PhotoKitCatalog is NSLock-protected
    // and Sendable so the detached Task can hammer it without crossing
    // an actor boundary. Doing this on @MainActor would freeze the UI
    // for several seconds on a 100k-photo library — the original symptom
    // that made the Start Backup button look dead.
    let walkStarted = Date()
    let ids: [String] = await Task.detached(priority: .userInitiated) {
      walkPhotoKit(settings: settings)
    }.value
    log.info(
      "walk enumerated \(ids.count) eligible assets in \(Int(Date().timeIntervalSince(walkStarted) * 1000))ms"
    )

    guard !Task.isCancelled else { return }

    // Delete reconciliation: diff the current walk against the previous one.
    // Any phid in lastSeenPhids but not in the current set was deleted
    // in Apple Photos since our last walk. The first walk after launch
    // starts with an empty lastSeenPhids, so nothing is flagged as deleted.
    let currentPhids = Set(ids)
    let deletedPhids = lastSeenPhids.subtracting(currentPhids)
    if !deletedPhids.isEmpty {
      await notifyDeleted(
        deviceId: deviceId, libraryId: libraryId,
        serverBaseURL: serverBaseURL, phids: Array(deletedPhids))
    }
    guard !Task.isCancelled else { return }
    lastSeenPhids = currentPhids

    // One round-trip instead of one per phid. Build a map of known task IDs →
    // state and diff in-memory so a 100k library doesn't make 100k SQLite
    // calls.
    let stateByPhid: [String: BackupState]
    do {
      let allTasks = try await state.allTasks()
      stateByPhid = Dictionary(
        allTasks.map { ($0.id.phassetLocalId, $0.state) },
        uniquingKeysWith: { _, latest in latest })
    } catch {
      log.error("walk bail: allTasks() failed: \(String(describing: error), privacy: .public)")
      EngineHost.shared.progress.setWalkPhase(
        .failed("couldn't read the local backup state (\(error.localizedDescription))"))
      return
    }

    guard !Task.isCancelled else { return }
    EngineHost.shared.progress.setPendingPhotoIDs(
      Set(
        ids.filter {
          stateByPhid[$0] != .uploaded && stateByPhid[$0] != .skippedPolicy
        }))

    // Server PHID reconciliation (step a — cheap, no hashing). Ask the
    // server which phids it already has recorded for THIS device, and treat
    // that as the authoritative "already backed up" set. This is what stops
    // a cleared/reinstalled local SQLite from re-uploading every photo on
    // restart: the server already knows about them. Best-effort — a network
    // failure falls back to local-state-only reconciliation.
    EngineHost.shared.progress.setWalkPhase(.checkingServer)
    var serverKnownPhids: Set<String> = []
    let stateClient = BackupStateClient(
      baseURL: LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL),
      libraryId: libraryId, deviceId: deviceId,
      transport: makeBackupTransport(server: serverBaseURL))
    do {
      let known = try await stateClient.fetchKnownAssets()
      serverKnownPhids = Set(known.map(\.phassetLocalId))
      log.info(
        "walk server-state reconciliation: server knows \(serverKnownPhids.count) phids for this device"
      )
    } catch {
      log.error(
        "walk server-state reconciliation skipped (network): \(String(describing: error), privacy: .public)"
      )
    }

    guard !Task.isCancelled else { return }

    EngineHost.shared.progress.removePendingPhotoIDs(serverKnownPhids)

    var newPhids: [String] = []
    var reconciledTasks: [BackupTask] = []
    var retryTasks: [BackupTask] = []
    for phid in ids {
      guard !Task.isCancelled else { return }
      let localState = stateByPhid[phid]
      // A live worker owns these rows; a scan must not overwrite them.
      if localState == .pending || localState == .uploading { continue }
      let id = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
      if serverKnownPhids.contains(phid) {
        if localState != .uploaded {
          reconciledTasks.append(BackupTask(id: id, state: .uploaded, priority: .background))
        }
      } else if localState == nil {
        newPhids.append(phid)
      } else if localState == .failedRetry && retryFailed {
        retryTasks.append(
          BackupTask(
            id: id, state: .pending, priority: .background,
            capturedAt: PhotoKitCatalog.shared.asset(localId: phid)?.creationDate))
      }
    }
    // Batch writes amortize SQLite commits across large server-known sets.
    for offset in stride(from: 0, to: reconciledTasks.count, by: 256) {
      guard !Task.isCancelled else { return }
      do {
        try await state.upsert(
          Array(reconciledTasks[offset..<min(offset + 256, reconciledTasks.count)]))
      } catch {
        EngineHost.shared.progress.setWalkPhase(.failed(error.localizedDescription))
        return
      }
    }
    do {
      try await state.upsert(retryTasks)
      for task in retryTasks {
        guard !Task.isCancelled else { return }
        await queue.enqueue(task, priority: task.priority)
      }
    } catch {
      EngineHost.shared.progress.setWalkPhase(.failed(error.localizedDescription))
      return
    }
    let retriedCount = retryTasks.count
    let reconciledUploaded = reconciledTasks.count
    var enqueuedCount = 0

    // Content dedup happens in the resumable upload protocol after each
    // worker reads its photo once. Never download the entire iCloud library
    // serially as a prerequisite to starting the first upload (#3638).
    let phidsToEnqueue = newPhids

    for offset in stride(from: 0, to: phidsToEnqueue.count, by: 256) {
      guard !Task.isCancelled else { return }
      let end = min(offset + 256, phidsToEnqueue.count)
      let tasks = phidsToEnqueue[offset..<end].map { phid in
        BackupTask(
          id: BackupTaskID(deviceId: deviceId, phassetLocalId: phid),
          state: .pending, priority: .background,
          capturedAt: PhotoKitCatalog.shared.asset(localId: phid)?.creationDate)
      }
      do {
        try await state.upsert(tasks)
        guard !Task.isCancelled else { return }
        for task in tasks { await queue.enqueue(task, priority: task.priority) }
        enqueuedCount += tasks.count
        EngineHost.shared.progress.setWalkPhase(
          .reconciling(checked: end, total: phidsToEnqueue.count))
      } catch {
        EngineHost.shared.progress.setWalkPhase(.failed(error.localizedDescription))
        return
      }
    }
    log.info(
      "walk done: enqueued=\(enqueuedCount) retried=\(retriedCount) reconciled-uploaded=\(reconciledUploaded) skipped=\(ids.count - enqueuedCount - retriedCount)"
    )

    guard !Task.isCancelled else { return }
    // Publish the outcome so the status panel can tell "fully backed up"
    // apart from "never started" — both leave the queue empty (#3097).
    // The `.failedRetry` count is the terminal-failure figure the panel
    // captions; best-effort, a read failure just reports 0.
    let failedPermanently = (try? await state.count(in: .failedRetry)) ?? 0
    guard !Task.isCancelled else { return }
    EngineHost.shared.progress.recordWalkSummary(
      BackupProgressViewModel.WalkSummary(
        enumerated: ids.count,
        enqueued: enqueuedCount + retriedCount,
        failedPermanently: failedPermanently,
        finishedAt: Date()))
  }

  // MARK: - Off-main PhotoKit walk
  //
  // The functions below are `nonisolated` so they can run from a
  // detached Task on a background executor. They touch only
  // PhotoKitCatalog (NSLock-protected + `@unchecked Sendable`) and the
  // value-type BackupSettings; no shared MainActor state.

  /// PhotoKit enumeration extracted from `enqueueAllNew`. Returns the
  /// set of eligible PHAsset localIdentifiers given the current settings.
  /// Pure function — safe to call from any thread. Reads everything
  /// through PhotoKitCatalog so the (potentially expensive) PHAsset
  /// fetches are cached across walks within the same change cycle.
  nonisolated private static func walkPhotoKit(settings: BackupSettings) -> [String] {
    let sharedAlbumIDs: Set<String> =
      settings.includeSharedAlbums
      ? []
      : PhotoKitCatalog.shared.sharedAlbumIdentifiers()

    // We're already off main, so the chunked async iteration that the
    // catalog exposes for its main-actor callers isn't needed here —
    // a plain loop over the cached id list keeps the code simple and
    // the locking overhead minimal.
    var ids: [String] = []
    let imageIDs = PhotoKitCatalog.shared.imageIdentifiers()
    ids.reserveCapacity(imageIDs.count)
    for phid in imageIDs {
      guard let asset = PhotoKitCatalog.shared.asset(localId: phid),
        shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
      else { continue }
      ids.append(phid)
    }

    if settings.includeVideos {
      let videoIDs = PhotoKitCatalog.shared.videoIdentifiers()
      ids.reserveCapacity(ids.count + videoIDs.count)
      for phid in videoIDs {
        guard let asset = PhotoKitCatalog.shared.asset(localId: phid),
          shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
        else { continue }
        ids.append(phid)
      }
    }
    return ids
  }

  /// Notify the server that the given phasset localIdentifiers were deleted
  /// from Apple Photos. The server sets `deleted_from_photos: true` on the
  /// matching AssetDoc entries. Best-effort: network failures are silently
  /// swallowed — the next walk will retry the diff.
  private static func notifyDeleted(
    deviceId: String, libraryId: String,
    serverBaseURL: URL, phids: [String]
  ) async {
    let url = LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL)
      .appendingPathComponent("api")
      .appendingPathComponent("libraries")
      .appendingPathComponent(libraryId)
      .appendingPathComponent("backup")
      .appendingPathComponent("notify-deleted")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
    let body = ["phasset_local_ids": phids]
    req.httpBody = try? JSONEncoder().encode(body)
    // Authenticated like the other backup calls — notify-deleted is gated too (#855).
    let transport = makeBackupTransport(server: serverBaseURL)
    _ = try? await transport(req)
  }

  /// Returns true when the asset should be included in the backup based on
  /// the current `settings`. Nonisolated so the off-main `walkPhotoKit`
  /// can call it inside `enumerateObjects`.
  ///
  /// - Parameter sharedAlbumIDs: Pre-built set of PHAsset localIdentifiers
  ///   that belong to at least one shared album. Pass an empty set when
  ///   `settings.includeSharedAlbums` is true (no filtering needed).
  nonisolated private static func shouldInclude(
    _ asset: PHAsset, settings: BackupSettings,
    sharedAlbumIDs: Set<String> = []
  ) -> Bool {
    // Bursts: only the representative frame unless includeBursts is true.
    // `representsBurst` is the key frame chosen by iOS; non-representative
    // burst frames have a non-nil burstIdentifier but representsBurst == false.
    if !settings.includeBursts,
      asset.burstIdentifier != nil,
      !asset.representsBurst
    {
      return false
    }

    // iCloud Shared Library (iOS 16.1+): PHAsset.sourceType == .typeCloudShared
    // identifies assets the user has been added to via iCloud Shared Library
    // (the newer "shared with family/friends" feature, not shared albums).
    if !settings.includeSharedLibrary,
      asset.sourceType == .typeCloudShared
    {
      return false
    }

    // Shared Albums (the older invite-based albums with .albumCloudShared
    // subtype): check membership in the pre-built set so each per-asset
    // check is O(1).
    if !settings.includeSharedAlbums,
      sharedAlbumIDs.contains(asset.localIdentifier)
    {
      return false
    }

    return true
  }

  // Note: the local `sharedAlbumPHIDs()` helper was retired when
  // `PhotoKitCatalog.shared.sharedAlbumIdentifiers()` shipped on main —
  // the catalog gives us a process-wide cached answer that invalidates
  // through the same change-observer fan-out, so every consumer agrees.
}
