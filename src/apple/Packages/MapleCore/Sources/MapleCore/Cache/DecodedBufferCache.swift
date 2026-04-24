// DecodedBufferCache.swift — Per-asset disk cache for the Rust pipeline's
// decoded output (pre-adjustment). Paired with RenderedPreviewCache:
//   • RenderedPreviewCache caches POST-adjustment JPEG keyed on sidecar mtime.
//   • DecodedBufferCache caches PRE-adjustment JPEG keyed on asset file mtime.
//
// Storage: <folder>/.maple/decoded/<hash>.jpg. Cache hit lets EditSession
// skip the full Rust pipeline — the CIFilter chain in ImageEditPipeline
// runs against the cached decoded buffer instead.

import Foundation
import CoreImage
import CryptoKit

public actor DecodedBufferCache {
    public static let shared = DecodedBufferCache()

    private let fm = FileManager.default
    private var cacheDir: URL?
    // Bump this when raw-core pipeline output changes meaning (e.g. colour
    // math changes, demosaic quality toggled, output format changes) — the
    // version is part of the cache key so stale entries are silently
    // ignored and overwritten.
    private let rustVersion: UInt32 = 2

    public init() {}

    public func configure(folderURL: URL) {
        let mapleDir = folderURL.appendingPathComponent(".maple")
        let decodedDir = mapleDir.appendingPathComponent("decoded")
        try? fm.createDirectory(at: decodedDir, withIntermediateDirectories: true)
        cacheDir = decodedDir
    }

    public func decoded(for assetURL: URL) -> CIImage? {
        guard let dir = cacheDir else { return nil }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        guard fm.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL),
              let ci = CIImage(data: data) else { return nil }
        return ci
    }

    public func storeDecoded(_ image: CIImage, for assetURL: URL) {
        guard let dir = cacheDir else { return }
        let key = cacheKey(for: assetURL)
        let fileURL = dir.appendingPathComponent("\(key).jpg")
        let ctx = CIContext()
        guard let data = ctx.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
        ) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    public func invalidate(assetURL: URL) {
        guard let dir = cacheDir else { return }
        let prefix = urlHash(assetURL.path)
        let files = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(f))
        }
    }

    private func cacheKey(for url: URL) -> String {
        let mtime = assetMtimeString(for: url)
        let components = "\(urlHash(url.path))_\(mtime)_v\(rustVersion)"
        return md5(components)
    }

    private func assetMtimeString(for url: URL) -> String {
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let mtime = attrs[.modificationDate] as? Date else { return "0" }
        return String(Int64(mtime.timeIntervalSince1970 * 1000))
    }

    private func urlHash(_ path: String) -> String { md5(path).prefix(16).description }

    private func md5(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
