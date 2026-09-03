# Zoom and tile rendering

Maple's canvas has one zoom number — `pixelScale`, real screen pixels per image pixel — shared by the Apple and Web editors. `0` means fit-to-viewport, `1.0` means pixel-perfect 100% (one image pixel on one _device_ pixel, so 100% is genuinely 1:1 on a Retina display), and the cap is `8.0`. Everything downstream is a consequence of that number: at fit, both platforms render the whole image at viewport resolution and nothing more; zoomed in past 100%, rendering a full 100 MP frame would be wasteful and, on iOS, fatal, so Apple switches to developing **only the visible rectangle of source pixels** through a dedicated tile entry point in the Rust core. The Rust tile path pads the requested rectangle by 48 px per edge so filters that read neighbouring pixels still see context, then trims the pad away — but several stages reach further than that pad or are anchored to the whole frame, so the tile entry _refuses_ those models and the caller falls back to a bounded whole-image render. Web has no tile adoption: it uses the same zoom model and the same two-phase scheduler, but every phase is a whole-image sized render.

There are two distinct tile consumers on Apple, and only one of them is live. `NativeDetailRenderer` (on) develops a single viewport-sized patch and paints it as an overlay above the base preview. `TileManager` (off, behind `EditSession.deepZoomEnabled = false`) is the older 512²-grid compositor.

## The zoom model

| Concept           | Apple                                                      | Web                                          |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Zoom state        | `CanvasZoomModel.pixelScale`                               | `ImageCanvasService.pixelScale` signal       |
| Fit sentinel      | `0`, resolved by `CanvasMath.effectivePixelScale`          | `0`, resolved by `fitPixelScale()`           |
| Maximum           | `CanvasZoomModel.maxPixelScale = 8.0`                      | `MAX_PIXEL_SCALE = 8`                        |
| Snap back to fit  | at or below `fit × 1.02` (`snapToFitTolerance`)            | at or below `fit × 1.02` (`FIT_SNAP_FACTOR`) |
| Mid-gesture floor | pinch anchors on a start-captured scale                    | `fit × 0.5` rubber band (`FIT_UNDERSHOOT`)   |
| Keyboard step     | `zoomStep = 1.25` (⌘= / ⌘-)                                | ⌘/Ctrl+0 = fit, ⌘/Ctrl+1 = 100%              |
| Wheel zoom        | `exp2(deltaY × wheelZoomSensitivity)`, sensitivity `0.015` | Cmd+wheel / ctrl-wheel trackpad pinch        |

Apple's state machine is `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/CanvasZoomModel.swift` — a pure, testable value type holding scale, pan, and the pinch-start captures. It exists because `MagnifyGesture.magnification` is _cumulative_: multiplying it into the live scale every frame compounds exponentially, so each frame re-derives scale and pan from the values captured at pinch start rather than from the previous frame. The same model exposes gesture arbitration as intents rather than leaving each host to re-derive the rules: `dragIntent` is `.editing` at fit and `.pan` when zoomed; `wheelIntent(commandHeld:)` is `.zoom` with Cmd, otherwise `.pan` when zoomed and `.editing` at fit. Double-tap behaviour is per-surface — the editor toggles fit ↔ 100%, because pixel-perfect is what you need to judge noise reduction and sharpening.

Web mirrors all of it in `src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.zoom-gestures.ts`, including the anchored-zoom pan formula that keeps the image point under the cursor stationary, and a pan clamp that allows at most `(imageCss − wrapCss) / 2` per axis so the image edge can meet the viewport edge but a gap can never open.

The always-visible zoom percentage badge lives at the viewport's bottom-leading corner on Apple (`src/apple/Maple/Views/CanvasZoomHost.swift`, accessibility identifier `canvas-zoom-indicator`). On iOS `pixelScale` is frozen during a pinch — the zoom is a compositor transform — so the badge reads a live scale value instead; macOS updates `pixelScale` continuously.

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

### The 48-pixel overlap, and what doesn't fit in it

`TILE_OVERLAP_PX = 48`. The pad is sized from clarity's stencil: the guided filter at radius 20 box-blurs a buffer that was itself box-blurred at radius 20, so its effective reach is 40 px, and 48 is that rounded up with headroom. A compile-time `const` assertion ties the constant to `clarity::CLARITY_GUIDED_REACH_PX`, so raising the clarity radius fails the build until the pad follows. Everything else tile-safe sits comfortably inside: demosaic 2 px, hot-pixel suppression ≤ 3 px, chroma prefilter ±4 px, colour NR ≤ 4 px, texture ≈ 4 px, sharpen ≤ 9 px.

One admitted stage reaches further than any fixed pad, and its reach scales with the image: the highlights/shadows detail mask, a luma blur at σ = 15 px · longEdge/2000 run twice in cascade (`scene_tone_controls::sh_mask_reach_px`). Since #2476 that blur is anchored to the full frame's long edge at the tile's develop resolution (`scene_tone_controls::apply_with_mask_anchor`, via `tile::develop::full_frame_long_edge`) rather than to the padded crop, so a tile and the whole-image render compute the same radius — anchoring on the crop had made the mask scale a function of tile geometry and the two renders disagree across the whole tile interior. When either slider is engaged the pad grows to the mask's reach (`tile_overlap_px` in `tile/mod.rs`, converted back to mosaic pixels for a `Preview` develop): 552 px per edge on a 12288-px frame at 100%, and nothing extra when both sliders are zero. That is the exact-overlap half of the stage-class plan; the proxy-plane half for large radii is #1157.

