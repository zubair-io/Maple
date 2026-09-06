# Zoom and tile rendering

Maple's canvas has one zoom number — `pixelScale`, real screen pixels per image pixel — shared by the Apple and Web editors. `0` means fit-to-viewport, `1.0` means pixel-perfect 100% (one image pixel on one _device_ pixel, so 100% is genuinely 1:1 on a Retina display), and the cap is `8.0`. Everything downstream is a consequence of that number: at fit, both platforms render the whole image at viewport resolution and nothing more; zoomed in past 100%, rendering a full 100 MP frame would be wasteful and, on iOS, fatal, so Apple switches to developing **only the visible rectangle of source pixels** through a dedicated tile entry point in the Rust core. The Rust tile path pads the requested rectangle so filters that read neighbouring pixels still see context, then trims the pad away — the pad grows per render to the reach of the spatial stages the model engages, frame-anchored point ops are told where the tile sits, and the few stages that need a whole-frame product (dehaze, BM3D deep denoise) or an opcode mapping are _refused_ so the caller falls back to a bounded whole-image render. Web CPU fallback uses the same single visible-patch approach at 100% and above; its sized whole-image preview remains underneath while native refinement runs.

There are two distinct tile consumers on Apple, and only one of them is live. `NativeDetailRenderer` (on) develops a single viewport-sized patch and paints it as an overlay above the base preview. `TileManager` (off, behind `EditSession.deepZoomEnabled = false`) is the older 512²-grid compositor.

## The zoom model

| Concept           | Apple                                                      | Web                                          |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Zoom state        | `CanvasZoomModel.pixelScale`                               | `ImageCanvasService.pixelScale` signal       |
| Fit sentinel      | `0`, resolved by `CanvasMath.effectivePixelScale`          | `0`, resolved by `fitPixelScale()`           |
| Maximum           | `CanvasZoomModel.maxPixelScale = 8.0`                      | `MAX_PIXEL_SCALE = 8`                        |
| Snap back to fit  | at or below `fit × 1.02` (`snapToFitTolerance`)            | at or below `fit × 1.02` (`FIT_SNAP_FACTOR`) |
| Mid-gesture floor | pinch anchors on a start-captured scale                    | `fit × 0.5` rubber band (`FIT_UNDERSHOOT`)   |
| Keyboard commands | ⌘0 = fit, ⌘1 = 100%                                        | ⌘/Ctrl+0 = fit, ⌘/Ctrl+1 = 100%              |
| Wheel zoom        | `exp2(deltaY × wheelZoomSensitivity)`, sensitivity `0.015` | Cmd+wheel / ctrl-wheel trackpad pinch        |

Apple's state machine is `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/CanvasZoomModel.swift` — a pure, testable value type holding scale, pan, and the pinch-start captures. It exists because `MagnifyGesture.magnification` is _cumulative_: multiplying it into the live scale every frame compounds exponentially, so each frame re-derives scale and pan from the values captured at pinch start rather than from the previous frame. The same model exposes gesture arbitration as intents rather than leaving each host to re-derive the rules: `dragIntent` is `.editing` at fit and `.pan` when zoomed; `wheelIntent(commandHeld:)` is `.zoom` with Cmd, otherwise `.pan` when zoomed and `.editing` at fit. Double-tap behaviour is per-surface — the editor toggles fit ↔ 100%, because pixel-perfect is what you need to judge noise reduction and sharpening.

Web mirrors all of it in `src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.zoom-gestures.ts`, including the anchored-zoom pan formula that keeps the image point under the cursor stationary, and a pan clamp that allows at most `(imageCss − wrapCss) / 2` per axis so the image edge can meet the viewport edge but a gap can never open.

The always-visible zoom percentage badge lives at the viewport's bottom-leading corner on Apple (`src/apple/Maple/Views/CanvasZoomHost.swift`, accessibility identifier `canvas-zoom-indicator`). Clicking it or the editor header's zoom readout returns the image to fit and clears pan. `View > Zoom` exposes Zoom to Fit (⌘0) and Actual Size (⌘1); the same shortcuts work with an iPad hardware keyboard. Commands follow the active scene's ready canvas and are disabled outside it. On iOS `pixelScale` is frozen during a pinch — the zoom is a compositor transform — so the badge reads a live scale value instead; macOS updates `pixelScale` continuously.

