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
- `ThumbnailLoader`'s fast path (`CGImageSourceCreateThumbnailAtIndex`) is unreliable on a freshly-written gigapixel 16-bit PNG.
- The slow-path fallback is **RAW-only**: `PipelineRenderer.render(rawPath:)` tries to develop the PNG as a camera RAW, throws, returns `nil` → grey tile. (`Cache/ThumbnailLoader.swift:132`.)

So **#2 is the fix for #1**, and **#3 is the same move at a larger size**.

### Why a thumbnail can't double as a preview

| Artifact | Long edge | Pixels | Source |
| --- | --- | --- | --- |
| Thumbnail | 256 px | 65 k | `ThumbnailDiskCache.defaultThumbSize` |
| Preview (Apple rendered) | ~1600 px | ~2.6 M | viewport-res cold-open |

A 256 px thumb is **6.25× too small per side / ~39× in area** to stand in for a preview — it would look soft/blocky. The preview is rendered separately at **1600 px**.

## Goals

- Native pano tiles show a correct thumbnail immediately after merge and across sessions.
- A pano opens with an instant fast-phase preview instead of waiting for the full gigapixel develop.
- Derivatives are **portable `.maple` sidecars** co-located with the pano, surviving OS-cache eviction, aligned with the web/API `.maple` convention.
- Generated **at stitch time from the already-developed display buffer** — no re-decode of the gigapixel PNG (the memory-risky path on iPad).

## Non-goals

