# 05 — Performance

Tile and region strategy, GPU/CPU split, threading, memory budgets, and the five cache layers. Every design choice here exists to keep slider response below one frame (16ms target, 50ms hard budget) on the interactive path and to not kill iOS on 100MP RAWs.

The architectural companion is [`02-pipeline.md`](./02-pipeline.md). Where an algorithm's runtime cost matters, that's flagged in [`03-algorithms.md`](./03-algorithms.md).

---

## Target budgets

These are the numbers every change must stay within. Missing a budget is a bug, not a preference.

| Scenario                     | Platform        | Target                             | Hard limit |
| ---------------------------- | --------------- | ---------------------------------- | ---------- |
| Cold folder open (500 files) | Apple           | < 500ms to first visible thumbnail | 1500ms     |
| Cold image open (25MP RAW)   | Apple desktop   | < 100ms with warm cache            | 500ms      |
| Cold image open (25MP RAW)   | Apple, no cache | < 1500ms                           | 3000ms     |
| Slider drag, fast pass       | Apple           | < 33ms per frame                   | 50ms       |
| Slider drag, refine pass     | Apple           | < 300ms to settle                  | 600ms      |
| Export (25MP JPEG)           | Apple desktop   | < 2s                               | 5s         |
| Export (100MP TIFF 16-bit)   | Apple desktop   | < 8s                               | 20s        |
| Slider drag, fast pass       | Web             | < 50ms                             | 100ms      |
| WASM decode (25MP DNG)       | Web             | < 2s                               | 5s         |

Benchmarking uses `test_color_pipeline.sh` for correctness and the slider-tick perf bench (below) for regression detection on the interactive path.

---

## Slider-tick perf bench

