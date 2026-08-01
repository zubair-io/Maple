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
// The catalog is a regular `final class` protected by an `NSLock`. Callers
// from any actor or thread invoke the sync methods directly — no `await`
// required. `PHAsset` itself is reference-typed and safe to pass across
// threads (Photos vends opaque proxy objects backed by their own internal
// locking).
//
// Cache invalidation
// ------------------
// `invalidate()` is called SYNCHRONOUSLY from inside the
// `PhotoKitChangeObserver` fan-out callback — before any other subscriber's
// handler runs. This guarantees that by the time other subscribers receive
// the change notification, the catalog's caches have already been cleared
// and subsequent reads will see fresh data from PhotoKit.
//
// Pagination
// ----------
// `paginatedImageIdentifiers` enumerates `PHFetchResult` in bounded chunks
// WITHOUT pre-materialising the full id list. Memory per page is O(pageSize)
// PHAsset proxies regardless of library size.

import Foundation
import Photos

// MARK: - PhotoKitCatalog

public final class PhotoKitCatalog: @unchecked Sendable {

    public static let shared = PhotoKitCatalog()

    // MARK: Internal lock

    private let lock = NSLock()

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

    /// Deliberately does NOT subscribe. Registering a
    /// `PHPhotoLibraryChangeObserver` while authorization is `.notDetermined`
    /// is itself an authorization request (#2454), and this is a lazily
    /// initialised singleton — subscribing here would make "does the app
    /// prompt at launch?" depend on whoever touched the catalog first.
    ///
    /// Subscription happens at first use instead (`ensureObserving`), so a
    /// catalog that was created before the user granted access still starts
    /// observing once it is actually used afterwards. Gating in `init` alone
    /// would leave the singleton permanently unsubscribed for the rest of the
    /// session, silently serving stale caches — iOS does not relaunch the app
    /// when permission is granted in-place.
    private init() {}

    /// Subscribe to library changes the first time the catalog is used with
    /// access in hand. Cheap and idempotent: one relaxed check on the common
    /// path, and never called while holding `lock` (the observer takes its own
    /// lock, so nesting them would fix a lock order this class otherwise
    /// doesn't have).
    private func ensureObserving() {
        lock.lock()
        let alreadySubscribed = observerToken != nil
        lock.unlock()
        guard !alreadySubscribed else { return }

        let status = PhotoKitLibrary.authorizationStatus()
        guard status == .authorized || status == .limited else { return }

        let token = PhotoKitChangeObserver.shared.subscribe { [weak self] in
            // Synchronous invalidation — runs on the PhotoKit-private thread
            // but the lock makes mutation safe. By the time other subscribers'
            // handlers run, our caches are already cleared, so no subscriber
            // can read stale cachedImageIDs / assetByID from this catalog.
            self?.invalidate()
        }

        lock.lock()
        let won = observerToken == nil
        if won { observerToken = token }
        lock.unlock()
        // Two callers can race through the gap above; the loser drops its
        // duplicate rather than leaking a second subscription.
        if !won { PhotoKitChangeObserver.shared.unsubscribe(token) }
    }

    deinit {
        if let token = observerToken {
            PhotoKitChangeObserver.shared.unsubscribe(token)
        }
    }

    // MARK: Public API

    /// Drop all caches. The next read from any API rebuilds from PhotoKit.
    /// Called automatically — synchronously — on every `PhotoKitChangeObserver`
    /// fan-out. Consumers may also call this directly in tests.
    public func invalidate() {
        lock.lock(); defer { lock.unlock() }
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
        ensureObserving()
        lock.lock()
        if let cached = assetByID[localId] {
            lock.unlock()
            return cached
        }
        lock.unlock()
        // PHAsset.fetchAssets is thread-safe — call outside the lock so we
        // don't block other readers during the PhotoKit round-trip.
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = result.firstObject else { return nil }
        lock.lock()
        assetByID[localId] = asset
        lock.unlock()
        return asset
    }