## What actually renders, by zoom level

Both platforms run a **two-phase** scheduler: a fast pass at viewport resolution on every tick, then a debounced refine pass at higher resolution. The debounce is 150 ms on both (`RenderActor.refineDebounceMilliseconds`, `TwoPhaseRenderScheduler.REFINE_DEBOUNCE_MS`).

Render targets (`CanvasMath` on Apple, `image-canvas.draw2d.ts` on Web) are computed identically:

- **Fast target** = the viewport in real pixels (CSS size × `devicePixelRatio` on Web).
- **Refine target** = `native × min(pixelScale, 1.0)`, floored at the fast target so refine is never worse than fast, and capped. Upscaling past native adds no detail, so `pixelScale` is clamped to 1.0 in that product.

At fit, the refine target equals the fast target by construction, so refine is skipped and the image renders exactly once, at viewport size. The Apple cap is `min(2 × viewport long edge, 16384)`: the `16384` is `CanvasMath.metalMaxTextureEdge`, Metal's per-platform texture edge ceiling, and the `2×` headroom exists because an uncapped `native × pixelScale` approached the full sensor at high zoom — a roughly 1.4 GB f32 buffer that, alongside the concurrent auto-profile develop, got the app jetsam-killed on iOS with a 100 MP RAW.

Apple's refine dispatcher is `refineBody` in `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession+RenderScheduling.swift`, and it picks a path in this order:

1. **A crop is applied** (crop tool disarmed, non-identity crop) → skip every fast path and re-render the whole frame through `decodeAndRender(.refine)`. The viewport rect is in cropped-image coordinates while the patch/tile paths work on full-frame geometry, so only the whole-frame render is crop-aware.
2. **Native detail** — RAW asset, a real file URL, and `pixelScale >= 1.0` with a non-empty visible rect → develop the visible patch (below). This is the production 100% path.
3. **Deep zoom tiles** — same gate plus `EditSession.deepZoomEnabled`, which is `false`. Dead in production.
4. **Short-circuit** — refine target no bigger than the last fast target → just persist the current preview to cache.
5. **Fallback** — bounded whole-image refine at `refinedTargetSize`.

Native detail returns `false` when the Rust tile entry rejects the model, which drops through to step 5.

## The native-detail patch (Apple, live)

`src/apple/Packages/MapleCore/Sources/MapleCore/NativeDetailRenderer.swift` and `EditSession+NativeDetail.swift`. At 100% and above, one stripped-model RAW handle is opened, only the visible source rectangle is developed, and the resulting scene-linear pixels go through the normal Apple display chain. No full-sensor RGBAf buffer is ever created.

Three nested rectangles, all computed by `NativeDetailLOD`:

| Rect         | What it is                                          | Size                                                                      |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `detailRect` | the viewport, rounded outward, clamped to the image | visible region                                                            |
| `patchRect`  | what is developed **and published**                 | `detailRect` grown by 25% of its longer dimension, capped at 512 px total |
| `decodeRect` | what is asked of Rust                               | `patchRect` + a 96 px `filterHalo` per edge, clamped to 16384 per edge    |

The two margins do different jobs. `filterHalo` is unpublished context so clarity, sharpening and NR see neighbouring pixels; it is never displayed. `panMargin` grows the _published_ patch so an ordinary small pan's new viewport still lands inside what is already on screen — `updateTileVisibleRegion` and `refineNativeDetail` both check containment first and return immediately, avoiding a fresh 150 ms-debounced develop and avoiding a visible drop back to the blurry base preview mid-pan. On a square viewport, unclamped, the 25% margin raises developed area by about 1.56×.

The published patch is drawn by `NativeDetailOverlay` (`src/apple/Maple/Views/EditorView+Canvas.swift`), which positions itself proportionally in _source_ coordinates against the image size, inside the same pan/zoom-transformed canvas frame as the base preview. That is why a pan inside the patch needs no re-render at all: the overlay tracks the transform on its own.

