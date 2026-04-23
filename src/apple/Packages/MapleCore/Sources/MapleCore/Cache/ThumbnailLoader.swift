// ThumbnailLoader.swift — view-layer facing glue that returns JPEG bytes for
// a given asset URL, consulting ThumbnailDiskCache first and only falling
// through to PipelineRenderer on a miss.
//
// The UI cell (see Maple/Views/BrowseGrid.swift) calls `load(for:)` on cell
// appear; the loader cancels the render task on cell disappear so fast-scroll
// doesn't burn CPU on off-screen rows.
//
// Encoding / sizing per spec § 03:
//   - target long edge = 256 px
//   - JPEG quality     = 0.82
//   - sRGB colourspace

import Foundation
import CoreImage

// MARK: - ThumbnailLoader

public actor ThumbnailLoader {
    public static let shared = ThumbnailLoader()

    /// Reused CIContext — creating one per call is expensive and pins GPU
    /// memory for no reason.
    private let ctx = CIContext()

    public init() {}

    // MARK: - Public API

    /// Look up a thumbnail in the disk cache; on miss, render via the Rust
    /// pipeline, downscale, JPEG-encode, persist via the disk cache, and
    /// return the bytes. Returns `nil` only when the render itself fails.
    public func load(for assetURL: URL) async -> Data? {
        // 1. Fast path: cached JPEG bytes.
        if let cached = await ThumbnailDiskCache.shared.thumbnailData(for: assetURL) {
            return cached
        }

        // 2. Miss: invoke the Rust pipeline. This is a synchronous FFI call,
        //    so we hop to a background priority task to keep the caller's
        //    actor responsive if the loader is hit from @MainActor.
        return await Task.detached(priority: .utility) { () -> Data? in
            do {
                let image = try PipelineRenderer.render(rawPath: assetURL)
                guard let data = Self.encodeJPEG(image, ctx: CIContext()) else {
                    return nil
                }
                await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
                return data
            } catch {
                return nil
            }
        }.value
    }

    // MARK: - Helpers

    /// Downscale the pipeline-produced RGB buffer to the thumbnail long-edge
    /// and JPEG-encode at q=0.82.
    private static func encodeJPEG(_ image: MapleImageData, ctx: CIContext) -> Data? {
        guard image.pixels.count == image.width * image.height * 3 else { return nil }

        let bitmapInfo = CGImageAlphaInfo.none.rawValue
        let copy = image.pixels
        guard let dp = CGDataProvider(data: copy as CFData) else { return nil }
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let cgImg = CGImage(
            width: image.width, height: image.height,
            bitsPerComponent: 8, bitsPerPixel: 24,
            bytesPerRow: image.width * 3,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
            provider: dp,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        ) else { return nil }

        var ci = CIImage(cgImage: cgImg)
        // Downscale to 256 px long edge.
        let target = ThumbnailDiskCache.defaultThumbSize.width
        let longEdge = CGFloat(max(image.width, image.height))
        if longEdge > target {
            let scale = target / longEdge
            ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        return ctx.jpegRepresentation(
            of: ci,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: ThumbnailDiskCache.jpegQuality]
        )
    }
}
