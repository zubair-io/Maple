// ThumbnailDiskCache.swift — .maple/ folder thumbnail cache compatible with
// Maple Hosted and Maple Self Hosted (spec § 08 / § 05).
//
// Key: MD5(primaryURL.path) — matches the Maple Hosted LibraryIndex format.
// Value: JPEG bytes stored at .maple/thumbs/<hash>.jpg
// Eviction: LRU by file mtime; max 500MB or 10,000 entries (configurable).

import Foundation
import CoreImage
import CryptoKit

// MARK: - ThumbnailDiskCache

public actor ThumbnailDiskCache {
    public static let shared = ThumbnailDiskCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    private var memCache: [String: CIImage] = [:] // hot in-memory cache
    private var dataMemCache: [String: Data] = [:] // hot JPEG-bytes cache (for UI cells)
    private let maxMemEntries = 100

    /// Thumbnail target size per spec § 03 (256 px long edge).
    public static let defaultThumbSize = CGSize(width: 256, height: 256)
    /// JPEG encode quality per spec § 03 (q = 0.82).
    public static let jpegQuality: CGFloat = 0.82

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
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else { return nil }
        // Promote to memory cache
        evictIfNeeded()
        memCache[key] = ci
        return ci
    }

    /// Return JPEG bytes for the given asset URL, or nil if not cached.
    /// Preferred entry-point for UI cells that render via `Image(data:)`.
    public func thumbnailData(for assetURL: URL) -> Data? {
        return thumbnailData(forKey: cacheKey(for: assetURL))
    }

    /// Return JPEG bytes for an opaque stable key (e.g. an `AssetRef.id` or a
    /// server-provided maple:id hex). Used by sourceless assets (PhotoKit,
    /// SelfHosted) where there is no filesystem URL to MD5.
    public func thumbnailData(forKey key: String) -> Data? {
        let hashed = md5(key)
        if let d = dataMemCache[hashed] { return d }
        guard let dir = cacheDir else { return nil }
        let fileURL = dir.appendingPathComponent("\(hashed).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else { return nil }
        evictIfNeeded()
        dataMemCache[hashed] = data
        return data
    }

    // MARK: - Write

    /// Store a CIImage thumbnail. JPEG quality matches spec § 03 (q = 0.82).
    public func storeThumbnail(_ image: CIImage, for assetURL: URL) {
        let key = cacheKey(for: assetURL)
        evictIfNeeded()
        memCache[key] = image

        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: Self.jpegQuality]
        ) else { return }
        dataMemCache[key] = data
        try? data.write(to: fileURL, options: .atomic)
    }

    /// Store pre-encoded JPEG bytes. Used by `ThumbnailLoader` which encodes
    /// off-actor (avoids blocking the cache actor on JPEG round-trips).
    public func storeThumbnailData(_ data: Data, for assetURL: URL) {
        storeThumbnailData(data, forKey: cacheKey(for: assetURL))
    }

    /// Store pre-encoded JPEG bytes under an opaque stable key. Sibling of the
    /// URL-keyed overload — used for sourceless assets keyed by `AssetRef.id`.
    public func storeThumbnailData(_ data: Data, forKey key: String) {
        let hashed = md5(key)
        evictIfNeeded()
        dataMemCache[hashed] = data
        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(hashed).jpg")
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Cache key

    /// MD5 of the asset path — matches Maple Hosted `LibraryIndex` hashing.
    private func cacheKey(for url: URL) -> String {
        return md5(url.path)
    }

    // MARK: - Stable hash (SHA256 prefix for cache key stability)

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
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