Three correctness details that the code is emphatic about:

- **f32, not fp16.** The renderer calls the f32 tile entry so the zoomed-in patch carries the same working precision as the whole-image scene-linear path. fp16 in the tile only could bias shadows or band the AgX shoulder specifically in the zoomed view.
- **No WB anchor on the tile.** The handle carries a _stripped_ model whose white-balance fields were omitted and therefore parse to defaults, not to the live slider values. Passing an anchor would make the tile's camera-WB stage compute a spurious ratio; with no anchor the tile resolves WB exactly like the whole-image strip decode (an as-shot bake with the as-shot DCP retarget) and the live WB delta is applied once, downstream, by the per-tick chain.
- **The auto-exposure gain is threaded in.** A tile's own histogram is not representative of the scene, so the tile chain never recomputes auto-exposure. Instead the caller passes the `ae_gain` that the full-image (or sized) decode already measured, via `maple_render_handle_scene_linear_tile_ae_f32`. Before that existed, this path was restricted to the Auto profile — Auto's decode contract disables auto-exposure outright, so its exported gain is always 1.0 — and Neutral / ACR-Match fell back to the whole-image refine because a tile that skipped the stage rendered at the wrong brightness.

Film look is baked here too (`FilmLookCube.apply`), after the display chain and before the crop to the local rect, because `processSceneLinear`'s output is already in the gamma-encoded domain the `.mlut` lattice is baked in.

## The Rust tile entry points

Geometry is grouped in `raw_core::pipeline::TileRect { src_x, src_y, src_w, src_h, out_w, out_h }`. Source coordinates are **display-oriented** — the caller's canvas coordinates — and the core translates them to sensor space, develops, then rotates the result back so the returned tile lines up with what was asked for.

Core implementation: `src/raw-pipeline/raw-core/src/pipeline/tile/` (`mod.rs` geometry and guards, `region.rs` pad/clamp/trim helpers, `develop.rs` the stripped-down develop chain). The public entries differ only in output precision and in which optional anchors they accept:

| Function                                         | Output    | Anchors                   |
| ------------------------------------------------ | --------- | ------------------------- |
| `render_scene_linear_tile_from_raw_with_quality` | fp16 RGBA | none                      |
| `…_with_wb_anchor`                               | fp16 RGBA | WB delta anchor           |
| `…_f32` / `…_with_wb_anchor_f32`                 | f32 RGBA  | WB delta anchor           |
| `…_with_wb_anchor_and_ae_gain_f32`               | f32 RGBA  | WB delta anchor + AE gain |

All of them funnel into one private `develop_tile_oriented_f32`, so the guard set and the geometry are single-sourced and only the final pack differs.

C-FFI wrappers live in two files. `src/raw-pipeline/raw-ffi/src/scene_linear/tile.rs` holds the path- and bytes-based entries (`maple_render_file_scene_linear_tile`, `maple_render_bytes_scene_linear_tile`), which decode the RAW on every call. `src/raw-pipeline/raw-ffi/src/handle.rs` holds the handle-based entries (`maple_render_handle_scene_linear_tile`, `…_f32`, `…_ae_f32`), which reuse an already-decoded mosaic — that is what makes interactive zoom viable, since rawler-decoding a 100 MP RAW per tile costs seconds.

FFI return codes beyond the shared render errors:

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `9`  | bad tile geometry (a zero dimension; also a non-finite or non-positive `ae_gain`) |
| `10` | model not tile-compatible — fall back to the whole-image render                   |
| `11` | `out_w > src_w` or `out_h > src_h`; the tile path is downscale-only               |
| `12` | output aspect does not match source aspect                                        |

The aspect guard exists because the trim-then-downsample step drives a single long-edge scale, so a mismatched request would be silently fitted to a square. It refuses loudly instead.

### The overlap pad, and what still doesn't fit

