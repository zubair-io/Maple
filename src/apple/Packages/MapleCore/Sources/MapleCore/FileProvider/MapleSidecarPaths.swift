// MapleSidecarPaths.swift — asset-relative locations of the canonical
// `.maple/{thumbs,previews}/` derivative cache, computed from an asset's own
// directory (not a singleton's configured folder). This is what lets an
// injected pano — which lives in a `Panoramas/` subfolder while the cache
// singletons are configured for the open folder — resolve its render-time
// derivatives. Mirrors the Rust writer in
// `maple-pano/src/stitch/io.rs::write_display_sidecars` (#1365).

import Foundation

public enum MapleSidecarPaths {
    /// `<assetDir>/.maple/thumbs/<sha256prefix16(basename)>.jpg`
    public static func thumbURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple/thumbs/\(key).jpg")
    }

    /// `<assetDir>/.maple/previews/<sha256prefix16(basename)>_1600.jpg`
    public static func previewURL(for assetURL: URL) -> URL {
        let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
        return assetURL.deletingLastPathComponent()
            .appendingPathComponent(".maple/previews/\(key)_1600.jpg")
    }
}
