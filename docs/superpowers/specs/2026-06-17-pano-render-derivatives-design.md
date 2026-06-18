# Pano render-time derivatives (thumbnail + preview) — design

**Ticket:** [#1365](https://github.com/zubair-io/Maple/issues/1365)
**Follow-up (out of scope):** [#1366](https://github.com/zubair-io/Maple/issues/1366) — general non-RAW lazy-thumbnail hardening
**Date:** 2026-06-17
**Scope:** Native (iPad / Mac) only. Reusable downscale/encode lives in the shared `maple-pano` core; the web/API stitch path is **not** wired in this change (it already produces thumb/preview via its indexer stages).

## Problem

Three user-reported issues after a native panorama merge, which collapse into one root cause + two derivatives:

1. **Phantom tile (bug).** The stitched pano shows in the Browse grid as a **blank grey ghost** next to the source images.
2. **Thumbnail (feature).** "After rendering the image, make a thumbnail and put it in the pano `.maple` dir."
3. **Preview (feature + question).** "Use the thumbnail to make a preview — are they too small?" — **Yes, far too small** (see below).

### Root cause (confirmed)

`BrowseViewModel.injectPanoResult(url:)` appends **exactly one** `AssetRef` (the two `PanoMergeView` call sites in `AppShell.swift` are in mutually-exclusive iPhone-tab vs iPad/Mac shells — no double-inject). The single tile renders blank because **nothing can produce a thumbnail for the pano**:

- The pano is a large **16-bit, non-RAW PNG** with no embedded preview JPEG.
- `ThumbnailLoader`'s fast path (`CGImageSourceCreateThumbnailAtIndex`) is unreliable on a freshly-written gigapixel 16-bit PNG (PNG is a single zlib stream — ImageIO must inflate the whole thing; multi-GB on iPad).
- The slow-path fallback is **RAW-only**: `PipelineRenderer.render(rawPath:)` tries to develop the PNG as a camera RAW, throws, returns `nil` → grey tile. (`Cache/ThumbnailLoader.swift:132`.)

So **#2 is the fix for #1**, and **#3 is the same move at a larger size**.

### Why a thumbnail can't double as a preview

A 256 px thumb is **6.25× too small per side / ~39× in area** vs a ~1600 px preview — it would look soft/blocky. The preview is rendered separately at **1600 px**.

## The folder + key contract (corrected after review)

Maple already has a **canonical, cross-platform** derivative layout shared by Apple / Web / API. Derivatives MUST land there — not in an ad-hoc per-file name.

```
<panoDir>/.maple/thumbs/<sha256prefix16(basename)>.jpg       # 256 px, JPEG q0.82, sRGB
<panoDir>/.maple/previews/<sha256prefix16(basename)>_1600.jpg # 1600 px, JPEG q0.85, sRGB
```

- `<panoDir>` = the pano PNG's own directory (today `<sourceParent>/Panoramas/`, or the App-Support fallback).
- `basename` = the pano filename **with** extension (e.g. `panorama-1750000000.png`).
- `sha256prefix16` = first 8 bytes of `SHA256(basename)` as lowercase hex. This is the **frozen** cross-platform key, single-sourced (by contract, not codegen) across:
  - Apple: `MapleThumbCacheKey.sha256Prefix16` (`FileProvider/MapleThumbCacheKey.swift`)
  - API: `src/api/src/fs/xmp.ts` `sha256Prefix16`
  - Web: `src/web/projects/maple-common/src/lib/maple-cache/sha.ts`
  - **New 4th copy:** Rust (`sha2` is already a `maple-pano` dep — `models.rs:50`). Guarded by a parity test (below).
- **Thumb** filename matches `ThumbnailDiskCache` exactly (`<key>.jpg`, no size suffix) so the existing cache lookup resolves it. **Preview** uses a `_1600` suffix to distinguish a *baked source preview* from `RenderedPreviewCache`'s render-param-keyed entries that also live under `.maple/previews/` (no collision: 16-hex+`_1600` vs MD5-composite keys).
- JPEG carries **no ICC profile**; bytes are already sRGB display-encoded (from `develop_for_display`), matching the existing sRGB assumption.
- **Never upscale:** if the pano's long edge ≤ a target, that derivative is written at native size.

### The subtlety the canonical layout creates

`ThumbnailDiskCache` and `RenderedPreviewCache` are **singletons configured for the currently-open folder** (`configure(folderURL:)` → `<openFolder>/.maple/{thumbs,previews}`). But a freshly-merged pano lives in the `Panoramas/` **subfolder**, and `injectPanoResult` shows it in the *open* folder's grid without reloading. So the singletons look in `<openFolder>/.maple/thumbs/`, while the pano's canonical thumb is in `<openFolder>/Panoramas/.maple/thumbs/` → a singleton miss.

Fix: the loaders fall back to an **asset-relative** lookup (derive `.maple/thumbs|previews` from the *asset's own* directory, not the configured folder). This is just the cache's "travels-with-the-photos" promise applied to the cross-folder case; for normally-browsed assets (`assetDir == openFolder`) the singleton hits first and the fallback never runs (zero overhead).

## Components

### 1. Rust core — `maple-pano/src/stitch/io.rs`

New, sibling to `develop_for_display`:

```rust
/// Write canonical .maple/thumbs + .maple/previews JPEG derivatives for the
/// pano at `png_path`, downscaled from the already-developed sRGB display
/// buffer (interleaved RGB16). Non-fatal: callers log + ignore Err.
pub fn write_display_sidecars(
    display: &[u16],   // same interleaved RGB16 buffer write_frame_png received
    width: u32,
    height: u32,
    png_path: &Path,
) -> std::io::Result<()>
```

- `key = sha256_prefix16(png_path.file_name())` via `sha2` (already a dep).
- For each `(target_long_edge, quality, subdir, name)`:
  - `("thumbs", "<key>.jpg", 256, 82)`
  - `("previews", "<key>_1600.jpg", 1600, 85)`
  - Compute `(tw, th)` preserving aspect, capped to native (no upscale).
  - `box_downsample_rgb16_to_rgb8(display, width, height, tw, th) -> Vec<u8>` — area-average straight from the borrowed `&[u16]` into a small RGB8 buffer. **No full-size clone** (avoids ~600 MB on a 100 MP pano); only the small output allocates.
  - `create_dir_all(<panoDir>/.maple/<subdir>)`, then JPEG-encode via `image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality)` + `encode(&rgb8, tw, th, ExtendedColorType::Rgb8)`.
- `image` 0.25 with the `jpeg` feature is already enabled — **no new crates**.
- A small `pub(crate) fn sha256_prefix16(name: &str) -> String` lives next to it (or in a shared module) so the algorithm has one Rust home.

### 2. Rust FFI — `raw-ffi/src/pano_apple.rs`

After the existing `write_frame_png(out_path, img.width(), img.height(), &data, &display_meta)`:

```rust
// data = develop_for_display(img); already in scope at pano_apple.rs:149-151
if let Err(e) = write_display_sidecars(&data, img.width(), img.height(), out_path) {
    // non-fatal: the pano itself succeeded; log and continue.
    log::warn!("pano derivative generation failed: {e}");
}
```

`write_display_sidecars` is imported alongside `develop_for_display` (both re-exported from `stitch/mod.rs`). The stitch's success/return value is unchanged — a derivative failure never fails a merge.

### 3. Swift — `ThumbnailLoader` asset-relative thumb fallback

In the miss-path detached task (after the security-scope claim, **before** the embedded fast path) at `Cache/ThumbnailLoader.swift`:

```swift
// Asset-relative canonical thumb — found even when the singleton cache is
// configured for a different (parent) folder, e.g. an injected pano in Panoramas/.
let key = MapleThumbCacheKey.sha256Prefix16(assetURL.lastPathComponent)
let relThumb = assetURL.deletingLastPathComponent()
    .appendingPathComponent(".maple/thumbs/\(key).jpg")
if FileManager.default.fileExists(atPath: relThumb.path),
   let data = try? Data(contentsOf: relThumb) {
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL) // seed singleton
    return data
}
```

Reuses the **existing** `MapleThumbCacheKey` — no invented naming. Cost: one `fileExists` per cold load *only when the singleton already missed*; on hit it seeds the singleton so later loads short-circuit at step 1.

### 4. Swift — `EditSession` seeds the preview on cold-open

New `seedFromMapleSidecarPreview(for:)` in `EditSession+Hydration.swift`, mirroring `seedFromEmbeddedPreview` exactly (read JPEG → `CIImage` under security scope → `renderActor.seedIfUnpopulated(...)` → publish to `renderedPreview` if accepted). It reads the asset-relative `.maple/previews/<sha256prefix16(basename)>_1600.jpg`.

Slotted into the hydration sequence (`EditSession+Hydration.swift:221-234`) **after** `seedFromCachedPreview` and **before** `seedFromEmbeddedPreview`:

```
cached preview (RenderedPreviewCache, best)  →  .maple/previews baked preview (our 1600 px)  →  embedded JPEG (none for a pano)
```

The existing `seedIfUnpopulated` atomicity guard means a preceding cache seed is never downgraded.

### 5. Cross-language key parity test

A test asserting the Rust `sha256_prefix16("panorama-test.png")` equals the known Swift/API value (hardcode the expected 16-hex digest; assert in both a Rust unit test and a Swift `MapleThumbCacheKey` test). Guards the 4th copy of the frozen algorithm against drift.

## Data flow

```
RustPanoStitcher.stitch (FFI)
  → composite → develop_for_display → write_frame_png(<panoDir>/<stem>.png)
  → write_display_sidecars(data):
       <panoDir>/.maple/thumbs/<key>.jpg          (key = sha256prefix16(<stem>.png))
       <panoDir>/.maple/previews/<key>_1600.jpg
PanoMergeView.onComplete → BrowseViewModel.injectPanoResult(url)
  → grid tile → ThumbnailLoader.load(url)
       → singleton miss (configured for open folder)
       → asset-relative .maple/thumbs/<key>.jpg HIT → tile renders (was grey); singleton seeded
Open pano → EditSession hydration
  → cached-preview miss → seedFromMapleSidecarPreview reads .maple/previews/<key>_1600.jpg
       → instant fast-phase → full non-RAW develop refines
```

## Memory & security scope

- **Memory:** the downsampler reads the borrowed `&[u16]`; only the small (≤1600 px) outputs allocate. No gigapixel clone, no re-decode of the PNG. Safe on iPad.
- **Scope:** derivatives live under the pano's own directory, so the same security-scoped access that lets the app read the pano (and that wrote it) covers them. Reads in `ThumbnailLoader` and `seedFromMapleSidecarPreview` happen inside the existing scope claim (`scopeParentURL ?? url.deletingLastPathComponent()`).

## Error handling

- Derivative generation is **non-fatal** to the merge; failures are logged.
- Missing/corrupt derivative → readers fall back to today's behavior (fast/slow thumbnail path; develop-only cold-open). No crash, no regression for RAWs.

## Testing

- **Rust (`maple-pano`):** unit test for `write_display_sidecars` — synthesize a small display buffer (e.g. 800×400 gradient), assert both derivatives exist at the canonical `.maple/thumbs|previews/<key>...` paths, decode via `image`, have the expected long edges (256; preview stays native at 800 since < 1600 — proves no-upscale), and round-trip approximately to the gradient. Plus the `sha256_prefix16` parity test (Component 5). Co-located with the `develop_for_display` tests.
- **Swift (MapleCore):** `MapleThumbCacheKey` parity value; `ThumbnailLoader` returns the asset-relative thumb when a temp file has `.maple/thumbs/<key>.jpg` in its own dir while the singleton is configured elsewhere; `seedFromMapleSidecarPreview` file-read unit.
- **Manual (Apple not in cloud CI — verify locally per `project_apple_not_gated_by_cloud_ci`):** `swift test` in `Packages/MapleCore`; build + run on Mac, merge a pano, confirm the tile is no longer grey and cold-open shows the preview instantly. Optionally device-verify on iPad.

## Alternatives considered

- **FFI returns the downscaled bytes; Swift writes the caches.** Keeps cache-key knowledge entirely in Swift, but adds out-param/buffer-free FFI surface for no real gain — Rust writing the canonical files directly reuses the existing "stitch writes files to a path" contract. The frozen `sha256prefix16` is already replicated in 3 languages; a 4th + parity test is consistent with that precedent.
- **Per-file sidecar name (`<stem>.thumb.jpg`).** Rejected on review — it's a new folder *and* a new key, ignoring the canonical cross-platform `.maple/thumbs|previews/<sha256prefix16>` layout. (This was the first draft of this spec.)

## Out of scope / follow-up

- **#1366** — make the `ThumbnailLoader` slow path develop any non-RAW (JPEG/PNG/HEIF) via ImageIO instead of routing everything through the RAW developer. This change fixes the pano case at render time; #1366 is the general defensive fix for the lazy path.