The pad is computed per render (`tile/overlap.rs`): the sum of the stencil reaches of every spatial stage the model engages, on a `TILE_OVERLAP_PX = 48` floor. Stages cascade — each reads the previous one's output — so their reaches add. Each reach is the stage's own number, exported from the stage module so the table cannot drift from the kernel: clarity 40 (`CLARITY_GUIDED_REACH_PX`, a guided filter at radius 20 box-blurs a buffer that was itself box-blurred at radius 20), texture 4 (`TEXTURE_GUIDED_REACH_PX`), sharpen `⌈3σ⌉ + 1` at the clamped sigma (`sharpen::stencil_reach_px`, 10 px at σ = 3), luma and chroma NLM 4 and 5 (`LUMA_REACH_PX` / `CHROMA_REACH_PX`), capture sharpening `iterations × 2 × ⌈3σ⌉` (`capture_sharpening::stencil_reach_px`, 96 px at the σ = 8 clamp), and the highlights/shadows detail mask one radius per engaged slider at σ = 15 px · longEdge/2000 (`sh_mask_reach_px`), anchored to the full frame's long edge at the tile's develop resolution (`apply_with_mask_anchor`) so a tile and the whole-image render compute the same radius. The fixed stencils that run before scene-linear space — demosaic 2, hot-pixel 2, chroma prefilter 4 — are a constant 8. A `Preview` develop measures every reach in developed pixels and doubles it back to mosaic pixels. A slider at zero contributes nothing; the floor keeps every existing render on at least the pad it had. A compile-time `const` assertion still ties the floor to `clarity::CLARITY_GUIDED_REACH_PX`.

Point ops whose field spans the frame do not need overlap; they need to know where the tile sits. `region::TileWindow` carries the padded crop's origin in the DefaultCrop'd frame (signed — a crop can start before the frame) and the frame's extent at the develop resolution, and `vignette::apply_windowed` / `local_adjustments::apply_windowed` reproduce the whole-frame ellipse and the frame-normalised mask coordinates exactly. The whole-frame entries (`apply`) are the `origin = (0, 0)` case of the same function.

The pad is why a tile render is fast rather than a full develop: the core linearizes **only** the padded crop. On a ~12288×8192 sensor a 512 px tile plus the floor pad is roughly 582×582 px — around 10 ms rather than the ~480 ms a full-sensor linearize costs, which is what turns a 23-tile view from ~10 minutes into ~10 seconds. The stages that scale with the frame widen that at deep zoom — a single highlights or shadows slider on that sensor at 100% pads 276 px per edge, both 552 — which is still a fraction of the whole-image fallback; the proxy-plane half of the stage-class plan (a full-frame low-frequency product upsampled into each tile) is what brings those back down, and is what dehaze needs before it can tile at all.

Three model conditions are rejected at the entry (`tile/guards.rs`) with an `Err`, which the FFI maps to code `10` and the Apple caller turns into a whole-image fallback:

