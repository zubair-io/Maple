// ThumbnailDecoder.swift — off-main, downsampling, decode-once thumbnail decode.
//
// The browse/grid surfaces used to decode thumbnail bytes to a `CGImage`
// *synchronously inside `ThumbnailImage.body`* (`CGImageSourceCreateWithData`
// + `CGImageSourceCreateImageAtIndex`). SwiftUI evaluates `body` on the main
// actor, so on a cold grid open N visible tiles each decoded their AVIF on the
// main thread back-to-back, and every subsequent body re-evaluation re-decoded
// the same bytes from scratch — the browse-grid lockup / scroll jank.
//
// Two things made it worse than "one decode per tile":
//   1. No decoded-image memoization: `body` re-runs constantly (state, scroll,
//      hover, overlay changes) and each run re-decoded.
//   2. `CGImageSourceCreateImageAtIndex` returns a *lazily* decoded image — the
//      actual pixel decode is deferred to draw time, which lands back on the
//      main thread during scroll.
//
// This decoder fixes all three: it decodes off the calling actor, forces an
// eager (non-lazy) downsampled bitmap via `CGImageSourceCreateThumbnailAtIndex`,
// and caches the result keyed on the encoded bytes so identical thumbnails are
// decoded exactly once across every cell and surface that requests them.
//
// Pure ImageIO/CoreGraphics — no SwiftUI, no platform (`AppKit`/`UIKit`) types —
// so it lives in MapleCore, compiles for every platform the package targets,
// and is exercised directly by `swift test` (`ThumbnailDecoderTests`).

import Foundation
import ImageIO
import CoreGraphics

/// Decodes encoded thumbnail bytes (AVIF/JPEG/PNG/…) into eagerly-decoded,
/// downsampled `CGImage`s off the main actor, memoizing by bytes.
public enum ThumbnailDecoder {

    /// Long-edge cap of the decoded bitmap, in pixels. The grid's stored thumbs
    /// are 512 px (2× the 256 px grid tier), so 512 preserves full fidelity for
    /// the largest grid cells while still forcing an eager, correctly-sized
    /// bitmap for smaller ones. A source already ≤ this is never upscaled.
    public static let maxPixelSize = 512

    /// Decoded-image cache, keyed on the encoded bytes. `NSCache` is thread-safe
    /// and evicts under memory pressure. Keyed on the bytes (not a per-asset id)
    /// so two surfaces showing the same asset — e.g. the browse grid and the
    /// filmstrip — share one decoded bitmap.
    private static let cache: NSCache<NSData, CGImage> = {
        let cache = NSCache<NSData, CGImage>()
        // A realized grid viewport is well under this; the cap just bounds the
        // decoded-bitmap footprint. NSCache also purges on memory pressure.
        cache.countLimit = 512
        return cache
    }()

    /// Decode `data` into an eagerly-decoded, downsampled `CGImage`, off the
    /// main actor, returning a cached instance when the same bytes were decoded
    /// before. Returns `nil` when the bytes are not a decodable image, or when
    /// the calling task has been cancelled.
    ///
    /// Call this from a view's `.task` (never from `body`). This function is
    /// `nonisolated async`, so by SE-0338 its body runs on the cooperative pool,
    /// NOT on the caller's actor — the synchronous `decodeSync` below therefore
    /// runs off the main thread without a `Task.detached`. Using a detached task
    /// here would be actively wrong: it is unstructured, so it would NOT inherit
    /// the caller's cancellation, and a fast scroll would spawn thousands of
    /// un-cancellable decodes that saturate the pool. Calling `decodeSync`
    /// directly keeps the decode structured, so a cell that scrolls off-screen
    /// (its `.task` cancelled) bails here instead of decoding a tile no longer
    /// on screen.
    public static func image(for data: Data) async -> CGImage? {
        let key = data as NSData
        if let cached = cache.object(forKey: key) { return cached }

        // Scrolled past before the decode started — don't burn a decode on a
        // tile that's no longer visible.
        guard !Task.isCancelled else { return nil }
        let decoded = decodeSync(data)

        if let decoded { cache.setObject(decoded, forKey: key) }
        return decoded
    }

    /// Convenience for the common `Data?` call site (bytes may still be
    /// loading): returns nil when `data` is nil, otherwise decodes as above.
    public static func image(for data: Data?) async -> CGImage? {
        guard let data else { return nil }
        return await image(for: data)
    }

    /// Synchronous, non-decoding peek into the decoded-image cache. Returns a
    /// decoded image only when these exact bytes were already decoded (e.g. the
    /// tile was on screen a moment ago and scrolled back); never decodes and
    /// never blocks. Lets a view render an already-decoded thumbnail on its very
    /// first frame instead of flashing a placeholder while `image(for:)` hops
    /// off-actor. Mirrors `ThumbnailProvider.cachedThumbnail`'s sync-peek role,
    /// one tier down (decoded bitmap vs. encoded bytes).
    public static func cachedImage(for data: Data) -> CGImage? {
        cache.object(forKey: data as NSData)
    }

    /// Synchronous eager + downsampled decode. Exposed for tests and for the
    /// rare synchronous caller; production view code should use `image(for:)`
    /// so decodes are cached and moved off the main thread.
    ///
    /// `CGImageSourceCreateThumbnailAtIndex` (as opposed to
    /// `…CreateImageAtIndex`) returns a fully-decoded bitmap rather than a
    /// lazily-decoded image, so no pixel decode is deferred to draw time.
    public static func decodeSync(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            // Always produce a thumbnail even when the source embeds none, and
            // cap its long edge — this is what downsamples large sources.
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            // Honour EXIF orientation so portrait thumbs aren't sideways.
            kCGImageSourceCreateThumbnailWithTransform: true,
            // Decode the pixels now (eager), not lazily at first draw.
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Full-resolution decode for the Preview tier, off the main actor and
    /// cancellation-aware. Like `image(for:)` this is `nonisolated async`, so
    /// the synchronous `decodeFullSync` below runs on the cooperative pool
    /// (SE-0338) rather than the caller's actor — no `Task.detached` needed,
    /// and cancellation propagates so a superseded page (prev/next swipe) stops
    /// decoding. Returns nil on a non-image or a cancelled caller.
    public static func decodeFull(_ data: Data) async -> CGImage? {
        guard !Task.isCancelled else { return nil }
        return decodeFullSync(data)
    }

    /// Decode `data` at **full resolution** (no downsample), eagerly. For the
    /// large single-image Preview tier, whose display-sized pixels (up to a few
    /// thousand px) must not be clamped to the grid's `maxPixelSize`. Eager
    /// (`kCGImageSourceShouldCacheImmediately`) so no pixel decode is deferred
    /// to draw time on the main thread — the same reason the thumbnail path is
    /// eager. Not memoized: previews are large and viewed one at a time, so a
    /// cache would only bloat memory. Prefer `decodeFull(_:)` from view code;
    /// this synchronous form is for callers that already run off-main.
    public static func decodeFullSync(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    }
}
