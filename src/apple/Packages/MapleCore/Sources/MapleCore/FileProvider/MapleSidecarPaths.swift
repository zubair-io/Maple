// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/io.rs::write_display_sidecars` (#1365).

import Foundation

public enum MapleSidecarPaths {
    /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.avif`
    public static func thumbURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        // Append each component separately (matches ThumbnailDiskCache.configure
        // / RenderedPreviewCache.configure) — avoids slash-in-component edge cases.
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple")
            .appendingPathComponent("thumbs")
            .appendingPathComponent("\(key).avif")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.jpg`
    public static func previewURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple")
            .appendingPathComponent("previews")
            .appendingPathComponent("\(key)_1600.jpg")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.v` — the
    /// render-version marker for the display-preview tier (#1976). The JPEG
    /// filename is a cross-consumer contract (the pano stitcher writes it,
    /// the Self-Hosted API serves it), so the tier versions via this sibling
    /// marker instead of the key — the same pattern as the web thumb cache's
    /// `.v` marker (#1928). A preview whose marker is missing or older than
    /// `ThumbnailLoader.displayPreviewTierVersion` reads as stale: it may
    /// have been persisted from a render with since-fixed semantics (the
    /// #1976 cyan-anchored renders had no marker at all).
    public static func previewVersionURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple")
            .appendingPathComponent("previews")
            .appendingPathComponent("\(key)_1600.v")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.edited.jpg`
    /// — Apple's LOCAL-ONLY developed/edited-render preview (#2009).
    ///
    /// Deliberately a distinct filename from `previewURL`, never written by
    /// anything other than Apple's own render-publish path
    /// (`ThumbnailLoader.updateDisplayPreviewFromRender`). `previewURL` is
    /// the shared, cross-consumer contract for the IMMUTABLE camera-original
    /// preview — the Self-Hosted API's describe/OCR (VLM) pipeline reads it
    /// as "the camera-original preview" for a third-party model. An earlier
    /// draft of this epic's design let edited pixels land there; that was a
    /// confirmed correctness-AND-privacy bug, not just a caching bug, which
    /// is why this tier gets its own name instead of reusing `previewURL`.
    /// `cache-gc.ts`'s previews sweep recognizes this exact scheme as a
    /// legitimate third naming convention (mirroring the pano pre-seed
    /// carve-out), the same way `MapleSidecarPaths` mirrors that scheme on
    /// the read side.
    public static func editedPreviewURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple")
            .appendingPathComponent("previews")
            .appendingPathComponent("\(key)_1600.edited.jpg")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.edited.v`
    /// — the sidecar-state freshness marker for `editedPreviewURL` (#2009).
    ///
    /// Unlike `previewVersionURL` (which tracks the display-preview tier's
    /// RENDER-SEMANTICS version — an integer bumped when the JPEG-production
    /// code changes), this marker tracks EDIT SIDECAR STATE: it must
    /// invalidate whenever the sidecar changes (a new slider value, a new
    /// crop, a revert), independent of any tier-version bump. Those are two
    /// separate invalidation triggers — see
    /// `ThumbnailLoader.editedPreviewMarkerIsCurrent(for:)`.
    public static func editedPreviewMarkerURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple")
            .appendingPathComponent("previews")
            .appendingPathComponent("\(key)_1600.edited.v")
    }
}