- Web/API stitch path (deferred; it already runs thumbnailer/previewer indexer stages).
- General non-RAW lazy-thumbnail hardening for imported JPEG/PNG/HEIF → **#1366**.
- Any change to the pano pixels, the `.png` output, EXIF, or color (those landed in #1344/#1349).

## The `.maple` sidecar contract

For a pano written to `<dir>/<stem>.png` (today `<sourceParent>/Panoramas/panorama-<ts>.png`, or the App-Support fallback):

```
<dir>/.maple/<stem>.thumb.jpg     # 256 px long edge, JPEG q0.82, sRGB
<dir>/.maple/<stem>.preview.jpg   # 1600 px long edge, JPEG q0.85, sRGB
```

- `<stem>` = pano filename without extension.
- JPEG carries **no ICC profile**; the bytes are already sRGB display-encoded (from `develop_for_display`), so consumers interpret them as sRGB — matching `ThumbnailLoader`'s existing sRGB assumption.
- **Never upscale:** if the pano's long edge ≤ a target, the sidecar is written at native size.
- Path is computed identically on both sides (Rust writer, Swift readers) so they always agree.

## Components

### 1. Rust core — `maple-pano/src/stitch/io.rs`

New, sibling to `develop_for_display`:

```rust
/// Write 256 px thumb + 1600 px preview JPEG sidecars next to `png_path`
/// under a `.maple/` dir, downscaled from the already-developed sRGB
/// display buffer (interleaved RGB16). Non-fatal: callers log + ignore Err.
pub fn write_display_sidecars(
    display: &[u16],   // same interleaved RGB16 buffer write_frame_png received
    width: u32,
    height: u32,
    png_path: &Path,
) -> std::io::Result<()>
```

Implementation notes:
- For each `(target_long_edge, quality)` in `[(256, 82), (1600, 85)]`:
  - Compute `(tw, th)` preserving aspect, capped to native (no upscale).
  - `box_downsample_rgb16_to_rgb8(display, width, height, tw, th) -> Vec<u8>` — area-average straight from the borrowed `&[u16]` slice into a small RGB8 buffer. **No full-size clone** (avoids a ~600 MB allocation on a 100 MP pano); only the small output is allocated.
  - JPEG-encode the small buffer with `image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality)` + `encode(&rgb8, tw, th, ExtendedColorType::Rgb8)`.
- `create_dir_all(<dir>/.maple)` first.
- `image` is already a `maple-pano` dependency — **no new crates**.
- Box-average is near-optimal for the large downscale ratios here; a two-step box→Lanczos refine is a possible future quality bump, noted but not built.

### 2. Rust FFI — `raw-ffi/src/pano_apple.rs`

After the existing `write_frame_png(out_path, w, h, &data, &display_meta)`, call:

```rust
// data = develop_for_display(img); already in scope at pano_apple.rs:149-151
if let Err(e) = write_display_sidecars(&data, img.width(), img.height(), out_path) {
    // non-fatal: the pano itself succeeded; log and continue.
    log::warn!("pano sidecar generation failed: {e}");
}
```

`write_display_sidecars` is imported alongside `develop_for_display` (both re-exported from `stitch/mod.rs`; `image` 0.25 with the `jpeg` feature is already enabled). The stitch's success/return value is unchanged — a sidecar failure never fails a merge.

### 3. Swift — sidecar path helper (single source of truth)

New `MapleSidecar` (small enum in MapleCore) mirroring the Rust naming:

```swift
enum MapleSidecar {
    static func thumbURL(for assetURL: URL) -> URL
    static func previewURL(for assetURL: URL) -> URL
    // <dir>/.maple/<stem>.{thumb,preview}.jpg
}
```

### 4. Swift — `ThumbnailLoader` reads the thumb sidecar

In the miss-path detached task (after the security-scope claim, **before** the embedded fast path) at `Cache/ThumbnailLoader.swift`:

```swift
let sidecar = MapleSidecar.thumbURL(for: assetURL)
if FileManager.default.fileExists(atPath: sidecar.path),
   let data = try? Data(contentsOf: sidecar) {
    await ThumbnailDiskCache.shared.storeThumbnailData(data, for: assetURL)
    return data
}
```

Cost: one `fileExists` per cold thumbnail load (the disk-cache hit at step 1 short-circuits before this). On hit, the bytes are seeded into the existing disk cache so subsequent loads hit normally. RAWs (no sidecar) fall straight through to today's behavior.

### 5. Swift — `EditSession` seeds the preview sidecar on cold-open

New `seedFromMapleSidecarPreview(for:)` in `EditSession+Hydration.swift`, mirroring `seedFromEmbeddedPreview` exactly (read JPEG → `CIImage` under security scope → `renderActor.seedIfUnpopulated(...)` → publish to `renderedPreview` if accepted). It reads `MapleSidecar.previewURL(for:)`.

Slotted into the hydration sequence (`EditSession+Hydration.swift:221-234`) **after** `seedFromCachedPreview` and **before** `seedFromEmbeddedPreview`:

```
cached preview (RenderedPreviewCache, best)  →  .maple sidecar preview (our 1600 px)  →  embedded JPEG (none for a pano)
```

The existing `seedIfUnpopulated` atomicity guard means a preceding cache seed is never downgraded.

## Data flow

```
RustPanoStitcher.stitch (FFI)
  → composite → develop_for_display → write_frame_png(<stem>.png)
  → write_display_sidecars(data) → <dir>/.maple/<stem>.thumb.jpg + .preview.jpg
PanoMergeView.onComplete → BrowseViewModel.injectPanoResult(url)
  → grid tile → ThumbnailLoader.load(url)
       → disk-cache miss → .maple/<stem>.thumb.jpg HIT → tile renders (was grey)
Open pano → EditSession hydration
  → cached-preview miss → seedFromMapleSidecarPreview HIT → instant fast-phase → full develop refines
```

## Memory & security scope

- **Memory:** the downsampler reads the borrowed `&[u16]`; only the small (≤1600 px) outputs allocate. No gigapixel clone. Safe on iPad.
- **Scope:** sidecars live under the pano's own directory, so the same security-scoped access that lets the app read the pano covers them. Sidecar reads in `ThumbnailLoader` and `seedFromMapleSidecarPreview` happen inside the existing scope claim (`scopeParentURL ?? url.deletingLastPathComponent()`).

## Error handling

- Sidecar generation is **non-fatal** to the merge; failures are logged.
- Missing/corrupt sidecar → readers fall back to today's behavior (fast/slow thumbnail path; develop-only cold-open). No crash, no regression for RAWs.

## Testing

- **Rust (`maple-pano`):** unit test for `write_display_sidecars` — synthesize a small display buffer (e.g. 800×400 gradient), assert both sidecars exist, decode via `image`, have the expected long edges (256; preview stays native at 800 since < 1600 — proves no-upscale), and round-trip approximately to the gradient. Co-located with the `develop_for_display` tests.
- **Swift (MapleCore):** `MapleSidecar` URL-construction unit; `ThumbnailLoader` returns sidecar bytes when a temp file has a `.maple/<stem>.thumb.jpg`; `seedFromMapleSidecarPreview` file-read unit.
- **Manual (Apple not in cloud CI — verify locally per `project_apple_not_gated_by_cloud_ci`):** `swift test` in `Packages/MapleCore`; build + run on Mac, merge a pano, confirm the tile is no longer grey and cold-open shows the preview instantly. Optionally device-verify on iPad.

## Out of scope / follow-up

- **#1366** — make the `ThumbnailLoader` slow path develop any non-RAW (JPEG/PNG/HEIF) via ImageIO instead of routing everything through the RAW developer. This change fixes the pano case at render time; #1366 is the general defensive fix for the lazy path.
