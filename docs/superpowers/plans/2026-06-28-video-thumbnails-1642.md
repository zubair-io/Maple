# Video Poster Thumbnails (#1642) — Design Note

This change gives video assets a real poster-frame thumbnail in the Browse grid on Apple (macOS / iOS / iPadOS). Before it, #1638 made standalone videos selectable so their metadata could be edited, but the thumbnail layer skipped them and the grid showed a placeholder. The scope here is grid poster thumbnails only — there is no playback or scrubbing.

## What changed on Apple

`ThumbnailLoader` now extracts a poster frame for any asset that `SidecarPath.isVideo` recognizes. The extraction lives in a new `posterJPEG(at:)` helper that uses `AVAssetImageGenerator`. It requests a frame at roughly one second in; for clips shorter than a second the requested time is clamped to the asset's loaded duration so the generator returns the final frame instead of failing. `appliesPreferredTrackTransform` is set so portrait clips are not served sideways, and `maximumSize` caps decode at twice the thumbnail target so a sharp downscale is produced without decoding the full native-resolution frame. The result is encoded through the same `jpegData(from:ctx:)` path and JPEG quality (0.82) used by the still-image thumbnail, and stored in `ThumbnailDiskCache` under the same `sha256prefix16(basename)` key scheme as image thumbs — so `.maple/thumbs/<hash>.jpg` resolution, cross-app cache sharing, and the synchronous peek path all work unchanged.

The helper is `async` and uses the non-blocking `AVAssetImageGenerator.image(at:)` API rather than the synchronous `copyCGImage`. The synchronous call would block a cooperative-pool thread for the duration of the decode; several posters generated at once during a grid scroll would block multiple threads and risk starving the pool. The async form suspends instead. The encode reuses a shared static `CIContext` because `CIContext` is heavyweight to allocate and is safe to share.

## Crash-safe placement

The video branch sits inside the loader's detached load task, after the asset-relative `.maple/thumbs` cache lookup (so a previously written poster is served from disk without touching AVFoundation again) and before the `CGImageSourceCreateThumbnailAtIndex` fast path. This ordering guarantees video container bytes are never fed to ImageIO or the libraw RAW decoder — the same crash-safety invariant the thumb stage, preview stage, and `AssetRef.isRaw` short-circuit already enforce for videos.

## Server-side deferral

The web grid still gets thumbnails from `/api/thumb/...`, which continues to return 404 for video assets. The API has no video frame extraction capability: `sharp` and `heic-convert` handle only still images, the `libraw_ffi` pool is RAW-only, and there is no ffmpeg/ffprobe dependency in `package.json`. Bundling a frame extractor (a platform ffmpeg shell-out or a WASM video decoder) is a heavier change than this polish ticket should carry, so the server-side poster is deferred to a tracked follow-up, #1649. The route's 404 comment points at that ticket; the grid renders its existing video placeholder on the 404. AVFoundation is always present on Apple platforms, which is why the Apple poster ships now and the server one is staged separately.

## Tests

`VideoThumbnailTests` writes a deterministic single-frame 64×64 H.264 `.mov` via `AVAssetWriter` (the pixel buffer is zeroed to opaque black, and the adaptor append is asserted so a failed write fails the fixture loudly). It covers four behaviors: the poster path returns JPEG bytes, the poster is written to the `.maple/thumbs` location, a second load returns the cached bytes, and a missing non-video file still returns nil. The tests are skip-safe if `AVAssetWriter` is unavailable.

Files touched: `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/ThumbnailLoader.swift` (poster path), `src/apple/Packages/MapleCore/Tests/MapleCoreTests/VideoThumbnailTests.swift` (new), and a one-line comment in `src/api/src/routes/library/thumb.ts` documenting the #1649 deferral.
