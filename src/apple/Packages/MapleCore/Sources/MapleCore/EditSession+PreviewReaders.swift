// EditSession+PreviewReaders.swift — nonisolated cold-open preview readers.
//
// Split from EditSession+Hydration.swift (#2009, file-size budget): the
// synchronous/nonisolated decode helpers `seedFromEmbeddedPreview` and
// `seedFromMapleSidecarPreview` in that file call through to these, but the
// readers themselves touch no actor-isolated state, so they live in their
// own file rather than pushing EditSession+Hydration.swift over budget.

import CoreImage
import Foundation
import ImageIO

// MARK: - Embedded preview reader (nonisolated)

extension EditSession {
    /// Read the render-time baked preview for an asset and decode it to a
    /// `CIImage`. Asset-relative (resolves next to the asset, e.g. a pano in
    /// `Panoramas/`). Returns nil when absent. (#1365.) Prefers the LOCAL
    /// edited/developed render when fresh, falling back to the shared
    /// camera-original tier — see `ThumbnailLoader.freshEditedPreviewData`
    /// (#2009).
    nonisolated static func readMapleSidecarPreview(from url: URL) -> CIImage? {
        if let edited = ThumbnailLoader.freshEditedPreviewData(for: url) {
            return CIImage(data: edited)
        }
        let preview = MapleSidecarPaths.previewURL(for: url)
        // #1976: cyan-era previews carry no tier-version marker — skip.
        guard ThumbnailLoader.displayPreviewMarkerIsCurrent(for: url),
            FileManager.default.fileExists(atPath: preview.path),
            let data = try? Data(contentsOf: preview)
        else { return nil }
        return CIImage(data: data)
    }

    /// Extract the camera's embedded JPEG preview via ImageIO. Returns a
    /// CIImage at up to 2048 px long edge — enough to look sharp in the
    /// editor's viewport without paying full-resolution decode cost.
    nonisolated static func readEmbeddedPreview(from url: URL) -> CIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        // `FromImageIfAbsent: false` means we only return the camera's
        // pre-baked preview. When a RAW has no embedded preview (rare, but
        // happens with ProRAW passthrough and some synthetic DNGs), ImageIO
        // would otherwise full-decode the Bayer data to synthesize one —
        // which defeats the whole point of this "fast" path. Returning nil
        // lets the caller fall through to the real Rust decode instead.
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: false,
            kCGImageSourceCreateThumbnailFromImageIfAbsent: false,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return nil
        }
        return CIImage(cgImage: cg)
    }
}
