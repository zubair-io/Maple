// MaskRasterStore.swift — on-disk cache for bitmap-mask rasters (#3273, spec
// §6.1). PNG at `<directory>/<digest>.png`, generated on a cache miss and
// written back; a generate failure is never cached so the next call retries.
// `directory` is a `.maple/masks/` folder the caller resolves — this type has
// no opinion on library layout.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public actor MaskRasterStore {
    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public func cachedPath(digest: String) -> URL {
        directory.appendingPathComponent("\(digest).png")
    }

    /// Return the cached raster for `digest`, or run `generate` on a miss and
    /// cache the result. A thrown `generate` propagates without caching.
    /// `model` identifies the segmentation model/version that produced the
    /// raster — reserved for a future cache-key extension (spec §6.1 notes a
    /// model bump should invalidate old rasters); not yet folded into the
    /// path since only one model exists today.
    public func raster(
        for digest: String,
        model: String,
        generate: @Sendable () async throws -> (width: Int, height: Int, bytes: [UInt8])
    ) async throws -> (width: Int, height: Int, bytes: [UInt8]) {
        let path = cachedPath(digest: digest)
        if let cached = readPNG(at: path) {
            return cached
        }
        let fresh = try await generate()
        writePNG(fresh, to: path)
        return fresh
    }

    private func readPNG(at url: URL) -> (width: Int, height: Int, bytes: [UInt8])? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        let w = image.width, h = image.height
        guard
            let ctx = CGContext(
                data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = ctx.data else { return nil }
        let bytes = [UInt8](UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: w * h))
        return (w, h, bytes)
    }

    private func writePNG(_ raster: (width: Int, height: Int, bytes: [UInt8]), to url: URL) {
        guard
            let ctx = CGContext(
                data: nil, width: raster.width, height: raster.height, bitsPerComponent: 8,
                bytesPerRow: raster.width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        else { return }
        raster.bytes.withUnsafeBytes { ctx.data?.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        guard let image = ctx.makeImage(),
            let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { return }
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
    }
}
