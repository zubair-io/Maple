// src/apple/Maple/Backup/ChangeObserverWiring.swift
//
// Wire PhotoKitChangeObserver → EngineHost.queue for incremental backup.
//
// On every library-change event (new capture, edit, delete in Apple Photos),
// enumerate PHAsset.fetchAssets(.image) + .video and enqueue any localIdentifier
// the state store hasn't seen yet. The change observer fires on a private
// PhotoKit thread; we hop to MainActor before touching EngineHost state.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §10.

import Foundation
import Photos
import MapleBackup
import MapleCore

@MainActor
enum ChangeObserverWiring {

    /// Holds the subscription token between start() and stop(). Re-entering
    /// start() while already started replaces the token (cancels the old sub
    /// before adding a new one).
    private static var token: UUID?

    /// Subscribe to library changes. Idempotent.
    /// `settings` controls which asset types and categories are enqueued.
    static func start(deviceId: String, settings: BackupSettings) {
        if let prior = token {
            PhotoKitChangeObserver.shared.unsubscribe(prior)
        }
        token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
            Task { @MainActor in
                await enqueueAllNew(deviceId: deviceId, settings: settings)
            }
        }
        // Kick off an initial walk so we don't wait for a change event to seed
        // the queue on first launch.
        Task { await enqueueAllNew(deviceId: deviceId, settings: settings) }
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
    static func runWalk(deviceId: String, settings: BackupSettings) async {
        await enqueueAllNew(deviceId: deviceId, settings: settings)
    }

    /// Walk every PHAsset and enqueue any we don't yet have in BackupStateStore.
    /// Cheap: PHAsset.fetchAssets is SQLite-backed; the state lookup is also
    /// SQLite. For a 100k-asset library this is seconds, not minutes.
    ///
    /// Applies inclusion filters from `settings`:
    ///  - `includeVideos`: when false, skips video assets entirely.
    ///  - `includeBursts`: when false, skips non-representative burst frames.
    ///
    /// Not yet implemented (PhotoKit API is fragmented across iOS versions):
    ///  - `includeSharedLibrary`: filtering iCloud Shared Library assets would
    ///    require checking the asset's source type or smart album membership.
    ///    The correct approach is to check whether the asset belongs to the
    ///    smart album `PHAssetCollectionSubtype.smartAlbumShared` or compare
    ///    `asset.sourceType`. Deferred for a follow-up ticket.
    ///    TODO: implement via PHAssetCollection.smartAlbumShared membership check.
    ///  - `includeSharedAlbums`: similarly requires iterating shared albums
    ///    (PHAssetCollectionType.album, subtype .albumCloudShared) to build
    ///    a set of phids, then excluding. Deferred.
    ///    TODO: implement via PHAssetCollectionType.album / albumCloudShared.
    private static func enqueueAllNew(deviceId: String, settings: BackupSettings) async {
        guard let state = EngineHost.shared.state else { return }
        let queue = EngineHost.shared.queue

        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        var ids: [String] = []
        let imageResult = PHAsset.fetchAssets(with: .image, options: opts)
        ids.reserveCapacity(imageResult.count)
        imageResult.enumerateObjects { asset, _, _ in
            guard shouldInclude(asset, settings: settings) else { return }
            ids.append(asset.localIdentifier)
        }

        if settings.includeVideos {
            let videoResult = PHAsset.fetchAssets(with: .video, options: opts)
            ids.reserveCapacity(ids.count + videoResult.count)
            videoResult.enumerateObjects { asset, _, _ in
                guard shouldInclude(asset, settings: settings) else { return }
                ids.append(asset.localIdentifier)
            }
        }

        for phid in ids {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            do {
                if try await state.find(taskId) == nil {
                    let task = BackupTask(id: taskId, state: .pending, priority: .background)
                    try await state.upsert(task)
                    await queue.enqueue(task, priority: .background)
                }
            } catch {
                // Persist failures are rare; skip and try again next walk.
                #if DEBUG
                print("ChangeObserverWiring: enqueue failed for \(phid): \(error)")
                #endif
            }
        }
    }

    /// Returns true when the asset should be included in the backup based on
    /// the current `settings`.
    private static func shouldInclude(_ asset: PHAsset, settings: BackupSettings) -> Bool {
        // Bursts: only the representative frame unless includeBursts is true.
        // `representsBurst` is the key frame chosen by iOS; non-representative
        // burst frames have a non-nil burstIdentifier but representsBurst == false.
        if !settings.includeBursts,
           let _ = asset.burstIdentifier,
           !asset.representsBurst {
            return false
        }
        // iCloud Shared Library / Shared Albums: not yet filtered (see function
        // doc-comment above for the TODO).
        return true
    }
}
