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
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §10.

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
    static func start(deviceId: String, settings: BackupSettings,
                      libraryId: String, serverBaseURL: URL) {
        log.info("start subscribe deviceId=\(deviceId, privacy: .public) libraryId=\(libraryId, privacy: .public) server=\(serverBaseURL.absoluteString, privacy: .public)")
        // Reset cross-walk delete-diff state so a library change doesn't mark
        // assets in the new library as deleted (they weren't in the old set).
        lastSeenPhids = []

        if let prior = token {
            PhotoKitChangeObserver.shared.unsubscribe(prior)
        }
        token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
            Task { @MainActor in
                await enqueueAllNew(deviceId: deviceId, settings: settings,
                                    libraryId: libraryId, serverBaseURL: serverBaseURL)
            }
        }
        // Kick off an initial walk so we don't wait for a change event to seed
        // the queue on first launch.
        Task { await enqueueAllNew(deviceId: deviceId, settings: settings,
                                   libraryId: libraryId, serverBaseURL: serverBaseURL) }
    }

    /// Unsubscribe from library changes. Idempotent.
    static func stop() {
        if let t = token {
            PhotoKitChangeObserver.shared.unsubscribe(t)
            token = nil
        }
    }

    /// Public entry point for the periodic safety walk (called by EngineHost's
    /// weekly timer and the iOS BGProcessingTask handler).
    static func runWalk(deviceId: String, settings: BackupSettings,
                        libraryId: String, serverBaseURL: URL) async {
        await enqueueAllNew(deviceId: deviceId, settings: settings,
                            libraryId: libraryId, serverBaseURL: serverBaseURL)
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
                                       libraryId: String, serverBaseURL: URL) async {
        log.info("walk begin libraryId=\(libraryId, privacy: .public)")
        guard let state = EngineHost.shared.state else {
            log.error("walk bail: EngineHost.shared.state is nil — backup engine never finished starting")
            return
        }
        let queue = EngineHost.shared.queue

        // PhotoKit enumeration off main. PHAsset.fetchAssets +
        // enumerateObjects are documented as thread-safe; the result types
        // (PHFetchResult / PHAsset) are reference types but their reads are
        // safe. We snapshot to a Sendable [String] before returning to main.
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

        // One round-trip instead of one per phid. Build a Set of known task IDs
        // and diff in-memory so a 100k library doesn't make 100k SQLite calls.
        let seen: Set<BackupTaskID>
        do {
            let allTasks = try await state.allTasks()
            seen = Set(allTasks.map(\.id))
        } catch {
            log.error("walk bail: allTasks() failed: \(String(describing: error), privacy: .public)")
            return
        }

        var enqueuedCount = 0
        var enqueueFailures = 0
        for phid in ids {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            if !seen.contains(taskId) {
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
        }
        log.info("walk done: enqueued=\(enqueuedCount) skipped=\(ids.count - enqueuedCount) failures=\(enqueueFailures)")
    }

    // MARK: - Off-main PhotoKit walk
    //
    // The functions below are `nonisolated` so they can run from a
    // detached Task on a background executor. They touch only PhotoKit
    // (which is thread-safe for fetch + enumerate) and the value-type
    // BackupSettings; no shared MainActor state.

    /// PhotoKit enumeration extracted from `enqueueAllNew`. Returns the
    /// set of eligible PHAsset localIdentifiers given the current settings.
    /// Pure function — safe to call from any thread.
    nonisolated private static func walkPhotoKit(settings: BackupSettings) -> [String] {
        let sharedAlbumIDs: Set<String> = settings.includeSharedAlbums
            ? []
            : sharedAlbumPHIDs()

        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        var ids: [String] = []
        let imageResult = PHAsset.fetchAssets(with: .image, options: opts)
        ids.reserveCapacity(imageResult.count)
        imageResult.enumerateObjects { asset, _, _ in
            guard shouldInclude(asset, settings: settings,
                                sharedAlbumIDs: sharedAlbumIDs) else { return }
            ids.append(asset.localIdentifier)
        }

        if settings.includeVideos {
            let videoResult = PHAsset.fetchAssets(with: .video, options: opts)
            ids.reserveCapacity(ids.count + videoResult.count)
            videoResult.enumerateObjects { asset, _, _ in
                guard shouldInclude(asset, settings: settings,
                                    sharedAlbumIDs: sharedAlbumIDs) else { return }
                ids.append(asset.localIdentifier)
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
        let url = serverBaseURL
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
        _ = try? await URLSession.shared.data(for: req)
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

    /// Build a set of PHAsset localIdentifiers that belong to at least one
    /// iCloud Shared Album (PHAssetCollectionType.album /
    /// PHAssetCollectionSubtype.albumCloudShared). This is intentionally done
    /// once per walk and the result is passed into each `shouldInclude` call so
    /// we don't re-enumerate the album list for every asset. Nonisolated so
    /// it can run from the off-main walk.
    nonisolated private static func sharedAlbumPHIDs() -> Set<String> {
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .album, subtype: .albumCloudShared, options: nil)
        var ids = Set<String>()
        collections.enumerateObjects { collection, _, _ in
            let assets = PHAsset.fetchAssets(in: collection, options: nil)
            assets.enumerateObjects { asset, _, _ in
                ids.insert(asset.localIdentifier)
            }
        }
        return ids
    }
}
