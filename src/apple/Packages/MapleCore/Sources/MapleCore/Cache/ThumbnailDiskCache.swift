// ThumbnailDiskCache.swift — .maple/ folder thumbnail cache compatible with
// Maple Hosted and Maple Self Hosted (spec § 08 / § 05).
//
// File: .maple/thumbs/<filename.ext>.avif — the asset's own filename,
//   extension included, matching `.maple/previews/<filename.ext>.avif` and
//   every other platform (#4793). Naming by basename (not the full path)
//   lets `.maple/thumbs/` travel with the photos. A miss adopts the frozen
//   legacy `<sha256Prefix16(basename)>.v25.avif` by rename, never by
//   regenerating.
// Location: always the asset's OWN folder's `.maple/thumbs/`, never the most
// recently configured folder's — the unified Timeline shows every saved folder
// at once, and a sibling or parent folder's cache must not answer for (or be
// written by) another folder's same-named file (#5033).
// Memory key: `memoryKey(for:)`, a hash of the full path, for the same reason;
// the basename hash (`cacheKey(for:)`) only names the frozen legacy file.
//
// Bounds: 100 image + 100 data entries in memory (FIFO), plus a 2000-entry
// `NSCache` for the sync peek; disk is not evicted.
//
// Migration note: pre-2026-05 builds keyed thumbs by `MD5(url.path)`
// (32 hex chars). Existing entries at the old key are harmless orphans
// that stay, since nothing evicts disk — we deliberately do NOT sweep them,
// since a regex-based cleanup risks deleting unrelated
// files in `.maple/thumbs/`. Same precedent applies to the JPEG→AVIF format
// migration (thumbnail AVIF epic): existing `.jpg` entries are left as
// orphans rather than fallback-read — the cache is treated as cold and
// regenerates under `.avif`.
//
// Sourceless assets (PhotoKit, Self-Hosted browse) are the exception to the
// `.maple/thumbs/` scheme above (#2763): they have no filesystem URL, so no
// folder of their own, and `thumbnailData(forKey:)`/`storeThumbnailData(forKey:)`
// key by the asset's own stable id instead and, having no folder of their
// own, live at a FIXED location under the app's Caches directory
// (`sourcelessCacheDir`). Writing them into whichever local folder was open
// was the #2763 bug: unreadable by a fresh session or another folder.

import CoreImage
import Foundation

// MARK: - ThumbnailDiskCache

