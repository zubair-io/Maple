// ThumbnailDiskCache.swift — .maple/ folder thumbnail cache compatible with
// Maple Hosted and Maple Self Hosted (spec § 08 / § 05).
//
// Key: sha256(basename)[:16] — first 16 hex chars (8 bytes) of the SHA-256
//   digest of the asset's filename (extension included). Matches:
//     - Web (Maple Hosted Angular): src/web/projects/maple-common/src/lib/maple-cache/sha.ts
//     - Server (Bun indexer):       src/api/src/fs/xmp.ts (sha256Prefix16)
//   Hashing the basename (not the full path) lets `.maple/thumbs/` travel
//   with the photos — copy the folder elsewhere and the same key resolves.
//   The shared helper lives in `MapleThumbCacheKey.sha256Prefix16(_:)`
//   (FileProvider/MapleThumbCacheKey.swift) and is the single source of
//   truth for all three layers.
// Value: AVIF bytes stored at .maple/thumbs/<hash>.avif
// Eviction: LRU by file mtime; max 500MB or 10,000 entries (configurable).
//
// Migration note: pre-2026-05 builds keyed thumbs by `MD5(url.path)`
// (32 hex chars). Existing entries at the old key are harmless orphans
// and will be cleaned up by LRU eviction over time — we deliberately do
// NOT sweep them, since a regex-based cleanup risks deleting unrelated
// files in `.maple/thumbs/`. Same precedent applies to the JPEG→AVIF format
// migration (thumbnail AVIF epic): existing `.jpg` entries are left as
// orphans rather than fallback-read — the cache is treated as cold and
// regenerates under `.avif`.
//
// Sourceless assets (PhotoKit, Self-Hosted browse) are the exception to the
// `.maple/thumbs/` scheme above (#2763): they have no filesystem URL to hash
// a basename from, so `thumbnailData(forKey:)`/`storeThumbnailData(forKey:)`
// key by the asset's own stable id instead — and, since that stable id has
// no relationship to `cacheDir` (whichever LOCAL folder was most recently
// `configure()`d), those two methods write to a FIXED location under the
// app's Caches directory (`sourcelessCacheDir`) rather than `cacheDir`.
// Writing them through `cacheDir` was the #2763 bug: a PhotoKit/Self-Hosted
// browse that followed a local-folder browse silently wrote into that
// unrelated folder's `.maple/thumbs/`, unreadable by a fresh session or a
// later `configure()` call for a third folder.

import Foundation
import CoreImage

// MARK: - ThumbnailDiskCache

