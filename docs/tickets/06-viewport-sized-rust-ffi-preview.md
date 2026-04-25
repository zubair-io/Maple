# Viewport-Sized Rust FFI Preview Render

## Summary

Opening a RAW in the editor currently starts a Swift stage named
`rust FFI decode`, but that stage does more than decode. It asks Rust to render
the entire preview-quality image, which for a 100MP RAW is still roughly 25MP
after half-resolution demosaic, then Swift downsamples that buffer to the
viewport.

This ticket adds a first-class viewport-sized Rust FFI preview path. The first
interactive Rust render should produce only the pixels needed for the current
editor viewport, capped by a small preview budget, instead of materializing a
whole half-resolution image.

The goal is not Deep Zoom in this phase. The goal is to make the awaited Swift
`rust FFI decode` stage scale with screen size instead of sensor size.

## Problem

The editor has a two-phase render model and comments that describe viewport
rendering, but the viewport size is only used after the Rust FFI call returns.

Current behavior:

1. Swift opens an asset and calls `ImageEditPipeline.decode(asset:)`.
2. `decode(asset:)` calls `PipelineRenderer.render(..., quality: .preview)`.
3. `maple_render_file` reads the RAW, decodes it, runs the Rust preview render,
   and returns a packed sRGB u8 RGB buffer.
4. Rust preview quality uses half-resolution demosaic. On the 100MP reference
   RAW, that still produces about 25MP.
5. Swift wraps the whole returned buffer as a `CIImage`.
6. `ImageEditPipeline.process(decoded:targetSize:)` downsamples to the viewport
   using CoreImage.

This means the first Rust-backed render still pays for far more pixels than are
visible. A fit-to-window view on a Mac or iPad usually needs 1-3MP, not 25MP.

## User Outcome

When a photographer opens a large RAW:

- A cached rendered preview or embedded camera preview appears immediately when
  available.
- The first Maple-rendered preview replaces that seed quickly and at the same
  visual size as the viewport.
- The editor becomes slider-ready without waiting for a whole half-resolution
  image to cross the FFI boundary.
- Zooming in can request better data later, without blocking the initial open.

## Goals

- Reduce the awaited `[swift] rust FFI decode` time for large RAWs by making the
  first Rust render target the viewport, not half sensor resolution.
- Keep the non-destructive sidecar contract unchanged.
- Preserve the existing two-phase editor behavior:
  - fast phase: viewport-sized preview
  - refine phase: higher-resolution render when zoom requires it
- Keep export and parity harness behavior unchanged.
- Prepare the API shape for future tile/deep-zoom rendering without requiring a
  full tile manager in this phase.

## Non-Goals

- Full Deep Zoom / Google Maps-style tile rendering.
- Full-resolution visible-crop rendering at 1:1 zoom.
- GPU-resident decode directly into `MTLTexture`.
- Rewriting the development chain as Metal kernels.
- Changing thumbnail generation.
- Changing export output.
- Changing Web/WASM behavior in this ticket.

## Product Requirements

### 1. Add a Viewport Preview FFI Path

Apple must be able to request a preview render with a target size or maximum
pixel budget.

Minimum API shape:

```c
maple_render_file_preview_sized(
  raw_path,
  xmp_path,
  max_width,
  max_height,
  out
)
```

Equivalent byte-buffer entry:

```c
maple_render_bytes_preview_sized(
  raw_bytes,
  raw_len,
  hint_ext,
  xmp_path,
  max_width,
  max_height,
  out
)
```

The returned image must preserve the source aspect ratio and fit within
`max_width x max_height`. It must never upscale beyond the Rust preview source.

### 2. First Rust Render Uses the Viewport Target

On editor open, `EditSession` must pass the current fast target size into the
Rust FFI preview path.

If `previewSize` is unknown at the moment decode starts, the editor may use a
conservative fallback cap, for example a 2MP long-edge-constrained preview.

### 3. Existing Whole-Preview Path Remains Available

The existing `maple_render_file` / `maple_render_bytes` calls remain available
for:

- thumbnails that still depend on the legacy display-encoded path
- tests
- export-adjacent diagnostics
- fallback when the sized preview path fails

### 4. Refinement Is Explicit

When the user zooms beyond what the viewport-sized preview can support, the app
may request a larger preview render.

Phase 1 behavior:

- fit-to-window: one viewport-sized Rust preview is enough
- zoom below 1:1: request at most the visible target size, capped by a configured
  preview ceiling
- 1:1 zoom: may continue using the current half-res preview path until a later
  tile/crop render path lands

### 5. Cache Keys Include Render Size

Any rendered-preview cache entry produced from this path must include the
effective render size or screen-width bucket in its key.

Serving a smaller cached preview into a larger viewport is allowed only if the
quality loss is within the UI's existing preview tolerance. The cache must not
serve stale previews across:

- source file mtime changes
- sidecar mtime changes
- view transform version changes
- render-size bucket changes

## Technical Requirements

### Rust

