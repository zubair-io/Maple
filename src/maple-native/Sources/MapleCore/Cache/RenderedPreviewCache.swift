// RenderedPreviewCache.swift — Per-asset JPEG preview cache.
//
// Key components (per spec § 05):
//   primaryURL hash (MD5)
//   sidecar mtime (XMP last-modified timestamp)
//   screen size (integer width class)
//   viewTransformVersion (AGX_VERSION = 2)
//
// Storage: .maple/previews/<key>.jpg
// Entries are invalidated on any key component change.

import Foundation
import CoreImage
import CryptoKit

// MARK: - RenderedPreviewCache

public actor RenderedPreviewCache {
    public static let shared = RenderedPreviewCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    private var memCache: [String: (CIImage, Date)] = [:]  // (image, stored-at)
    private let maxMemEntries = 20

    // Must match agx_coeffs.rs AGX_VERSION (2) — bump here when LUT changes.
    private let viewTransformVersion: UInt32 = 2

    // MARK: - Configure

    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let previewDir = mapleDir.appendingPathComponent("previews")
        try? fm.createDirectory(at: previewDir, withIntermediateDirectories: true)
        cacheDir = previewDir
    }

    // MARK: - Read

    public func preview(for assetURL: URL, screenWidth: Int) -> CIImage? {
        let key = cacheKey(for: assetURL, screenWidth: screenWidth)
        // Memory
        if let (img, _) = memCache[key] { return img }
        // Disk
        guard let dir = cacheDir else { return nil }
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else { return nil }
        evictIfNeeded()
        memCache[key] = (ci, Date())
        return ci
    }

    // MARK: - Write

    public func storePreview(_ image: CIImage, for assetURL: URL, screenWidth: Int) {
        let key = cacheKey(for: assetURL, screenWidth: screenWidth)
        evictIfNeeded()
        memCache[key] = (image, Date())

        guard let dir = cacheDir else { return }
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.90]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Invalidate

    /// Remove all cached entries for an asset (call after sidecar write).
    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        // Remove all screen-width variants
        let prefix = urlHash(assetURL.path)
        memCache = memCache.filter { !$0.key.hasPrefix(prefix) }
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    // MARK: - Cache key

    private func cacheKey(for url: URL, screenWidth: Int) -> String {
        let sidecarMtime = sidecarMtimeString(for: url)
        let components = "\(urlHash(url.path))_\(sidecarMtime)_\(screenWidth)_v\(viewTransformVersion)"
        return md5(components)
    }

    private func sidecarMtimeString(for assetURL: URL) -> String {
        let sidecar = assetURL.deletingPathExtension().appendingPathExtension("xmp")
        guard let attrs = try? fm.attributesOfItem(atPath: sidecar.path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { md5(path).prefix(16).description }

    // MARK: - Eviction

    private func evictIfNeeded() {
        while memCache.count >= maxMemEntries {
            // Evict oldest
            if let oldest = memCache.min(by: { $0.value.1 < $1.value.1 }) {
                memCache.removeValue(forKey: oldest.key)
            } else { break }
        }
    }

    // MARK: - Hash (SHA256 prefix for key stability)

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
