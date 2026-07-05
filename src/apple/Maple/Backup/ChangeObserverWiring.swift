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
import Photos
import OSLog
import MapleBackup
import MapleCore

private let log = Logger(subsystem: "app.justmaple.aperture", category: "Backup.ChangeObserver")

@MainActor
enum ChangeObserverWiring {

    /// Holds the subscription token between start() and stop(). Re-entering
    /// start() while already started replaces the token (cancels the old sub
    /// before adding a new one).
    private static var token: UUID?

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
    static func start(deviceId: String, settings: BackupSettings,
                      libraryId: String, serverBaseURL: URL,
                      retryFailed: Bool = false) {
        log.info("start subscribe deviceId=\(deviceId, privacy: .public) libraryId=\(libraryId, privacy: .public) server=\(serverBaseURL.absoluteString, privacy: .public) retryFailed=\(retryFailed)")
        // Reset cross-walk delete-diff state so a library change doesn't mark
        // assets in the new library as deleted (they weren't in the old set).
        lastSeenPhids = []

        if let prior = token {
            PhotoKitChangeObserver.shared.unsubscribe(prior)
        }
        token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
            Task { @MainActor in
                // Incremental change events are always new-only — a fresh
                // capture must not reset the whole backlog's retry counters.
                await enqueueAllNew(deviceId: deviceId, settings: settings,
                                    libraryId: libraryId, serverBaseURL: serverBaseURL,
                                    retryFailed: false)
            }
        }
        // Kick off an initial walk so we don't wait for a change event to seed
        // the queue on first launch. This is the one walk that honours the
        // caller's `retryFailed` (so a user Restart retries the failures).
        Task { await enqueueAllNew(deviceId: deviceId, settings: settings,
                                   libraryId: libraryId, serverBaseURL: serverBaseURL,
                                   retryFailed: retryFailed) }
    }

    /// Unsubscribe from library changes. Idempotent.
    static func stop() {
        if let t = token {
            PhotoKitChangeObserver.shared.unsubscribe(t)
            token = nil
        }
    }

    /// Public entry point for the periodic safety walk (called by EngineHost's
    /// weekly timer and the iOS BGProcessingTask handler). Always new-only —
    /// the periodic walk picks up new captures, it does not reset failed-retry
    /// tasks (that's reserved for an explicit user Restart).
    static func runWalk(deviceId: String, settings: BackupSettings,
                        libraryId: String, serverBaseURL: URL) async {
        await enqueueAllNew(deviceId: deviceId, settings: settings,
                            libraryId: libraryId, serverBaseURL: serverBaseURL,
                            retryFailed: false)
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
    private static func enqueueAllNew(deviceId: String, settings: BackupSettings,
                                       libraryId: String, serverBaseURL: URL,
                                       retryFailed: Bool) async {
        log.info("walk begin libraryId=\(libraryId, privacy: .public) retryFailed=\(retryFailed)")
        guard let state = EngineHost.shared.state else {
            log.error("walk bail: EngineHost.shared.state is nil — backup engine never finished starting")
            return
        }
        let queue = EngineHost.shared.queue

        // PhotoKit enumeration off main. PhotoKitCatalog is NSLock-protected
        // and Sendable so the detached Task can hammer it without crossing
        // an actor boundary. Doing this on @MainActor would freeze the UI
        // for several seconds on a 100k-photo library — the original symptom
        // that made the Start Backup button look dead.
        let walkStarted = Date()
        let ids: [String] = await Task.detached(priority: .userInitiated) {
            walkPhotoKit(settings: settings)
        }.value
        log.info("walk enumerated \(ids.count) eligible assets in \(Int(Date().timeIntervalSince(walkStarted) * 1000))ms")

        // Delete reconciliation: diff the current walk against the previous one.
        // Any phid in lastSeenPhids but not in the current set was deleted
        // in Apple Photos since our last walk. The first walk after launch
        // starts with an empty lastSeenPhids, so nothing is flagged as deleted.
        let currentPhids = Set(ids)
        let deletedPhids = lastSeenPhids.subtracting(currentPhids)
        if !deletedPhids.isEmpty {
            await notifyDeleted(deviceId: deviceId, libraryId: libraryId,
                                serverBaseURL: serverBaseURL, phids: Array(deletedPhids))
        }
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
            return
        }

        // Server PHID reconciliation (step a — cheap, no hashing). Ask the
        // server which phids it already has recorded for THIS device, and treat
        // that as the authoritative "already backed up" set. This is what stops
        // a cleared/reinstalled local SQLite from re-uploading every photo on
        // restart: the server already knows about them. Best-effort — a network
        // failure falls back to local-state-only reconciliation.
        var serverKnownPhids: Set<String> = []
        let stateClient = BackupStateClient(
            baseURL: LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL),
            libraryId: libraryId, deviceId: deviceId,
            transport: makeBackupTransport(server: serverBaseURL))
        do {
            let known = try await stateClient.fetchKnownAssets()
            serverKnownPhids = Set(known.map(\.phassetLocalId))
            log.info("walk server-state reconciliation: server knows \(serverKnownPhids.count) phids for this device")
        } catch {
            log.error("walk server-state reconciliation skipped (network): \(String(describing: error), privacy: .public)")
        }

        // Pass 1: classify each enumerated phid into one of:
        //  - newPhids: never persisted locally, not server-known → candidates.
        //  - retry phids: locally .failedRetry and retryFailed == true → reset+enqueue.
        //  - everything else (pending/uploading/uploaded/skipped, or server-known)
        //    is skipped here.
        var newPhids: [String] = []
        var retriedCount = 0
        var reconciledUploaded = 0
        var enqueuedCount = 0
        var enqueueFailures = 0

        for phid in ids {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            let localState = stateByPhid[phid]

            // Server says it already has this phid for this device → keep/mark
            // it `.uploaded` locally and skip. Never re-enqueue server-known phids.
            if serverKnownPhids.contains(phid) {
                // Don't stomp in-flight work: a `.uploading` task is mid-upload
                // and will transition to `.uploaded` on its own. Overwriting it
                // here would race the engine's completion handler.
                if localState == .uploading { continue }
                if localState != .uploaded {
                    do {
                        let task = BackupTask(id: taskId, state: .uploaded, priority: .background)
                        try await state.upsert(task)
                        reconciledUploaded += 1
                        // If it was already queued (e.g. rehydrated `.pending` by
                        // EngineHost.start, or enqueued by a prior walk), cancel
                        // it. BackupEngine doesn't consult state before uploading,
                        // so without this the task would still be dequeued and
                        // re-uploaded despite reconciliation marking it done.
                        if localState == .pending {
                            await queue.cancel(taskId)
                        }
                    } catch {
                        enqueueFailures += 1
                        if enqueueFailures <= 3 {
                            log.error("reconcile-upsert failed phid=\(phid, privacy: .public): \(String(describing: error), privacy: .public)")
                        }
                    }
                }
                continue
            }

            switch localState {
            case .none:
                // Never seen locally and not server-known → candidate.
                newPhids.append(phid)
            case .some(.failedRetry):
                guard retryFailed else { continue }
                // Reset the failed task to .pending: clear retry count + last
                // error so the engine's maxRetries ceiling starts fresh, then
                // enqueue it. (The user explicitly chose "Retry failed + new".)
                do {
                    try await state.transition(taskId, to: .pending, error: nil, retryCount: 0)
                    if let reset = try await state.find(taskId) {
                        await queue.enqueue(reset, priority: reset.priority)
                        retriedCount += 1
                    }
                } catch {
                    enqueueFailures += 1
                    if enqueueFailures <= 3 {
                        log.error("retry-reset failed phid=\(phid, privacy: .public): \(String(describing: error), privacy: .public)")
                    }
                }
            case .some(.pending), .some(.uploading):
                // Already queued (or rehydrated by EngineHost.start) — leave as-is.
                continue
            case .some(.uploaded), .some(.observed),
                 .some(.skippedPolicy), .some(.localEditPending):
                // Done / not-a-backup-candidate — skip.
                continue
            }
        }

        // Step b — MAPLE_ID content reconciliation for the surviving candidates.
        // For phids the server didn't already know by id, derive their maple_id
        // and ask the server which are genuinely missing. Only enqueue the
        // missing ones; mark present ones `.uploaded` locally so a future walk
        // doesn't reconsider them. On a typical same-device restart, step (a)
        // already covered most photos, so `newPhids` here is small.
        let phidsToEnqueue: [String]
        if newPhids.isEmpty || Task.isCancelled {
            phidsToEnqueue = newPhids
        } else {
            phidsToEnqueue = await reconcileByMapleId(
                candidatePhids: newPhids,
                deviceId: deviceId, libraryId: libraryId, serverBaseURL: serverBaseURL,
                state: state, markUploaded: { reconciledUploaded += 1 })
        }

        for phid in phidsToEnqueue {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            do {
                let task = BackupTask(id: taskId, state: .pending, priority: .background)
                try await state.upsert(task)
                await queue.enqueue(task, priority: .background)
                enqueuedCount += 1
            } catch {
                // Persist failures are rare; skip and try again next walk.
                enqueueFailures += 1
                if enqueueFailures <= 3 {
                    // First few failures are useful diagnostics; after that
                    // a stream of identical errors just floods Console.
                    log.error("enqueue failed phid=\(phid, privacy: .public): \(String(describing: error), privacy: .public)")
                }
            }
        }
        log.info("walk done: enqueued=\(enqueuedCount) retried=\(retriedCount) reconciled-uploaded=\(reconciledUploaded) skipped=\(ids.count - enqueuedCount - retriedCount) failures=\(enqueueFailures)")
    }

    /// Step (b) of reconciliation: content-level dedup by maple_id.
    ///
    /// Given candidate phids that survived PHID reconciliation, derive each
    /// one's `maple_id` (off the main thread, in batches, cancellable) and ask
    /// the server which are NOT yet present in the library. Returns the subset
    /// of phids that should actually be enqueued; phids whose content the server
    /// already has are marked `.uploaded` locally (via `markUploaded`) so a
    /// later walk skips them.
    ///
    /// Best-effort: if maple_id derivation fails for a phid, that phid is
    /// treated as a candidate to enqueue (the upload path dedups server-side as
    /// a backstop). If the network call fails for a whole batch, every phid in
    /// that batch falls through to enqueue.
    private static func reconcileByMapleId(
        candidatePhids: [String],
        deviceId: String, libraryId: String, serverBaseURL: URL,
        state: BackupStateStore,
        markUploaded: () -> Void
    ) async -> [String] {
        let existsClient = BatchExistsClient(
            baseURL: LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL),
            libraryId: libraryId, deviceId: deviceId,
            transport: makeBackupTransport(server: serverBaseURL))
        var toEnqueue: [String] = []
        var presentPhids: [String] = []

        let batchSize = BatchExistsClient.maxBatchSize
        var index = 0
        while index < candidatePhids.count {
            if Task.isCancelled {
                // Cancelled mid-walk — enqueue whatever's left rather than
                // dropping it; server-side dedup is the backstop.
                toEnqueue.append(contentsOf: candidatePhids[index...])
                break
            }
            let end = min(index + batchSize, candidatePhids.count)
            let batch = Array(candidatePhids[index..<end])
            index = end

            // Derive maple_ids off the main thread. Build a phid → maple_id map;
            // phids whose hash we can't derive go straight to enqueue. The
            // derivation reads PHAssetResource bytes (async); run it in a
            // detached Task so the I/O never touches the main actor.
            let derived: [(phid: String, mapleId: String?)] = await Task.detached(priority: .userInitiated) {
                var out: [(phid: String, mapleId: String?)] = []
                out.reserveCapacity(batch.count)
                for phid in batch {
                    if Task.isCancelled { break }
                    let mid = await PhotoKitAssetReader.deriveMapleId(forPHID: phid)
                    out.append((phid: phid, mapleId: mid))
                }
                return out
            }.value

            // If the detached loop was cancelled mid-batch it returns fewer
            // entries than `batch`; the missing phids must still be enqueued
            // (never silently dropped). Server-side dedup is the backstop.
            if derived.count < batch.count {
                let coveredPhids = Set(derived.map(\.phid))
                for phid in batch where !coveredPhids.contains(phid) {
                    toEnqueue.append(phid)
                }
            }

            var mapleIdToPhid: [String: String] = [:]
            var batchMapleIds: [String] = []
            for entry in derived {
                guard let mid = entry.mapleId else {
                    // Couldn't hash → enqueue and let server-side dedup handle it.
                    toEnqueue.append(entry.phid)
                    continue
                }
                // First phid wins if two assets hash identically (true dupes
                // within the same library). Dedupe the query list so each
                // maple_id is asked about once — and so the missing/present
                // fan-out below doesn't process the same id twice.
                if mapleIdToPhid[mid] == nil {
                    mapleIdToPhid[mid] = entry.phid
                    batchMapleIds.append(mid)
                }
            }

            guard !batchMapleIds.isEmpty else { continue }

            do {
                let missing = Set(try await existsClient.missing(mapleIds: batchMapleIds))
                for mid in batchMapleIds {
                    guard let phid = mapleIdToPhid[mid] else { continue }
                    if missing.contains(mid) {
                        toEnqueue.append(phid)
                    } else {
                        presentPhids.append(phid)
                    }
                }
            } catch {
                // Network failure for this batch → enqueue the whole batch.
                log.error("walk maple_id reconciliation batch failed (network): \(String(describing: error), privacy: .public)")
                for phid in mapleIdToPhid.values { toEnqueue.append(phid) }
            }
        }

        // Mark server-present candidates `.uploaded` locally so they're skipped
        // next walk without another round-trip.
        for phid in presentPhids {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            do {
                let task = BackupTask(id: taskId, state: .uploaded, priority: .background)
                try await state.upsert(task)
                markUploaded()
            } catch {
                // If we can't persist the .uploaded marker, enqueue it instead
                // — re-uploading is wasteful but never wrong (server dedups).
                toEnqueue.append(phid)
            }
        }
        return toEnqueue
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
        let sharedAlbumIDs: Set<String> = settings.includeSharedAlbums
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
    private static func notifyDeleted(deviceId: String, libraryId: String,
                                       serverBaseURL: URL, phids: [String]) async {
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
    nonisolated private static func shouldInclude(_ asset: PHAsset, settings: BackupSettings,
                                                  sharedAlbumIDs: Set<String> = []) -> Bool {
        // Bursts: only the representative frame unless includeBursts is true.
        // `representsBurst` is the key frame chosen by iOS; non-representative
        // burst frames have a non-nil burstIdentifier but representsBurst == false.
        if !settings.includeBursts,
           let _ = asset.burstIdentifier,
           !asset.representsBurst {
            return false
        }

        // iCloud Shared Library (iOS 16.1+): PHAsset.sourceType == .typeCloudShared
        // identifies assets the user has been added to via iCloud Shared Library
        // (the newer "shared with family/friends" feature, not shared albums).
        if !settings.includeSharedLibrary,
           asset.sourceType == .typeCloudShared {
            return false
        }

        // Shared Albums (the older invite-based albums with .albumCloudShared
        // subtype): check membership in the pre-built set so each per-asset
        // check is O(1).
        if !settings.includeSharedAlbums,
           sharedAlbumIDs.contains(asset.localIdentifier) {
            return false
        }

        return true
    }

    // Note: the local `sharedAlbumPHIDs()` helper was retired when
    // `PhotoKitCatalog.shared.sharedAlbumIdentifiers()` shipped on main —
    // the catalog gives us a process-wide cached answer that invalidates
    // through the same change-observer fan-out, so every consumer agrees.
}