| Rejected when                 | Why                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dehaze != 0`                 | atmospheric light and the dark channel are whole-frame statistics, and the transmission map is refined by a radius-60 guided filter — a full-frame proxy plane is the only correct tile form |
| `deep_denoise != 0`           | BM3D's reference-patch grid is frame-anchored; per-tile grids would seam                                                                                                                     |
| the DNG carries `OpcodeList3` | `WarpRectilinear` gathers from displaced positions past the pad, and the tile chain doesn't apply opcodes at all — tiled output would disagree with, and seam against, the full render       |

Two format conditions are rejected the same way: LinearRaw DNGs and Fuji X-Trans RAFs both go to the whole-image entry.

Each predicate deliberately mirrors the corresponding stage's own engage condition, so a model the full chain would skip the stage for is never needlessly pushed off the fast path.

### Chain order inside a tile

`develop.rs` runs the full develop chain minus the rejected stages, stage-traced with `tile_`-prefixed names: linearize region → hot-pixel → demosaic → baseline exposure → WB pre-gain → highlight recovery → DCP profile resolve and apply → highlight recovery in Oklab → profile gain-table map → chroma prefilter → capture sharpening → auto-exposure (threaded gain only) → white balance (delta or absolute) → scene tone controls → tone curves → vibrance → saturation → HSL → clarity → texture → local adjustments (windowed) → vignette (windowed) → sharpen → luminance NR → colour NR. Then the pad is trimmed, the result is downsampled to the requested output size, NaN/Inf is scrubbed, and EXIF orientation is applied.

For `RenderQuality::Preview` the demosaic is a half-res quad, so the trim coordinates halve too; `Full` and `Amaze` preserve dimensions.

## Caches

| Cache                         | Where                                 | Keyed on                                                                         | Scope                                                |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `RawImageCache`               | `MapleCore/Cache/RawImageCache.swift` | `(URL, mtime)`                                                                   | single entry, process-wide `.shared`, in-memory only |
| `NativeDetailRenderer` handle | `NativeDetailRenderer.swift`          | `(URL, source mtime, stripped baked model)`                                      | one handle per session                               |
| `TileManager` entries         | `MapleCore/Cache/TileManager.swift`   | `(url hash, sidecar mtime, view-transform version, zoom bucket, tile X, tile Y)` | byte-budget LRU, 256 MB                              |

`RawImageCache` holds the opaque `MapleRawHandle` from the rawler decode. It cannot be persisted to disk — the handle is a pointer to a heap-allocated decode result. Its most important property is the `pendingDecodes` map: without it, N concurrent tile requests each start their own decode, which on iPad meant 20 visible tiles triggering 20 parallel decodes of a 100 MP RAW at 7–22 s each under memory contention. Second-through-Nth callers now await the first caller's task.

`NativeDetailRenderer`'s handle key uses only decode-baked fields, so ordinary slider changes reuse the decoded mosaic and only baked-field edits (highlight recovery, for instance) reopen it. On reopen the old handle is released _before_ the new one opens, so the two decoded mosaics (30–300 MB each) never coexist.

## `TileManager` and the `deepZoomEnabled` gate

`EditSession.deepZoomEnabled` is declared in `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` as `nonisolated(unsafe) public static var deepZoomEnabled: Bool = false`. **It defaults to off.** It is public and non-isolated so a settings toggle, launch argument, or UI-test harness could flip it from any actor; nothing in the shipping app does.

The flag is off because the tile compositor publishes scene-linear tiles directly and runs each filter chain independently per tile, so local-context stages see different context at tile boundaries — visible as faint seams or per-tile colour shifts. The whole-image refine it defers to is slower at very high zoom (roughly 7 s for a 100 MP RAW on iPad) but has no seams. The native-detail path above then superseded it for the 100% case entirely, developing one patch instead of a grid.

The compositor itself, should it be revived, works like this. Tiles are 512² in oriented full-image source pixels. Zoom is quantized to buckets `{1, 2, 4, 8}` and clamps at 8× — past that the caller upscales 8× tiles. `update(asset:viewportSourceRect:zoom:totalSourceSize:)` returns immediately with a composite of whatever tiles are already cached, anchored to the full canvas extent, and fires one background `Task` per missing tile (deduplicated by an in-flight map). Callers subscribe to `events()`, an `AsyncStream<TileKey>` that yields once per insert; `EditSession` uses it to reschedule a refine so the composite progressively fills in. Missing regions are not black: `compositeWithPreviewUnderlay` places the tile composite over an upscaled copy of the existing preview.

Two subtleties worth keeping if the path is revived. The composite is anchored to a `CIImage(color: .clear)` cropped to the canvas rect, and cropped to that rect again on return — using `CIImage.empty()` leaves the extent as the bounding box of placed tiles only, and SwiftUI's `aspectRatio(.fit)` then stretches that strip into the frame, which looks like a wrong zoom. And tiles are placed with an explicit Y-flip (`height - (tileY+1) × tileSize`), because tile-grid rows run top-down while CoreImage's Y axis runs up; without it every tile is individually correct but the grid is upside-down.

`TileKey.viewTransformVersion` is currently `5`, bumped whenever the scene-linear chain or the view transform changes meaning so stale tiles become unreachable.

## Web

Web uses the same continuous zoom model. The CPU fallback keeps a sized whole-image base and, at `pixelScale >= 1`, develops one visible source patch through the retained `NativeDetailSession` WASM handle (#1107):

- `image-canvas.zoom-gestures.ts` — continuous `pixelScale`, pinch/wheel/keyboard, anchored zoom, pan clamp.
- `image-canvas.service.ts` — the `pixelScale` / `pan` signals and the Fit / 100% buttons.
- `image-canvas.two-phase.ts` — the fast/refine scheduler. Fast renders coalesce latest-wins: at most one render in the worker and one tick waiting behind it, with superseded results dropped by generation counter, because a WASM render cannot be interrupted mid-flight (so "cancel" means "discard the result").
- `image-canvas.draw2d.ts` — the target formulas and the 2D paint path.
- `image-canvas.native-detail.ts` — the single patch, source-rect containment, and stale-result guards. Its published rectangle has the same 25% pan margin (512 px total cap) as the Apple patch; raw-core adds the exact filter overlap internally.

On the GPU live path the persistent session holds resident buffers, so a tick is uniforms plus dispatch and the refine pass is skipped entirely (`gpuActive`).

The handle retains the decoded mosaic across pans. On the first patch for a completed CPU base, it repeats that bounded reference render at the base's actual quality and cap, retaining its AE gain and exact Auto curve/residual pair. Every subsequent patch reuses those anchors and the base's resolved film LUT; no patch-local histogram is used to fit exposure or Auto. Grain and quantization noise use full-source coordinates. The reference render is an initial cost, not a per-pan full-image develop.

Patch coordinates are display-oriented and relative to DNG DefaultCrop, matching the zoom service's native dimensions. The binding translates them to the shared tile core's oriented full-sensor coordinates, then runs the common display tail. The overlay uses the base canvas's pan/zoom transform, with the sized image always beneath it.

The patch's padded develop is capped at 8,388,608 pixels. This is a working-pixel limit, not a byte limit: the retained RAW, source bytes, reference render, and multiple intermediate RGB buffers also consume memory. After the large-radius stages finish, the core trims their consumed overlap before the sharpening/noise-reduction tail, retaining the exact remaining stencil reach. The reference render also obeys the existing WASM CPU develop cap for sensors above 32 MP. A new base decode, asset change, or canvas destruction releases the retained handle before another mosaic opens. Refine work has one in-flight request and one latest waiting view; synchronous WASM work finishes, but a superseded result is discarded.

GPU live rendering continues to skip CPU refinement. Non-RAW images, applied crops, the active crop tool, before/after comparison, X-Trans, LinearRaw, dehaze, BM3D, OpcodeList3, and patches exceeding the memory cap use the existing sized-render fallback. The native-detail path does not enable the old grid compositor. See [web](web.md) for the render worker and WASM/WebGPU details.

## Tools and tests

The Web native-detail browser check uses real production WASM and canvas pixels,
with WebGPU disabled to select the CPU fallback. Generate a small Bayer fixture,
build/sync WASM and the Hosted production app, then serve it with the existing
COOP/COEP server:

```bash
cd src/raw-pipeline
cargo run --release -p raw-core --features test-support --example gen-synthetic-dng -- \
  --width 2048 --height 1366 --out /tmp/native-detail-ui.dng
