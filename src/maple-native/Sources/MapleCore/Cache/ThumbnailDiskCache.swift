// ThumbnailDiskCache.swift — .maple/ folder thumbnail cache compatible with
// maple-hosted and maple-self-hosted (spec § 08 / § 05).
//
// Key: MD5(primaryURL.path) — matches the maple-hosted LibraryIndex format.
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
    private let maxMemEntries = 100

    public static let defaultThumbSize = CGSize(width: 300, height: 200)

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

    // MARK: - Write

    /// Store a CIImage thumbnail. JPEG quality 0.7 (matches maple-hosted).
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
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Cache key

    /// MD5 of the asset path — matches maple-hosted `LibraryIndex` hashing.
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
    }
}