Automated regression coverage for the slider-drag fast pass on both surfaces. Ticket [#641](https://github.com/zubair-io/Maple/issues/641); added after S5 Editor (#635) shipped without an automated guard against the slider-drag budgets in the "Target budgets" table above (Apple 33/50 ms; Web 50/100 ms) and the tighter CLAUDE.md product invariant (16 ms target / 50 ms hard) that sits underneath them.

### What's measured

**Apple** — `src/apple/Packages/MapleCore/Tests/MapleCoreTests/Performance/SliderTickPerfTests.swift`

- Loads the reference RAW fixture once (`test-fixtures/raws/dji-mavic3pro-100mp.dng` if present, else `test-fixtures/raws/test_0017.dng`).
- Decodes once through `ImageEditPipeline.decodeSceneLinear` (matches the editor's open path).
- Warms the CIContext + Metal pipeline cache with one render (the live editor pays this cost at session open, not per tick).
- Loops 50 ticks: mutate `model.exposure` across [-1, +1] EV → `pipeline.processSceneLinear` → render the result into a Metal-backed `MTLTexture` destination → wait on the command buffer. That's the exact synchronous work a slider tick performs in production (`EditSession+Render.swift` → `decodeAndRender` → `processSceneLinear`).
- Splits the timer per-tick into `processSceneLinear` time vs. the destination render time, so the report attributes the per-tick cost to either the FFI round-trip (the load-bearing call) or the GPU pass for sharpen + NRColor.

**Web** — `src/web/projects/maple-common/src/lib/editor/perf/slider-tick.bench.spec.ts`

- Smaller scope by necessity: the web editor's per-tick render runs in WebGL2, which is not available in the headless Vitest runner. The bench measures the state-plumbing pipe only — `EditorStateService.setArmedDisplayValue` → `LibraryStateService.updateAdjustment` → signal-update — over 50 ticks. The full state + WASM + WebGL slider-tick cost needs a Playwright-backed harness; that's tracked as a follow-up.

### Budgets and ceilings

The "Spec target / Spec hard limit" columns below report against the **CLAUDE.md product invariant** (16 ms target / 50 ms hard) — the tightest budget the slider-tick path is held to, deliberately stricter than the per-surface rows in the "Target budgets" table above (Apple 33/50 ms; Web 50/100 ms). When a regression triages, the per-surface budgets are the first guard; the CLAUDE.md invariant is the ratchet target the bench reports against.

| Surface | Spec target (CLAUDE.md) | Spec hard limit (CLAUDE.md) | Regression ceiling (today) | Notes                                                               |
| ------- | ----------------------- | --------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Apple   | 16 ms                   | 50 ms                       | 350 ms                     | Mean ~108–120 ms today on M-series Mac w/ test_0017.dng @ 1920×1080 |
| Web     | 16 ms                   | 50 ms                       | 5 ms                       | State pipe only — mean ~0.03 ms (microsecond-scale)                 |

The spec target and hard limit are the product budget. The regression ceiling is the bench's actual assertion — set generously above today's measured floor so the bench is a regression detector, not a perma-failing test for an aspirational number. The Apple ceiling is well above today's spec hard limit because the per-tick FFI round-trip (GPU readback → Rust core → CIImage re-wrap) currently runs ~110 ms on a 5 MP fixture; closing that gap to the spec target is product work tracked separately.

### How to run

```bash
# Apple
MAPLE_PERF=1 swift test --filter SliderTickPerfTests \
    --package-path src/apple/Packages/MapleCore

# Web
cd src/web
MAPLE_PERF=1 npx ng test Maple-common \
    --include='**/perf/*.bench.spec.ts'
```

Without `MAPLE_PERF=1` both benches skip-pass — the default `swift test` / `ng test` run on every PR doesn't pay the multi-second bench cost. If the reference RAW fixture is absent (CI without `test-fixtures/raws/`), the Apple bench `XCTSkip`s; the web bench has no fixture dependency.

### What to do on a regression

1. Look at the `[slider-tick-perf]` summary line. Apple reports `process=…ms render=…ms` — the attribution tells you whether the regression is in the FFI chain or in the CoreImage rasterisation that follows it.
2. If `process` time jumped: most likely a change to `applySceneLinearChainViaFFI` or the FFI parameter assembly. Walk the recent diff against `ImageEditPipeline.processSceneLinear` and the Rust core's scene-linear stages — including `sharpen` and `nr_color`, which run inside that chain since #1043 and are by far its most expensive members.
3. If `render` time jumped: a CIContext config drift, or the display-encode round trip. There are no hand-written Metal render kernels left on this path; #1043 retired the last two.
4. If the web state-pipe ceiling tripped: the signal-update path got more expensive — most likely an unnecessary deep clone or a new subscriber doing synchronous work on every patch.

The bench is a one-way ratchet, mirroring the color budgets policy in `docs/testing.md`. When a perf win lands, lower the ceiling in the same commit so a future regression can't sneak the floor back up.

---

## GPU / CPU split

### Everything fast lives on GPU

- **All scene-linear chain stages plus the AgX view transform** run on GPU in the interactive loop. CIFilter → Metal on Apple, WebGL2 shaders on web.
- **The decoded image is resident in GPU memory** as a scene-linear Rec.2020 f32 texture across the session. No re-upload between slider changes.
- **Color-space transforms** (ProPhoto→Rec.2020 at DCP exit is done once on CPU; Rec.2020→P3/sRGB display encode is a shader pass) avoid CPU round-trips during interaction.

### CPU handles one-shot work

- **RAW decode and demosaic** run on CPU — the Rust core is CPU-only. Demosaic output is uploaded to GPU once per image.
- **Sidecar parse and serialize** are CPU, off the main actor.
- **Thumbnail generation** is CPU (ImageIO's `CGImageSource` for embedded JPEGs; full decode otherwise).
- **Export encoding** (JPEG/HEIC/TIFF/PNG) is CPU via platform encoders.

### What crosses the boundary

- **Decoded pixels (f32 linear Rec.2020 D65, scene-referred)** — once per image load, via bytemuck zero-copy on Apple, via WASM memory on web.
- **Final rendered texture → encoded bytes** — once per export, via `CIContext.createCGImage` or `gl.readPixels`.
- **Adjustment uniforms** — every slider tick, small (< 1KB). Cheap.

---

## Threading model

### Apple

| Component                 | Isolation             | Notes                                                                  |
| ------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `EditSession`             | `@MainActor`          | All state mutations on main. RAW decode offloaded via `Task.detached`. |
| `UnifiedLibraryViewModel` | `@MainActor`          | Generation counter guards async loads.                                 |
| `ThumbnailLoader`         | `actor`               | 6 concurrent slots via checked-continuation waiters.                   |
| `XMPSidecarStore`         | `actor`               | Serialized sidecar read/write.                                         |
| `ImageEditPipeline`       | `@unchecked Sendable` | `CIContext` thread-safe; `CIImage` immutable.                          |
| `FilesystemSource`        | `@unchecked Sendable` | Called only from `@MainActor`; single-threaded in practice.            |

The central rule: **state that the UI observes lives on `@MainActor`**; work that doesn't (decoding, parsing, thumbnailing) runs on detached tasks or actors.

### Web

- **Main thread**: Angular UI, WebGL draw calls, all user interaction.
- **Worker thread (planned, not v1)**: WASM decode off the main thread. In v1, WASM decode runs on the main thread and blocks for ~1–2s on large RAWs. See [`09-open-questions.md`](./09-open-questions.md) § Web worker decode.
- **GPU**: WebGL2 draw calls are async on the GPU but synchronous in the JS thread (the driver queues them).

### Rust core

- **CPU parallelism via rayon.** Demosaic, dehaze, and capture sharpening each run rayon-parallel across scanlines or horizontal bands.
- **No internal threading of the decode step.** Rawler's decompression is single-threaded; parallelism comes at the demosaic stage.
- **No async.** The Rust core exposes synchronous functions; callers wrap with their own async runtime.

---

## Two-phase rendering

The interactive rendering pass is split into a fast and a refine phase to never block the main loop on a slider.

### Fast phase

- **Viewport only.** Render the cropped rectangle that's actually on screen, at screen resolution (accounting for pixel scale — see [`zoom.md`](../zoom.md)).
- **Low-quality filters permitted.** `CIImage` can be asked for a lower-precision render via `.cheap(true)` style flags; Maple uses Core Image's default "good enough" path.
- **50ms target, 100ms hard limit.**
- **Cancellable.** If a new slider value arrives mid-render, the in-flight render is discarded.

### Refine phase

- **Full image bounds.** Renders the entire adjusted image, not just the viewport.
- **Highest-quality filter settings.** Let Core Image run its best tiling path; don't hint low-precision.
- **300ms target, 600ms hard limit.**
- **Debounced by 150ms after the last slider change.** If the user is still dragging, don't waste work.

### Coalescing

If two slider changes arrive while a fast render is in flight:

1. First slider change kicks off fast render.
2. Second slider change sets a "pending refresh" flag and awaits.
3. Fast render completes → check pending; if set, immediately start another fast render with the latest model, clear pending.
4. When fast renders stop coming for 150ms, kick off refine.

No queue. No batching. Just cancel-and-restart with the latest state.

### Implementation

On Apple, `CIContext.startTask(toRender:to:bounds:)` returns a `CIRenderTask` that can be cancelled. The session holds a weak reference to the current task.

On Web, there is no cancel; the JS thread simply issues the next draw call when the previous one finishes. GPU work is pipelined, so "cancelling" is effectively "don't read back the result". Fast pass writes to one FBO; refine pass writes to another; the canvas blits whichever is newer.

---

## Tiling and memory pressure

### When to tile

Scene-referred f32 working textures double the memory footprint vs a display-referred f16 pipeline. All tile thresholds below are stated for f32 RGBA (4 bytes/channel × 4 channels = 16 bytes/pixel):

- **Preview on desktop**: never tile at 25MP (400MB); tile at 50MP (800MB) if memory pressure observed. Most modern Macs handle 50MP f32 without issue.
- **Preview on iPad (M-series)**: tile when the decoded image would exceed ~600MB of f32 RGBA (~38MP). Use half-res quad demosaic (§ 3.3.2 in [`03-algorithms.md`](./03-algorithms.md)) to avoid tiling entirely on > 40MP.
- **Preview on iPad (A14 / older)**: tile on anything > 20MP f32 (~320MB), or force half-res quad demosaic. See [`09-open-questions.md`](./09-open-questions.md) § Older iPad support.
- **Preview on iPhone**: half-res quad demosaic on everything; tile on > 15MP f32.
- **Export, any platform**: tile when output > 50MP, regardless of platform. Tile size 2048×2048.
- **Export to TIFF 16-bit linear**: tile when output > 25MP (the u16 intermediate is still 8 bytes/pixel; scene-linear export preserves the full pipeline bit depth through the write).

### Tile manager

Lives in `raw-core/src/tile.rs`. Used by both the export path and the future panorama stitcher.

Contract:

```rust
pub struct TilePlan {
    pub tile_size: (u32, u32),       // typically (2048, 2048)
    pub overlap: u32,                // 32 or 64 pixels for filters with neighborhoods
    pub tiles: Vec<TileRect>,
}

pub fn plan_tiles(image_size: (u32, u32), tile_size: (u32, u32), overlap: u32) -> TilePlan;
```

Each tile is processed independently through the full pipeline, then composited with crossfade in the overlap region. The overlap width must exceed any filter's neighborhood radius — 32 pixels handles bilinear/bicubic + NR + unsharp mask at radius ≤ 16; 64 pixels is safer for clarity at radius 40.

### iOS memory budget

iOS will `memory_pressure` kill the app at ~1.5GB RSS on most iPads. Scene-referred f32 widens every bucket:

| Allocation (25MP, scene-referred f32)                            | Typical |
| ---------------------------------------------------------------- | ------- |
| f32 scene-linear Rec.2020 working texture                        | 400MB   |
| Decoded f32 Rec.2020 source (session-scoped)                     | 400MB   |
| Thumbnail cache (in-memory, 200 items, u8 sRGB)                  | 40MB    |
| Rendered preview cache (in-memory, 10 items, u8 display-encoded) | 80MB    |
| Other (SwiftUI, AVFoundation, OS)                                | ~400MB  |
| **Total**                                                        | ~1.3GB  |

Close to the 1.5GB ceiling. The working texture and the decoded source are the same scene-linear Rec.2020 representation — on Apple they share the same Metal buffer (the filter chain reads the decoded source and writes to a separate output texture each frame, but the source is single-copy and the output texture can be reclaimed after presentation). Effective peak is closer to ~900MB for the pipeline plus OS overhead.

For 100MP:

| Allocation (100MP via half-res quad demosaic → 25MP effective f32) | Typical |
| ------------------------------------------------------------------ | ------- |
| Decoded f32 at 25MP effective                                      | 400MB   |
| Working output texture at 25MP                                     | 400MB   |

Still tight but under budget after deduping. Full-res 100MP decode is not attempted on iOS in the interactive path in any configuration.

### Older iPad tiling policy

iPads without M-series chips (A14-based iPad Air 4, A15 iPad mini 6, and similar) have less memory headroom. The interactive path on these devices:

1. Detects device family at session start via `MTLDevice.recommendedMaxWorkingSetSize`.
2. If working-set ceiling < 2GB, engages tile mode: the working texture is subdivided into 2048×2048 f32 tiles; only tiles intersecting the viewport are allocated at fast-phase render time.
3. Refine pass materializes the full-resolution working texture briefly and drops it after the render completes.

Tile mode trades per-frame latency (~10ms overhead from tile composition) for a 3–4× reduction in peak working-set memory. See [`09-open-questions.md`](./09-open-questions.md) § Older iPad tiling benchmarks.

---

## Five caches

Maple maintains five distinct caches, each with a different scope, invalidation, and persistence model. Mixing them up is the most common source of "why didn't my thumbnail update?" bugs.

### 1. ThumbnailMemoryCache

- **What**: `CGImage`/`HTMLImageElement` for 500×500ish thumbnails.
- **Where**: in-memory LRU, ~200 entries on desktop, ~100 on iPad.
- **Keyed by**: `(assetID, sizeClass)`.
- **Invalidation**: on `EditSession.regenerateThumbnail()` (tick-counter change on `ImageAsset`). On LRU eviction.
- **Persistence**: none.

### 2. ThumbnailDiskCache

- **What**: JPEG files, sRGB, ~500×500.
- **Where**: `~/Library/Caches/MapleMaple/thumbs/{hash}.jpg` on Apple; `.maple/thumbs/{hash}.jpg` on SMB shares.
- **Keyed by**: `hash(assetID, primaryFileMtime, sidecarMtime)`.
- **Invalidation**: hash mismatch on lookup → regenerate. Bulk-invalidated by bumping the schema version.
- **Persistence**: survives app restarts; survives OS reboots. Cleaned up on an "old cache" pruning run (> 30 days untouched).

### 3. RenderedPreviewCache

- **What**: JPEG files, opaque, screen-native-resolution, Display P3 (post-AgX view-transform output).
- **Where**: `~/Library/Caches/MapleMaple/rendered/{hash}.jpg`.
- **Keyed by**: `hash(primaryURL, primaryMtime, sidecarMtime, screenSize, adjustmentVersion, viewTransformVersion)`.
- **Invalidation**: any hash component change. `adjustmentVersion` is bumped when the pipeline definition changes (e.g., new stage, new default value). **`viewTransformVersion` is bumped whenever AgX's coefficients or the look presets change** — replacing AgX with OpenDRT in a future version would invalidate every preview at once, which is exactly the intent.
- **Persistence**: survives restarts. Bulk-invalidated on app version bump.
- **Purpose**: sub-100ms cold-open. The cached preview is what the user _last saw_ in the editor, so the cold-open experience is visually instant.

### 4. DecodedCIImage (session-scoped, in-memory)

- **What**: the post-decode CIImage (Rust output wrapped as Metal buffer, or CIRAWFilter output).
- **Where**: `EditSession.decodedImage`. Single slot; one per editor instance.
- **Keyed by**: nothing — just held as long as the session lives.
- **Invalidation**: session teardown (navigate away).
- **Persistence**: none.

### 5. SMBFileData

- **What**: downloaded SMB file bytes.
- **Where**: `~/Library/Caches/MapleMaple/smb/{hostname}/{path}`.
- **Keyed by**: SMB path + remote mtime.
- **Invalidation**: mtime mismatch on next access.
- **Persistence**: survives restarts.
- **Purpose**: SMB is slow; caching the RAW bytes means re-opening the same image doesn't re-download.

### Cache flow for a cold open

```
User double-clicks image in grid
    ↓
RenderedPreviewCache hit?
    YES → show instantly (target: <100ms); continue to background decode
    NO  → show spinner; block on decode
    ↓
Source adapter fetch bytes
    (filesystem: POSIX open; SMB: SMBFileData hit or network fetch)
    ↓
Rust decode + demosaic → DecodedCIImage
    ↓
Render with current model → new preview
    ↓
On endEditing: write new preview to RenderedPreviewCache
```

### Cache flow for a slider drag

```
slider changes
    ↓
DecodedCIImage hit (always — session-scoped)
    ↓
Re-render with new model → new preview
    ↓ (debounced)
ThumbnailMemoryCache invalidated; tick counter bumped
ThumbnailDiskCache invalidated by hash change on next read
RenderedPreviewCache invalidated by hash change on next cold open
```

---

## Detailed timing decomposition: one slider tick

For a 25MP image on an M-series Mac, a single slider change in the fast phase:

| Step                                                                | Budget    |
| ------------------------------------------------------------------- | --------- |
| SwiftUI slider → binding update                                     | < 1ms     |
| `EditSession.model.{field} = value`                                 | < 1ms     |
| `ImageEditPipeline.apply(adjustments:)` — CIFilter graph reassembly | < 2ms     |
| `CIContext.startTask(toRender:)` submit                             | < 2ms     |
| GPU render (M3 Max, f32 scene-linear Rec.2020 + AgX, 25MP viewport) | ~14ms     |
| `CIRenderDestination` → `MTLTexture` presentation                   | < 3ms     |
| SwiftUI invalidate + redraw                                         | < 5ms     |
| **Total**                                                           | **~29ms** |

This is inside the 33ms frame budget for 60Hz. On a 120Hz iPad Pro (8ms budget), the fast path is already over budget for scene-referred f32 — viewport clipping plus half-res quad on large images are load-bearing, and the refine pass carries the rest.

On a 100MP image with full-res decode, the GPU render alone runs 50–80ms in scene-referred f32 — missing the frame budget. Hence the half-res quad decode on iOS for preview and the viewport-only fast pass.

---

## Lazy composition (CIFilter)

Core Image's filter graph is lazy. Maple builds the graph fresh on every slider change:

```swift
let chain = [wb, tone, vibrance, saturation, clarity, texture,
             dehaze, sharpen, nr, crop]
    .compactMap { $0 }          // drops nil (skipped) stages
    .reduce(decodedImage) { ci, filter in filter(ci) }
```

Building the graph costs microseconds. The `reduce` produces a `CIImage` that describes the pipeline; no pixels move until `CIContext.startTask(toRender:)`. The GPU then evaluates the whole thing in one pass, fusing what it can.

Consequences for performance:

- **Skipped stages cost nothing.** A slider at default is not in the graph.
- **Parameter updates cost nothing until render.** Setting `temperature = 5500` vs `6500` is just a different CIFilter input attribute.
- **The lazy graph is the thing caching — not Maple's code.** Maple does not memoize intermediate CIImages between slider changes; there's no point.

---

## WebGL2 performance notes

- **Fused shader + 3 FBOs.** One draw call for the main adjustment path. Clarity and texture each add two Gaussian blur passes + one unsharp composite = 5 additional draw calls only when non-default.
- **Texture format**: `RGBA32F` (scene-referred requires f32 precision; see [`04-color-management.md`](./04-color-management.md) § f32 precision). Requires `EXT_color_buffer_float` — mandatory, not optional. Safari 16+, Chrome 90+, Firefox 100+ all support it on modern hardware; a browser without the extension falls back to a "browser not supported" error rather than a degraded visual path.
- **Mipmap not used**: the working texture is rendered at its native resolution; no downsampling in-shader.
- **Uniforms batched per draw**: one `uniformBufferObject`-equivalent (WebGL2 has UBOs) for all adjustments.
- **Tone curves as a 4×256 texture**: master + RGB curves as LUT rows, sampled via `texture(u_lut, vec2(value, channel_row))`.

The fused-shader approach dominates an "N draws, one filter each" approach because uniform bandwidth and fragment shader invocation overhead are both one-time rather than N-time.

---

## What the rendered-preview cache earns

Without the rendered-preview cache, a cold image open is:

- RAW container parse: ~50–300ms depending on format
- Demosaic: ~100–500ms on CPU
- Upload to GPU: ~50ms
- First-frame render: ~30ms

Total: **~250–1000ms** on a warm process; longer if disk I/O is cold. This is the delay the user experiences as "image is loading".

With the rendered-preview cache hit:

- Read 200KB JPEG from disk: ~10ms
- Decode JPEG: ~20ms
- Display: ~5ms

Total: **~35ms.** Within one display frame. The image appears to snap open.

The cache earns its complexity on the very next re-open of any image — which happens constantly as users flip through a shoot.

---

## What this document does not define

- **What the filter chain does mathematically.** See [`03-algorithms.md`](./03-algorithms.md).
- **Where cached sidecars live on disk.** See [`08-io.md`](./08-io.md).
- **How the web WASM decode blocks the main thread.** See [`06-cross-platform.md`](./06-cross-platform.md).
- **How the UI signals "loading" to the user.** See [`07-ui-architecture.md`](./07-ui-architecture.md).