public actor ThumbnailDiskCache {
    public static let shared = ThumbnailDiskCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    private var memCache: [String: CIImage] = [:] // hot in-memory cache
    private var dataMemCache: [String: Data] = [:] // hot AVIF-bytes cache (for UI cells)
    private let maxMemEntries = 100

    /// On-disk store for SOURCELESS thumbnails (PhotoKit, Self-Hosted browse
    /// without a local mirror) — #2763. Deliberately independent of
    /// `cacheDir`: `cacheDir` tracks whichever LOCAL folder was most
    /// recently `configure()`d, and a sourceless asset has no relationship
    /// to that folder at all. Before this fix, `thumbnailData(forKey:)`/
    /// `storeThumbnailData(_:forKey:)` wrote sourceless bytes through
    /// `cacheDir` anyway — a PhotoKit or Self-Hosted browse that followed a
    /// local-folder browse in the same session silently wrote into that
    /// UNRELATED folder's `.maple/thumbs/`, and a fresh session (or a
    /// `configure()` call for a THIRD folder) could never read it back,
    /// forcing a full re-render/re-fetch every time. A sourceless asset's
    /// stable id already makes the cache KEY folder-independent; this
    /// property makes the on-disk DIRECTORY match that, at a fixed location
    /// under the app's own Caches directory (same convention as
    /// `CloudThumbCache`'s `cloud-thumbs`) rather than one hostage to
    /// whatever local folder happens to be open.
    private let sourcelessCacheDir: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = caches
            .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
            .appendingPathComponent("sourceless-thumbs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// Thumbnail target size per spec § 03 (256 px long edge).
    public static let defaultThumbSize = CGSize(width: 256, height: 256)

    // MARK: - Nonisolated synchronous peek (M1 scale-zoom)
    //
    // NSCache is internally thread-safe, so it can be stored as a `let` on the
    // actor and read from a `nonisolated` context without an actor hop.
    // Every write to `dataMemCache` also writes here; evictIfNeeded() keeps it
    // capped at the same `maxMemEntries` limit (NSCache auto-evicts under memory
    // pressure as well, so the peek may return nil even for a key that was
    // recently stored — the `.task` async path always fills on a miss, which
    // then populates both caches for subsequent sync peeks).
    let syncPeekCache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        // Hold enough that already-seen thumbnails aren't evicted while
        // browsing/zooming a large folder — eviction makes the sync peek miss
        // and flashes the placeholder on a repacked/rewindowed cell. JPEG
        // thumbnails are small; NSCache still purges under real memory pressure.
        c.countLimit = 2000
        return c
    }()

    // MARK: - Configure

    /// Set the folder cache base dir (e.g. the open folder's .maple/ subdirectory).
    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let thumbDir = mapleDir.appendingPathComponent("thumbs")
        try? fm.createDirectory(at: thumbDir, withIntermediateDirectories: true)
        cacheDir = thumbDir
    }

    // MARK: - Read

    /// Return a CIImage thumbnail for the given asset URL, or nil if not cached.
    public func thumbnail(for assetURL: URL) -> CIImage? {
        let key = cacheKey(for: assetURL)
        // 1. Memory
        if let img = memCache[key] { return img }
        // 2. Disk
        guard let dir = cacheDir else { return nil }
        let fileURL = dir.appendingPathComponent("\(key).avif")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else { return nil }
        // Promote to memory cache
        evictIfNeeded()
        memCache[key] = ci
        return ci
    }

    /// Return AVIF bytes for the given asset URL, or nil if not cached.
    /// Preferred entry-point for UI cells that render via `Image(data:)`.
    ///
    /// Does NOT delegate to `thumbnailData(forKey:)` (#2763): that overload
    /// now reads from `sourcelessCacheDir`, a fixed location independent of
    /// `cacheDir` — correct for a sourceless (PhotoKit/Self-Hosted) stable
    /// id, wrong for a URL-backed local asset, which must keep resolving
    /// against `cacheDir` (the actual asset's folder). The two overloads
    /// share the same hash function (`cacheKey`/`hashKey`, both
    /// `MapleThumbCacheKey.sha256Prefix16`) but not the same directory.
    public func thumbnailData(for assetURL: URL) -> Data? {
        let key = cacheKey(for: assetURL)
        if let d = dataMemCache[key] { return d }
        guard let dir = cacheDir else { return nil }
        let fileURL = dir.appendingPathComponent("\(key).avif")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else { return nil }
        evictIfNeeded()
        dataMemCache[key] = data
        syncPeekCache.setObject(data as NSData, forKey: key as NSString)
        return data
    }

    /// Return AVIF bytes for an opaque stable key (e.g. an `AssetRef.id` or a
    /// server-provided maple:id hex). Used by sourceless assets (PhotoKit,
    /// SelfHosted) where there is no filesystem URL to hash by basename.
    /// Note: pre-2026-05 this overload used MD5 of the key; it now shares
    /// the same `sha256Prefix16` helper as the URL-keyed path, so any
    /// pre-existing cloud-thumb entries at the old MD5 path are orphans.
    public func thumbnailData(forKey key: String) -> Data? {
        let hashed = hashKey(key)
        if let d = dataMemCache[hashed] { return d }
        let fileURL = sourcelessCacheDir.appendingPathComponent("\(hashed).avif")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else { return nil }
        evictIfNeeded()
        dataMemCache[hashed] = data
        syncPeekCache.setObject(data as NSData, forKey: hashed as NSString)
        return data
    }

    // MARK: - Nonisolated synchronous memory peek

    /// Synchronous, non-awaiting peek into `syncPeekCache`. Returns AVIF bytes
    /// if the thumbnail is already in the NSCache hot store; returns `nil` on
    /// any miss (disk not consulted — no blocking I/O). Safe to call from any
    /// context (nonisolated, main thread, a gesture handler) because NSCache is
    /// internally thread-safe.
    ///
    /// Key derivation mirrors `thumbnailData(forKey:)`: pass the **basename** for
    /// URL-backed assets and the stable ID for sourceless assets — the same input
    /// you would pass to `storeThumbnailData(_:forKey:)`.
    public nonisolated func syncPeekData(forKey key: String) -> Data? {
        let hashed = MapleThumbCacheKey.sha256Prefix16(key)
        return syncPeekCache.object(forKey: hashed as NSString) as Data?
    }

    // MARK: - Write

    /// Store a CIImage thumbnail as AVIF (`ThumbnailEncoder.quality`).
    public func storeThumbnail(_ image: CIImage, for assetURL: URL) {
        let key = cacheKey(for: assetURL)
        evictIfNeeded()
        memCache[key] = image

        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(key).avif")
        let ctx = CIContext()
        guard let data = ThumbnailEncoder.encode(image, ctx: ctx) else { return }
        dataMemCache[key] = data
        syncPeekCache.setObject(data as NSData, forKey: key as NSString)
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Store pre-encoded AVIF bytes. Used by `ThumbnailLoader` which encodes
    /// off-actor (avoids blocking the cache actor on the encode round-trip).
    ///
    /// Does NOT delegate to `storeThumbnailData(_:forKey:)` (#2763) — see
    /// `thumbnailData(for:)`'s doc comment for why the two overloads can no
    /// longer share an implementation now that they write to different
    /// directories.
    public func storeThumbnailData(_ data: Data, for assetURL: URL) {
        let key = cacheKey(for: assetURL)
        evictIfNeeded()
        dataMemCache[key] = data
        syncPeekCache.setObject(data as NSData, forKey: key as NSString)
        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(key).avif")
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Store pre-encoded AVIF bytes under an opaque stable key. Sibling of the
    /// URL-keyed overload — used for sourceless assets keyed by `AssetRef.id`.
    public func storeThumbnailData(_ data: Data, forKey key: String) {
        let hashed = hashKey(key)
        evictIfNeeded()
        dataMemCache[hashed] = data
        syncPeekCache.setObject(data as NSData, forKey: hashed as NSString)
        let fileURL = sourcelessCacheDir.appendingPathComponent("\(hashed).avif")
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Cache key

    /// Cache key derived from the **filename only** so `.maple/thumbs/`
    /// travels with the photos: copy the folder elsewhere and the same
    /// hash still resolves. Delegates to `MapleThumbCacheKey.sha256Prefix16`
    /// — the single source of truth shared with the API
    /// (`src/api/src/fs/xmp.ts`) and the web Hosted variant
    /// (`src/web/projects/maple-common/src/lib/maple-cache/sha.ts`) so
    /// thumbnails are interchangeable across all three layers.
    public static func cacheKey(for url: URL) -> String {
        return MapleThumbCacheKey.sha256Prefix16(url.lastPathComponent)
    }

    nonisolated func cacheKey(for url: URL) -> String {
        return Self.cacheKey(for: url)
    }

    /// Hash for opaque stable keys (cloud asset IDs etc.) — shares the
    /// same `sha256Prefix16` derivation as `cacheKey(for:)`, so a single
    /// helper governs every on-disk filename this cache writes.
    private func hashKey(_ string: String) -> String {
        return MapleThumbCacheKey.sha256Prefix16(string)
    }

    // MARK: - Memory pressure

    /// Drop all but `percent`% of in-memory entries. Called from
    /// `ThumbnailLoader.handleMemoryPressure()` in response to system-level
    /// memory warnings.
    public func shrinkMemCache(to percent: Int) {
        let keep = max(1, (maxMemEntries * max(0, min(100, percent))) / 100)
        while memCache.count > keep {
            if let key = memCache.keys.first { memCache.removeValue(forKey: key) }
        }
        while dataMemCache.count > keep {
            if let key = dataMemCache.keys.first { dataMemCache.removeValue(forKey: key) }
        }
    }

    // MARK: - Eviction

    private func evictIfNeeded() {
        if memCache.count >= maxMemEntries {
            // Simple FIFO eviction — remove oldest (random) entry.
            if let key = memCache.keys.first { memCache.removeValue(forKey: key) }
        }
        if dataMemCache.count >= maxMemEntries {
            if let key = dataMemCache.keys.first { dataMemCache.removeValue(forKey: key) }
        }
    }
}
