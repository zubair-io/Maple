// ThumbnailLoader+NonRawSlowPath.swift — the slow-path fallback for non-RAW
// bitmaps (imported JPEG/PNG/HEIF, stitched pano PNGs) when the fast
// embedded-preview extraction in ThumbnailLoader.swift misses.
//
// Split from ThumbnailLoader.swift for the file-size budget. The entry
// point is called from `produceThumbnail` for any asset whose extension is
// in `NonRawImageExtensions.all` after the fast path returns nil.
//
// Camera RAWs without an embedded preview still route to
// `PipelineRenderer.render(rawPath:)`, which only understands RAW
// containers and throws on non-RAW input — that used to be the whole bug
// (#1366): any non-RAW file with no usable embedded thumbnail fell through
// to the RAW developer, threw, and the grid cell rendered blank. Non-RAW
// bitmaps carry demosaiced sRGB / Display-P3 pixels already, so a full
// ImageIO decode + CoreImage downscale is both correct and cheap — no Rust
// pipeline involvement needed.

import CoreImage
import Foundation
import ImageIO

extension ThumbnailLoader {
    /// Shared CIContext for the downscale-and-encode step below. Mirrors
    /// `displayPreviewCIContext` in `ThumbnailLoader+DisplayPreview.swift` —
    /// each split file gets its own instance rather than reaching across
    /// files for a `private` context.
    private static let nonRawSlowPathCIContext = CIContext()

    /// Full ImageIO decode of a non-RAW bitmap, downscaled to the 256px
    /// thumbnail long edge and AVIF-encoded.
    ///
    /// Unlike the fast path's `CGImageSourceCreateThumbnailAtIndex(...
    /// FromImageIfAbsent: true)`, this calls `CGImageSourceCreateImageAtIndex`
    /// for a full decode. Some PNGs/HEIFs fail ImageIO's thumbnail-generation
    /// routine (unusual ICC profiles, interlacing, non-baseline encodings)
    /// even though a plain decode succeeds — exactly the case that used to
    /// fall through to the RAW developer and throw. Returns nil only when
    /// ImageIO cannot decode the file at all.
    nonisolated static func nonRawSlowPathAVIF(at url: URL) -> Data? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let decodeOpts: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let cg = CGImageSourceCreateImageAtIndex(src, 0, decodeOpts as CFDictionary) else {
            return nil
        }

        // `CGImageSourceCreateImageAtIndex` does not bake in EXIF/TIFF
        // orientation the way `CGImageSourceCreateThumbnailAtIndex(...
        // WithTransform: true)` does for the fast path, so apply it
        // manually via `CIImage.oriented(_:)` — it reads the same raw
        // `kCGImagePropertyOrientation` values the TIFF/EXIF spec defines.
        var ci = CIImage(cgImage: cg)
        if let properties = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
            let rawOrientation = properties[kCGImagePropertyOrientation] as? UInt32,
            let orientation = CGImagePropertyOrientation(rawValue: rawOrientation)
        {
            ci = ci.oriented(orientation)
        }

        let target = ThumbnailDiskCache.defaultThumbSize.width
        let extent = ci.extent
        let longEdge = max(extent.width, extent.height)
        if longEdge > target {
            let scale = target / longEdge
            ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        return ThumbnailEncoder.encode(ci, ctx: nonRawSlowPathCIContext)
    }
}