The pad is why a tile render is fast rather than a full develop: the core linearizes **only** the padded crop. On a ~12288×8192 sensor a 512 px tile plus overlap is roughly 582×582 px — around 10 ms rather than the ~480 ms a full-sensor linearize costs, which is what turns a 23-tile view from ~10 minutes into ~10 seconds.

Six model conditions are rejected at the entry with an `Err`, which the FFI maps to code `10` and the Apple caller turns into a whole-image fallback:

| Rejected when                     | Why                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dehaze != 0`                     | radius 67 px exceeds the 48 px pad                                                                                                                                                     |
| `vignette_amount != 0`            | the stage is anchored to the full frame and the tile window isn't threaded through                                                                                                     |
| `deep_denoise != 0`               | BM3D's reference-patch grid is frame-anchored; per-tile grids would seam                                                                                                               |
| any non-identity local adjustment | mask weights are in full-image-normalized coordinates                                                                                                                                  |
| capture sharpening active         | the iterated Richardson–Lucy stencil reaches ~96 px at the σ = 8 clamp                                                                                                                 |
| the DNG carries `OpcodeList3`     | `WarpRectilinear` gathers from displaced positions past the pad, and the tile chain doesn't apply opcodes at all — tiled output would disagree with, and seam against, the full render |

Two format conditions are rejected the same way: LinearRaw DNGs and Fuji X-Trans RAFs both go to the whole-image entry.

Each predicate deliberately mirrors the corresponding stage's own engage condition (for instance, a local-adjustment layer with no `Some` fields is a no-op for the full chain and therefore stays tile-renderable), so a model the full chain would skip the stage for is never needlessly pushed off the fast path.

### Chain order inside a tile

`develop.rs` runs a subset of the full develop chain, stage-traced with `tile_`-prefixed names: linearize region → hot-pixel → demosaic → baseline exposure → WB pre-gain → highlight recovery → DCP profile resolve and apply → highlight recovery in Oklab → profile gain-table map → chroma prefilter → auto-exposure (threaded gain only) → white balance (delta or absolute) → scene tone controls → tone curves → vibrance → saturation → HSL → clarity → texture → sharpen → luminance NR → colour NR. Then the pad is trimmed, the result is downsampled to the requested output size, NaN/Inf is scrubbed, and EXIF orientation is applied.

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

There is no tile or deep-zoom code in the Angular workspace — a search of `src/web/projects` for tile rendering, deep zoom, or the tile FFI symbols turns up nothing but unrelated UI "tile" naming (grid cells, map tiles, kanban cards). Web zoom is the same model driving whole-image sized renders:

- `image-canvas.zoom-gestures.ts` — continuous `pixelScale`, pinch/wheel/keyboard, anchored zoom, pan clamp.
- `image-canvas.service.ts` — the `pixelScale` / `pan` signals and the Fit / 100% buttons.
- `image-canvas.two-phase.ts` — the fast/refine scheduler. Fast renders coalesce latest-wins: at most one render in the worker and one tick waiting behind it, with superseded results dropped by generation counter, because a WASM render cannot be interrupted mid-flight (so "cancel" means "discard the result").
- `image-canvas.draw2d.ts` — the target formulas and the 2D paint path.

On the GPU live path the persistent session holds resident buffers, so a tick is uniforms plus dispatch and the refine pass is skipped entirely (`gpuActive`).

Consequence: on Web, zooming past 100% does not sharpen beyond a native-resolution whole-image render, and there is no viewport-bounded develop. See [web](web.md) for the render worker and WASM/WebGPU details.

## Tools and tests

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
```

The parity sweep (`pipeline/tile/tests_live_parity.rs`, plus `tests_live_parity_gaps.rs`) is the important one. It renders the same fixture and `AdjustmentModel` through both the live/refine chain and the tile develop and diffs them, which is precisely the comparison that was missing when a white-balance mismatch shipped as a visible horizontal band where refined tiles met the live canvas. The two paths express the same edit through different algebras — the live chain applies a Rec.2020 delta on top of an already-developed buffer, while the tile chain applies white balance in camera space before the DCP and retargets the profile — so the sweep is what proves they agree, and the gaps file pins the identity case (parked at the decode anchor, both must reproduce the decode buffer itself). It is fixture-free by construction, built on a synthesised Bayer chart, so it runs on every CI machine. Fixture-gated tile-vs-full comparisons live in `tests_render_anchors.rs`.

Apple-side coverage is in `src/apple/Packages/MapleCore/Tests/MapleCoreTests/`: `NativeDetailLODTests` (the three-rect geometry), `NativeDetailAEGainTests` (that `aeGain: 1.0` through the new FFI binding is bit-identical to the old entry, and that a raised gain actually brightens), `NativeDetailExitForcesFreshRenderTests`, `TileManagerByteBudgetTests` (LRU eviction), and `DeepZoomTileRenderingTests`.

See [pipeline](pipeline.md) for the develop chain the tile path is a subset of, [caching](caching.md) for the rest of the cache hierarchy, and [testing](testing.md) for the full gate list.