    /// Image-asset localIdentifiers in capture-date descending order.
    ///
    /// One PhotoKit query per cache cycle, then memoised. As a side-effect
    /// all returned assets are populated into `assetByID` so subsequent
    /// `asset(localId:)` calls for those ids are free.
    public func imageIdentifiers() -> [String] {
        ensureObserving()
        lock.lock()
        if let cached = cachedImageIDs {
            lock.unlock()
            return cached
        }
        lock.unlock()
        // Build outside the lock — PHFetchResult enumeration shouldn't block
        // other readers. If two callers race, both build the same list and the
        // last write wins (safe: identical content).
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: opts)
        var ids: [String] = []
        ids.reserveCapacity(result.count)
        var newAssets: [String: PHAsset] = [:]
        result.enumerateObjects { asset, _, _ in
            ids.append(asset.localIdentifier)
            newAssets[asset.localIdentifier] = asset
        }
        lock.lock()
        if let cached = cachedImageIDs {
            // Another caller raced us and already populated the cache.
            lock.unlock()
            return cached
        }
        cachedImageIDs = ids
        for (k, v) in newAssets { assetByID[k] = v }
        lock.unlock()
        return ids
    }

    /// Video-asset localIdentifiers in capture-date descending order.
    ///
    /// Same shape and caching semantics as `imageIdentifiers()`.
    public func videoIdentifiers() -> [String] {
        ensureObserving()
        lock.lock()
        if let cached = cachedVideoIDs {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .video, options: opts)
        var ids: [String] = []
        ids.reserveCapacity(result.count)
        var newAssets: [String: PHAsset] = [:]
        result.enumerateObjects { asset, _, _ in
            ids.append(asset.localIdentifier)
            newAssets[asset.localIdentifier] = asset
        }
        lock.lock()
        if let cached = cachedVideoIDs {
            lock.unlock()
            return cached
        }
        cachedVideoIDs = ids
        for (k, v) in newAssets { assetByID[k] = v }
        lock.unlock()
        return ids
    }

    /// Paginated identifier enumeration — yields chunks of `pageSize` ids.
    ///
    /// Enumerates `PHFetchResult` directly in bounded slices WITHOUT
    /// pre-materialising the full id list. For a 100k library with
    /// pageSize=1000, peak per-page memory is ~1000 PHAsset proxies, not 100k.
    ///
    /// `pageSize` is clamped to at least 1 so callers can't accidentally
    /// request an infinite stream of empty chunks.
    public func paginatedImageIdentifiers(pageSize: Int = 1000) -> AsyncStream<[String]> {
        ensureObserving()
        let safePageSize = max(1, pageSize)
        return AsyncStream { continuation in
            Task.detached {
                let opts = PHFetchOptions()
                opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                let result = PHAsset.fetchAssets(with: .image, options: opts)
                let total = result.count
                var idx = 0
                while idx < total {
                    let end = min(idx + safePageSize, total)
                    var chunk: [String] = []
                    chunk.reserveCapacity(end - idx)
                    // objects(at:) retrieves a bounded page from the
                    // PHFetchResult without materialising the whole collection.
                    let indexSet = IndexSet(integersIn: idx..<end)
                    let pageAssets = result.objects(at: indexSet)
                    var newAssets: [String: PHAsset] = [:]
                    for asset in pageAssets {
                        chunk.append(asset.localIdentifier)
                        newAssets[asset.localIdentifier] = asset
                    }
                    // Opportunistically update the asset cache so later
                    // `asset(localId:)` calls for these ids are free.
                    Self.shared.mergeAssetCache(newAssets)
                    continuation.yield(chunk)
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
        ensureObserving()
        lock.lock()
        if let cached = cachedSharedAlbumIDs {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .album, subtype: .albumCloudShared, options: nil)
        var ids = Set<String>()
        collections.enumerateObjects { collection, _, _ in
            let assets = PHAsset.fetchAssets(in: collection, options: nil)
            assets.enumerateObjects { asset, _, _ in
                ids.insert(asset.localIdentifier)
            }
        }
        lock.lock()
        if let cached = cachedSharedAlbumIDs {
            lock.unlock()
            return cached
        }
        cachedSharedAlbumIDs = ids
        lock.unlock()
        return ids
    }

    // MARK: Internal helpers

    /// Merge new asset entries into the cache under the lock.
    /// Used by `paginatedImageIdentifiers` to opportunistically populate the
    /// per-id lookup cache as pages are streamed.
    internal func mergeAssetCache(_ newAssets: [String: PHAsset]) {
        lock.lock(); defer { lock.unlock() }
        for (k, v) in newAssets { assetByID[k] = v }
    }

    // MARK: Test-only helpers (internal visibility, not public API)

    /// Seed the image-id cache with a known value. Test use only.
    /// Subscribe unconditionally, bypassing the authorization gate.
    ///
    /// Test-only. `ensureObserving()` refuses to register an observer without
    /// PhotoKit access (registering one while `.notDetermined` is itself an
    /// authorization request — #2454), and a test host has no access to grant,
    /// so the fan-out tests need a way to reach the subscribed state that
    /// production reaches on first use after a grant.
    internal func testOnlyStartObserving() {
        guard observerToken == nil else { return }
        observerToken = PhotoKitChangeObserver.shared.subscribe { [weak self] in
            self?.invalidate()
        }
    }

    internal func testOnlySetCache(imageIDs: [String]) {
        lock.lock(); defer { lock.unlock() }
        cachedImageIDs = imageIDs
    }

    /// Inspect the current image-id cache. Returns nil when the cache is empty.
    /// Test use only.
    internal func testOnlyCachedImageIDs() -> [String]? {
        lock.lock(); defer { lock.unlock() }
        return cachedImageIDs
    }
}
