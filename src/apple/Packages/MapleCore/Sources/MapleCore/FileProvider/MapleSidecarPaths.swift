// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/io.rs::write_display_sidecars` (#1365).

import Foundation

public enum MapleSidecarPaths {
    /// Name of the per-folder derivative directory every cache below lives
    /// in. Internal library state, never user content: enumeration sites
    /// (`FolderTreeRow`, `SMBFileOperations.listSubdirectories`,
    /// `DropMountPlanner`) must exclude it rather than surface it as an
    /// ordinary browsable folder.
    public static let derivativeDirectoryName = ".maple"

    /// Whether `url` IS a `.maple` derivative directory, or lives anywhere
    /// inside one (`<lib>/.maple/trash/IMG.dng` → `true`). Component-wise
    /// match, so a user folder that merely CONTAINS the text — `.maplestuff`
    /// — is not mistaken for it.
    public static func isInsideDerivativeDirectory(_ url: URL) -> Bool {
        url.standardizedFileURL.pathComponents.contains(derivativeDirectoryName)
    }

    /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.avif`
    public static func thumbURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        // Append each component separately (matches ThumbnailDiskCache.configure
        // / RenderedPreviewCache.configure) — avoids slash-in-component edge cases.
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(derivativeDirectoryName)
            .appendingPathComponent("thumbs")
            .appendingPathComponent("\(key).avif")
    }

    /// `<assetDir>/.maple/previews/<filename>.avif` — the canonical
    /// cross-platform display-preview file (#2009, epic #1993 "KISS preview
    /// redesign"). `<filename>` is the ORIGINAL filename *including* its
    /// extension, e.g. `IMG_1234.CR2` → `IMG_1234.CR2.avif`. Server, Apple, and
    /// Web all resolve this exact path so a preview written by one is read by
    /// the others.
    ///
    /// Deliberately unhashed and token-free — no `<sha256prefix16>`, no
    /// `_1600` size token, no `.v` version marker. The filename itself is the
    /// version boundary: changing the scheme (from the old
    /// `<sha256prefix16>_1600.jpg`) retires every pre-#2009 preview because the
    /// new reader simply never looks at the old path. The preview is a pure
    /// cache — overwritten in place, never an original, always re-derivable
    /// (unedited = camera embedded preview; edited = developed RAW+XMP render).
    ///
    /// Thumbs keep their `<sha256prefix16(basename)>.avif` scheme
    /// (`thumbURL` above) — this simplification is previews-only.
    public static func previewURL(for assetURL: URL) -> URL {
        // Append each component separately — avoids slash-in-component edge
        // cases (matches `thumbURL`).
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(derivativeDirectoryName)
            .appendingPathComponent("previews")
            .appendingPathComponent("\(assetURL.lastPathComponent).avif")
    }
}