cd ../web
DIST="$PWD/dist/maple-syrup/browser" PORT=4417 bun scripts/serve-dist-coep.mjs
# In another terminal, from src/web:
node scripts/check-native-detail-browser.mjs http://127.0.0.1:4417 /tmp/native-detail-ui.dng
```

It checks actual 1:1 patch placement, a new pan rectangle without retransferring
the RAW, immediate base painting before async refinement, retained-handle close,
and an actual old worker result arriving after a photo switch without painting
on the new photo. The output reports base-paint and refinement times separately.

For a repeatable native stage profile, generate the default 12288×8192 fixture
with the same generator (omit `--width`/`--height`), then run:

```bash
MAPLE_PROFILE=1 RAYON_NUM_THREADS=8 cargo run --release -p raw-core \
  --example native-detail-profile -- /tmp/native-detail-100mp.dng
```

### Synthetic Web qualification, 2026-09-06

Windows, Chrome 152, eight real Rayon workers, canonical release WASM, generated
12288×8192 Bayer DNG without embedded JPEG or OpcodeList3. Model: exposure +0.4,
contrast +15, highlights −20, shadows +20, clarity +10, texture +5, remaining
defaults. The reference cap was 1600 px; native patches were 1600×1040, panned
400 source pixels each time.

| Actual WASM session operation                    | Measured time        |
| ------------------------------------------------ | -------------------- |
| Cold retained-handle open (bytes already loaded) | 1.55 s               |
| First patch, including reference anchors         | 16.34 s              |
| Three subsequent pans                            | 7.57 / 7.36 / 8.13 s |
| Reject oversized 3000×3000 patch                 | 1.38 ms              |
| Reopen after disposal                            | 0.41 s               |

All overlapping patch pixels were identical (maximum 0 code values). The
production Chromium heap guard reserved 3712 MiB before thread startup; the
WASM heap stayed at 3,892,772,864 bytes throughout the run and a second
open/render/dispose cycle, with freed handles and zero heap growth. That is
reserved heap capacity, not a measurement of live allocations or browser RSS.

This generated image exercises memory, geometry, and filter overlap. It cannot
qualify real-camera color or an embedded-JPEG Auto fit. Background native
refinement remains seconds long on this machine; these measurements do not
establish the 16 ms slider target or real-camera reference-scene performance.

The separate 2048×1366 production UI check measured 1.30 ms from the captured
browser wheel event to the base canvas draw, followed by native refinement at
3.56 s. This excludes automation-driver overhead; it does not measure the
display compositor's presentation time or a slider render.

Render one tile to a viewable PNG, without any UI, to sanity-check the tile math:

```bash
cd src/raw-pipeline
cargo run --release --bin maple-cli -- tile <RAW> \
  --src-x 2048 --src-y 1024 --src-w 512 --src-h 512 \
  --out-w 512 --out-h 512 --out /tmp/tile.png \
  --quality full            # preview | full | amaze
