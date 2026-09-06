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
    public typealias Raster = (width: Int, height: Int, bytes: [UInt8])

    private let directory: URL
    /// Generation in progress per digest. Actor methods are reentrant at
    /// every `await`, so without this two concurrent misses for the same
    /// digest would both run the Vision workload and race the write
    /// (#3284 review).
    private var inFlight: [String: Task<Raster, Error>] = [:]

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
        generate: @escaping @Sendable () async throws -> Raster
    ) async throws -> Raster {
        let path = cachedPath(digest: digest)
        if let cached = Self.readPNG(at: path) {
            return cached
        }
        if let pending = inFlight[digest] {
            return try await pending.value
        }
        let task = Task<Raster, Error> {
            let fresh = try await generate()
            Self.writePNG(fresh, to: path)
            return fresh
        }
        inFlight[digest] = task
        defer { inFlight[digest] = nil }
        return try await task.value
    }

    private nonisolated static func readPNG(at url: URL) -> Raster? {
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

    /// Written to a sibling temp file and renamed into place, so a kill
    /// mid-write never leaves a truncated PNG that would poison every later
    /// read (#3284 review).
    private nonisolated static func writePNG(_ raster: Raster, to url: URL) {
        guard
            let ctx = CGContext(
                data: nil, width: raster.width, height: raster.height, bitsPerComponent: 8,
                bytesPerRow: raster.width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        else { return }
        raster.bytes.withUnsafeBytes { ctx.data?.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        guard let image = ctx.makeImage(),
            let dest = CGImageDestinationCreateWithURL(tmp as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { return }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: tmp)
            return
        }
        let fm = FileManager.default
        try? fm.removeItem(at: url)
        do {
            try fm.moveItem(at: tmp, to: url)
        } catch {
            try? fm.removeItem(at: tmp)
        }
    }
}
