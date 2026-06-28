import Foundation

/// Single source of truth for resolving an asset's XMP sidecar URL.
///
/// Images use the classic **stem-swap** convention — `IMG_1.ARW` → `IMG_1.xmp`.
/// Videos KEEP their extension and append `.xmp` (**full-name**) — `clip.mov` →
/// `clip.mov.xmp`. This split is load-bearing for Apple Live Photos, which store
/// the still and the motion clip as two independent same-stem files
/// (`IMG_1234.HEIC` + `IMG_1234.MOV`). Under stem-swap both would resolve to
/// `IMG_1234.xmp` and clobber each other; full-name for the video gives it its
/// own `IMG_1234.MOV.xmp` and leaves the photo's sidecar untouched.
///
/// Mirrors the API's `xmpSidecarPath()` in `src/api/src/fs/xmp.ts` and its
/// video-extension list `VIDEO_EXTS` in `src/api/src/indexer/media-types.ts` so
/// a clip edited on Web and on Apple targets the SAME `.xmp` file. Existing
/// photo sidecars are NOT migrated — only video naming changes.
public enum SidecarPath {
    /// Video container extensions (lowercase, no dot). Mirror of the API's
    /// `VIDEO_EXTS`. Kept here rather than codegen'd because the list is small,
    /// rarely changes, and is not part of the color/schema single-sourcing.
    public static let videoExtensions: Set<String> = [
        "mov", "mp4", "m4v", "avi", "mkv", "webm", "mts", "m2ts", "3gp",
    ]

    /// True when `url`'s path extension names a recognised video container.
    /// Case-insensitive — `IMG_3087.MOV` and `clip.mov` both match.
    public static func isVideo(_ url: URL) -> Bool {
        videoExtensions.contains(url.pathExtension.lowercased())
    }

    /// Resolve the expected XMP sidecar URL for an asset's primary file.
    ///
    /// - Videos: append `.xmp`, preserving the original extension.
    /// - Everything else (RAW + bitmap images): swap the extension for `xmp`.
    public static func sidecarURL(for rawURL: URL) -> URL {
        if isVideo(rawURL) {
            return rawURL.appendingPathExtension("xmp")
        }
        return rawURL.deletingPathExtension().appendingPathExtension("xmp")
    }
}
