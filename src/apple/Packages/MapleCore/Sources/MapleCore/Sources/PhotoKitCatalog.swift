// PhotoKitCatalog.swift — Process-wide cache for PhotoKit asset lookups.
//
// All five previous call sites that issued their own `PHAsset.fetchAssets`
// queries now share this single cache. Cache entries are lazily populated and
// invalidated on every `PhotoKitChangeObserver` fan-out so all consumers see
// the same consistent snapshot after a library change.
//
// Design rationale
// ----------------
// At 100k-asset scale, per-call `PHAsset.fetchAssets(withLocalIdentifiers:)`
// queries add up. More critically, queries issued at different moments may
// return slightly different snapshots if a library change arrives mid-walk.
// Centralising here gives us one canonical answer per refresh cycle.
//
// Thread-safety
// -------------
// The catalog is `@MainActor`-isolated. Callers from other actors cross the
// hop with `await`. `PHAsset` itself is reference-typed and safe to pass
// across actor boundaries (it is `@unchecked Sendable` in practice; Photos
// vends opaque proxy objects backed by their own internal locking).
//
// Cache invalidation
// ------------------
// On every `PhotoKitChangeObserver.shared` fan-out the catalog drops all
// cached state. The next read from any consumer re-queries PhotoKit and
// repopulates the caches lazily. Callers do NOT need to participate in
// invalidation — that contract is entirely internal to this type.

import Foundation
import Photos

// MARK: - PhotoKitCatalog

@MainActor
public final class PhotoKitCatalog {

    public static let shared = PhotoKitCatalog()

    // MARK: Cached state

    /// localIdentifier → PHAsset proxy. Populated lazily: each `asset(localId:)`
    /// call on a miss queries PhotoKit for that single id and memoises the result.
    /// Also bulk-populated by `imageIdentifiers()` / `videoIdentifiers()`.
    private var assetByID: [String: PHAsset] = [:]

    /// Image localIdentifiers in capture-date descending order. nil = not yet
    /// built this cycle.
    private var cachedImageIDs: [String]?

    /// Video localIdentifiers in capture-date descending order. nil = not yet
    /// built this cycle.
    private var cachedVideoIDs: [String]?

    /// Set of localIdentifiers belonging to at least one iCloud Shared Album.
    /// nil = not yet built this cycle.
    private var cachedSharedAlbumIDs: Set<String>?

    // MARK: Lifecycle

    private var observerToken: UUID?

    private init() {
        observerToken = PhotoKitChangeObserver.shared.subscribe { [weak self] in
            Task { @MainActor in self?.invalidate() }
        }
    }

    deinit {
        if let token = observerToken {
            PhotoKitChangeObserver.shared.unsubscribe(token)
        }
    }

    // MARK: Public API

    /// Drop all caches. The next read from any API rebuilds from PhotoKit.
    /// Called automatically on every `PhotoKitChangeObserver` fan-out.
    /// Consumers may also call this directly in tests.
    public func invalidate() {
        assetByID.removeAll()
        cachedImageIDs = nil
        cachedVideoIDs = nil
        cachedSharedAlbumIDs = nil
    }

    /// O(1) lookup by localIdentifier.
    ///
    /// Returns nil when PhotoKit doesn't know this id (deleted asset,
    /// foreign-library id, asset not yet imported). Cache misses issue a
    /// single-id `PHAsset.fetchAssets` call and memoise the result so the
    /// second call for the same id is free.
    public func asset(localId: String) -> PHAsset? {
        if let cached = assetByID[localId] { return cached }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = result.firstObject else { return nil }
        assetByID[localId] = asset
        return asset
    }

    /// Image-asset localIdentifiers in capture-date descending order.
    ///
    /// One PhotoKit query per cache cycle, then memoised. As a side-effect
    /// all returned assets are populated into `assetByID` so subsequent
    /// `asset(localId:)` calls for those ids are free.
    public func imageIdentifiers() -> [String] {
        if let cached = cachedImageIDs { return cached }
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: opts)
        var ids: [String] = []
        ids.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            ids.append(asset.localIdentifier)
            self.assetByID[asset.localIdentifier] = asset
        }
        cachedImageIDs = ids
        return ids
    }

    /// Video-asset localIdentifiers in capture-date descending order.
    ///
    /// Same shape and caching semantics as `imageIdentifiers()`.
    public func videoIdentifiers() -> [String] {
        if let cached = cachedVideoIDs { return cached }
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .video, options: opts)
        var ids: [String] = []
        ids.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            ids.append(asset.localIdentifier)
            self.assetByID[asset.localIdentifier] = asset
        }
        cachedVideoIDs = ids
        return ids
    }

    /// Paginated identifier enumeration — yields chunks of `pageSize` ids.
    ///
    /// Reuses the cached id list when present, so cost is one PhotoKit query
    /// per cache cycle regardless of how many chunks are consumed. Each
    /// chunk `await Task.yield()`s between pages so the main run-loop stays
    /// responsive on large libraries.
    public func paginatedImageIdentifiers(pageSize: Int = 1000) -> AsyncStream<[String]> {
        AsyncStream { continuation in
            let all = self.imageIdentifiers()
            Task { @MainActor in
                var idx = 0
                while idx < all.count {
                    let end = min(idx + pageSize, all.count)
                    continuation.yield(Array(all[idx..<end]))
                    idx = end
                    await Task.yield()
                }
                continuation.finish()
            }
        }
    }

    /// All PHAsset localIdentifiers that belong to at least one iCloud Shared
    /// Album (PHAssetCollectionType.album / subtype .albumCloudShared).
    ///
    /// Used by ChangeObserverWiring to exclude shared-album assets when
    /// `settings.includeSharedAlbums` is false. Result is memoised per cycle.
    public func sharedAlbumIdentifiers() -> Set<String> {
        if let cached = cachedSharedAlbumIDs { return cached }
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .album, subtype: .albumCloudShared, options: nil)
        var ids = Set<String>()
        collections.enumerateObjects { collection, _, _ in
            let assets = PHAsset.fetchAssets(in: collection, options: nil)
            assets.enumerateObjects { asset, _, _ in
                ids.insert(asset.localIdentifier)
            }
        }
        cachedSharedAlbumIDs = ids
        return ids
    }
}