```

`--params <XMP>` applies a sidecar. The output is run through the CPU view tail (AgX, Rec.2020→sRGB) so it opens directly in Preview.app. This is a sanity check, not a gate.

The gates that do run in CI:

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib                     # includes the tile geometry + guard tests
cargo test -p raw-core --features test-support   # adds the live-vs-tile parity sweep
cargo test -p raw-core --features test-support --lib pipeline::render::detail
```

The parity sweep (`pipeline/tile/tests_live_parity.rs`, plus `tests_live_parity_gaps.rs`) is the important one. It renders the same fixture and `AdjustmentModel` through both the live/refine chain and the tile develop and diffs them, which is precisely the comparison that was missing when a white-balance mismatch shipped as a visible horizontal band where refined tiles met the live canvas. The two paths express the same edit through different algebras — the live chain applies a Rec.2020 delta on top of an already-developed buffer, while the tile chain applies white balance in camera space before the DCP and retargets the profile — so the sweep is what proves they agree, and the gaps file pins the identity case (parked at the decode anchor, both must reproduce the decode buffer itself). `tests_full_parity.rs` is the other half: the tile against the whole-image develop, which is the oracle for the stages the live chain cannot exercise — vignette and local adjustments (bit-exact, given the window), capture sharpening, and a case with every spatial slider engaged (within a float-ordering ceiling). It is fixture-free by construction, built on a synthesised Bayer chart, so it runs on every CI machine. Fixture-gated tile-vs-full comparisons live in `tests_render_anchors.rs`.

Apple-side coverage is in `src/apple/Packages/MapleCore/Tests/MapleCoreTests/`: `NativeDetailLODTests` (the three-rect geometry), `NativeDetailAEGainTests` (that `aeGain: 1.0` through the new FFI binding is bit-identical to the old entry, and that a raised gain actually brightens), `NativeDetailExitForcesFreshRenderTests`, `TileManagerByteBudgetTests` (LRU eviction), and `DeepZoomTileRenderingTests`.

See [pipeline](pipeline.md) for the develop chain the tile path is a subset of, [caching](caching.md) for the rest of the cache hierarchy, and [testing](testing.md) for the full gate list.