public actor ThumbnailDiskCache {
  public static let shared = ThumbnailDiskCache()

  private let fm = FileManager.default
  private var memCache: [String: CIImage] = [:]  // hot in-memory cache
  private var dataMemCache: [String: Data] = [:]  // hot AVIF-bytes cache (for UI cells)
  private let maxMemEntries = 100

  /// On-disk store for SOURCELESS thumbnails (PhotoKit, Self-Hosted browse
  /// without a local mirror) — #2763. A sourceless asset has no folder, so its
  /// thumbnail lives at a fixed location under the app's own Caches directory
  /// (same convention as `CloudThumbCache`'s `cloud-thumbs`) rather than in
  /// whatever local folder happens to be open.
  private let sourcelessCacheDir: URL = {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    let dir =
      caches
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
  // Every write to `dataMemCache` also writes here; it is capped by its own
  // `countLimit` below (NSCache auto-evicts under memory
  // pressure as well, so the peek may return nil even for a key that was
  // recently stored — the `.task` async path always fills on a miss, which
  // then populates both caches for subsequent sync peeks).
  let syncPeekCache: NSCache<NSString, NSData> = {
    let c = NSCache<NSString, NSData>()
    // Hold enough that already-seen thumbnails aren't evicted while
    // browsing/zooming a large folder — eviction makes the sync peek miss
    // and flashes the placeholder on a repacked/rewindowed cell. AVIF
    // thumbnails are small; NSCache still purges under real memory pressure.
    c.countLimit = 2000
    return c
  }()

  // MARK: - Configure

  /// Prepare the open folder's `.maple/thumbs/`.
  public func configure(folderURL: URL) {
    let thumbDir = folderURL.appendingPathComponent(".maple").appendingPathComponent("thumbs")
    try? fm.createDirectory(at: thumbDir, withIntermediateDirectories: true)
  }

  // MARK: - Read

  /// Return a CIImage thumbnail for the given asset URL, or nil if not cached.
  public func thumbnail(for assetURL: URL) -> CIImage? {
    let key = Self.memoryKey(for: assetURL)
    // 1. Memory
    if let img = memCache[key] { return img }
    // 2. Disk
    guard let data = readThumb(at: thumbFileURL(for: assetURL), legacyKey: cacheKey(for: assetURL)),
      let ci = CIImage(data: data)
    else { return nil }
    // Promote to memory cache
    evictIfNeeded()
    memCache[key] = ci
    return ci
  }

  /// Return AVIF bytes for the given asset URL, or nil if not cached.
  /// Preferred entry-point for UI cells that render via `Image(data:)`.
  ///
  /// Does NOT delegate to `thumbnailData(forKey:)` (#2763): that overload
  /// reads from `sourcelessCacheDir`, right for a sourceless stable id and
  /// wrong for a URL-backed local asset, whose thumbnail lives in its own
  /// folder's `.maple/thumbs/`.
  public func thumbnailData(for assetURL: URL) -> Data? {
    let key = Self.memoryKey(for: assetURL)
    if let d = dataMemCache[key] { return d }
    guard let data = readThumb(at: thumbFileURL(for: assetURL), legacyKey: cacheKey(for: assetURL))
    else { return nil }
    evictIfNeeded()
    dataMemCache[key] = data
    syncPeekCache.setObject(data as NSData, forKey: key as NSString)
    return data
  }

  /// Evict an unreadable URL-backed thumbnail so `ThumbnailLoader` can
  /// rebuild the disposable derivative from the source image.
  public func removeThumbnail(for assetURL: URL) {
    let key = Self.memoryKey(for: assetURL)
    memCache.removeValue(forKey: key)
    dataMemCache.removeValue(forKey: key)
    syncPeekCache.removeObject(forKey: key as NSString)
    MapleSidecarPaths.removeDerivative(
      at: MapleSidecarPaths.thumbURL(for: assetURL),
      legacy: MapleSidecarPaths.legacyThumbURL(for: assetURL), fileManager: fm)
  }

  /// Return AVIF bytes for an opaque stable key (e.g. an `AssetRef.id` or a
  /// server-provided maple:id hex). Used by sourceless assets (PhotoKit,
  /// SelfHosted) with no filesystem URL, so no folder of their own.
  /// Note: pre-2026-05 this overload used MD5 of the key; it now uses
  /// `sha256Prefix16`, so any pre-existing entries at the old MD5 path are
  /// orphans.
  public func thumbnailData(forKey key: String) -> Data? {
    let hashed = hashKey(key)
    if let d = dataMemCache[hashed] { return d }
    let fileURL = sourcelessCacheDir.appendingPathComponent(
      MapleThumbCacheKey.thumbFilename(forKey: hashed))
    guard let data = readThumb(at: fileURL, legacyKey: hashed) else { return nil }
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
  /// Key derivation mirrors `thumbnailData(forKey:)`: pass the stable ID of a
  /// sourceless asset, the same input you would pass to
  /// `storeThumbnailData(_:forKey:)`. URL-backed assets use `syncPeekData(for:)`.
  public nonisolated func syncPeekData(forKey key: String) -> Data? {
    let hashed = MapleThumbCacheKey.sha256Prefix16(key)
    return syncPeekCache.object(forKey: hashed as NSString) as Data?
  }

  /// `syncPeekData(forKey:)` for a URL-backed asset, keyed the way its
  /// thumbnail was stored (`memoryKey(for:)`).
  public nonisolated func syncPeekData(for assetURL: URL) -> Data? {
    syncPeekCache.object(forKey: Self.memoryKey(for: assetURL) as NSString) as Data?
  }

  // MARK: - Write

  /// Store a CIImage thumbnail as AVIF (`ThumbnailEncoder.quality`).
  public func storeThumbnail(_ image: CIImage, for assetURL: URL) {
    let key = Self.memoryKey(for: assetURL)
    evictIfNeeded()
    memCache[key] = image

    let fileURL = thumbFileURL(for: assetURL, creatingDirectory: true)
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
  /// `thumbnailData(for:)`'s doc comment: the two write to different
  /// directories.
  public func storeThumbnailData(_ data: Data, for assetURL: URL) {
    let key = Self.memoryKey(for: assetURL)
    evictIfNeeded()
    dataMemCache[key] = data
    syncPeekCache.setObject(data as NSData, forKey: key as NSString)
    try? data.write(to: thumbFileURL(for: assetURL, creatingDirectory: true), options: .atomic)
  }

  /// Store pre-encoded AVIF bytes under an opaque stable key. Sibling of the
  /// URL-keyed overload — used for sourceless assets keyed by `AssetRef.id`.
  public func storeThumbnailData(_ data: Data, forKey key: String) {
    let hashed = hashKey(key)
    evictIfNeeded()
    dataMemCache[hashed] = data
    syncPeekCache.setObject(data as NSData, forKey: hashed as NSString)
    let fileURL = sourcelessCacheDir.appendingPathComponent(
      MapleThumbCacheKey.thumbFilename(forKey: hashed))
    try? data.write(to: fileURL, options: .atomic)
  }

  /// `<asset folder>/.maple/thumbs/<filename.ext>.avif`, the shared unhashed
  /// thumb name (#4793) in the asset's own folder (#5033).
  private func thumbFileURL(for assetURL: URL, creatingDirectory: Bool = false) -> URL {
    let fileURL = MapleSidecarPaths.thumbURL(for: assetURL)
    if creatingDirectory {
      try? fm.createDirectory(
        at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
    return fileURL
  }

  /// One read on a hit; on a miss, adopts the frozen `<legacyKey>.v25.avif`
  /// sibling by rename (#4793).
  private func readThumb(at fileURL: URL, legacyKey: String) -> Data? {
    MapleSidecarPaths.readDerivative(
      at: fileURL,
      legacy: fileURL.deletingLastPathComponent()
        .appendingPathComponent(MapleThumbCacheKey.legacyThumbFilename(forKey: legacyKey)),
      fileManager: fm)
  }

  // MARK: - Cache key

  /// Basename hash: names the frozen legacy thumb (`<key>.v25.avif`).
  public static func cacheKey(for url: URL) -> String {
    return MapleThumbCacheKey.sha256Prefix16(url.lastPathComponent)
  }

  nonisolated func cacheKey(for url: URL) -> String {
    return Self.cacheKey(for: url)
  }

  /// In-memory, sync-peek and coalescing key for a URL-backed asset: a
  /// full-path hash, so same-named files from two folders never share an entry
  /// and a file keeps one key whichever folder is open (#5033).
  public static func memoryKey(for url: URL) -> String {
    MapleThumbCacheKey.sha256Prefix16("path:" + url.standardizedFileURL.path)
  }

  /// File stem and memory key for a sourceless asset's opaque stable id.
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
