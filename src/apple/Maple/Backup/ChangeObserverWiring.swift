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
    static func start(deviceId: String) {
        if let prior = token {
            PhotoKitChangeObserver.shared.unsubscribe(prior)
        }
        token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
            Task { @MainActor in
                await enqueueAllNew(deviceId: deviceId)
            }
        }
        // Kick off an initial walk so we don't wait for a change event to seed
        // the queue on first launch.
        Task { await enqueueAllNew(deviceId: deviceId) }
    }

    /// Unsubscribe from library changes. Idempotent.
    static func stop() {
        if let t = token {
            PhotoKitChangeObserver.shared.unsubscribe(t)
            token = nil
        }
    }

    /// Walk every PHAsset and enqueue any we don't yet have in BackupStateStore.
    /// Cheap: PHAsset.fetchAssets is SQLite-backed; the state lookup is also
    /// SQLite. For a 100k-asset library this is seconds, not minutes.
    private static func enqueueAllNew(deviceId: String) async {
        guard let state = EngineHost.shared.state else { return }
        let queue = EngineHost.shared.queue

        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let imageResult = PHAsset.fetchAssets(with: .image, options: opts)
        let videoResult = PHAsset.fetchAssets(with: .video, options: opts)

        var ids: [String] = []
        ids.reserveCapacity(imageResult.count + videoResult.count)
        imageResult.enumerateObjects { asset, _, _ in ids.append(asset.localIdentifier) }
        videoResult.enumerateObjects { asset, _, _ in ids.append(asset.localIdentifier) }

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
}