- Add a render path that can downsample before the FFI handoff.
- The implementation should avoid allocating a large display-encoded buffer and
  then immediately downsampling it when practical.
- The first implementation may still run the current half-resolution demosaic
  and development chain before downsampling, but the output buffer crossing FFI
  must be viewport-sized.
- A follow-up optimization should downsample earlier in the pipeline if profiling
  shows downstream stages dominate.
- Orientation must be correct in the returned buffer.
- `MAPLE_PROFILE=1` must report enough stages to separate:
  - raw file read
  - rawler decode
  - Rust render/develop
  - downsample
  - FFI output packing

### Swift

- Add `PipelineRenderer.renderPreviewSized(...)` wrappers for file and byte
  inputs.
- Add `ImageEditPipeline.decodePreviewSized(asset:targetSize:)`.
- Route the editor's first Rust-backed open through the sized preview path.
- Keep `renderForExport()` on the existing full-quality path.
- Do not block first paint on preview cache writes.

### Color

Phase 1 may return the same display-encoded sRGB u8 format as the existing FFI
path. If the scene-linear FFI split lands first, this path should instead return
scene-linear Rec.2020 fp16 and run the display transform on the Apple side.

The product requirement is size reduction. The color-domain decision follows the
active pipeline architecture at implementation time.

## Performance Requirements

Reference scene: 100MP Hasselblad/DJI Mavic 3 Pro DNG.

Measured with `MAPLE_PROFILE=1` on a release build.

| Scenario | Target | Hard Limit |
| --- | ---: | ---: |
| First visible cached/embedded seed | < 100ms | 250ms |
| First Rust-backed viewport preview, no cache | < 1000ms | 2000ms |
| FFI output buffer size for fit viewport | <= 32MB | 64MB |
| Swift `Data(bytes:)` copy for returned buffer | < 50ms | 100ms |
| Slider tick after Rust preview lands | < 33ms | 50ms |

If rawler decode alone exceeds the hard limit for a specific camera format, the
profile report must show that clearly. In that case, the sized preview path is
still considered successful if all post-decode work scales with the viewport
budget instead of the source sensor size.

## UX Requirements

- The user should never see a blank editor while waiting for Rust if an embedded
  preview or rendered-preview cache exists.
- The switch from embedded preview to Maple-rendered preview must not change
  zoom framing.
- The switch may improve color/detail, but it must not jump crop, rotation, or
  aspect ratio.
- If a higher-resolution refine render is pending, the UI should remain usable
  with the viewport preview.

## Acceptance Criteria

- Opening the 100MP reference RAW at fit-to-window calls the sized preview FFI
  path, not the whole half-resolution preview FFI path.
- The Rust-returned buffer dimensions fit within the requested target size.
- The Swift `[swift] rust FFI decode` stage is split or renamed so it no longer
  hides render/downsample/copy costs under the word "decode."
- `MAPLE_PROFILE=1` shows the output packing and Swift buffer-copy costs.
- Reopening an image with a valid rendered-preview cache still paints from cache
  before the Rust preview returns.
- Export output and color parity harness remain unchanged.
- Existing tests for `PipelineRenderer.render` continue to pass.
- New tests cover:
  - aspect-preserving target-size math
  - no upscaling
  - orientation correctness
  - cache key includes size bucket

## Recommended Milestones

### Milestone 1: Instrument and Rename

- Split the Swift stage currently labeled `rust FFI decode`.
- Add Rust-side profile scopes around read, decode, render, downsample, and pack.
- Establish baseline numbers for the 100MP reference RAW.

### Milestone 2: Sized Output Path

- Add the FFI functions and Swift wrappers.
- Render current preview quality, then downsample before returning across FFI.
- Route initial editor open through the new path.

### Milestone 3: Earlier Downsample

- Move the downsample earlier if profiling shows the full half-res development
  chain still dominates.
- Keep correctness gates against the existing preview render.

### Milestone 4: Visible Crop / Tile Path

- Add crop/tile parameters for 1:1 zoom and deep zoom.
- Include tile overlap for demosaic/neighborhood filters.
- Promote the tile path only after viewport-sized preview is stable.

## Risks

- Downsampling after display encoding is faster to implement but less correct
  than scene-linear downsampling. If the scene-linear FFI split is already in
  progress, prefer doing the size reduction in scene-linear.
- Some RAW formats may spend most of their time inside rawler decode. This path
  cannot fully solve that; it prevents additional time from scaling with sensor
  pixels.
- Demosaic and neighborhood filters need border context for true crop/tile
  rendering. That is why full tile rendering is deferred.
- Cache quality can regress if a too-small preview is reused for a larger
  viewport. Size buckets must be conservative.

## Open Questions

- What is the default fallback target when `previewSize` is not yet known:
  2MP, 4MP, or display native bounds?
- Should the first implementation return RGB u8 to minimize scope, or wait for
  the scene-linear fp16 FFI split?
- Do we want a single `max_long_edge` API instead of `max_width/max_height` for
  easier cross-platform parity?
- What zoom threshold should trigger a larger preview request before true tile
  rendering exists?
