# The Rust raw pipeline

Every pixel Maple shows on any platform comes out of one Rust cargo workspace at `src/raw-pipeline/`. A RAW file is decoded to a sensor mosaic, demosaiced into camera-native RGB, colour-corrected into a scene-referred working space (linear Rec.2020 at D65, f32, unbounded), pushed through ~20 editing stages that never clip, and only then compressed into a display image by a single view transform (AgX) plus a gamma encode and a quantizer. That whole chain lives in `raw-core` as portable Rust with no platform dependencies; `raw-gpu` re-implements the interactive subset as wgpu/WGSL compute kernels gated against the Rust functions; `raw-ffi` and `raw-wasm` wrap the same code as a C ABI and a WebAssembly module so the Apple, Windows, server, and browser shells all render identical pixels; `maple-cli` drives it headlessly for the parity harnesses; and `codegen` emits the constants and schema mirrors the other languages compile against.

The two invariants that shape everything below: nothing before the view transform clips, and the CPU implementation in `raw-core` is the reference every other implementation is measured against.

## Crate map

| Crate        | Path                          | What it is                                                                                                                                                                                                                |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw-core`   | `src/raw-pipeline/raw-core`   | All image math: decode, demosaic, colour, every stage, the view transform, XMP, export encoders. No platform deps.                                                                                                        |
| `raw-gpu`    | `src/raw-pipeline/raw-gpu`    | Headless wgpu + WGSL port of the interactive stages, plus the live session and the platform present paths. Pulled in only via the `gpu` feature of `raw-core`/`raw-ffi`/`raw-wasm`, so default builds never compile wgpu. |
| `raw-ffi`    | `src/raw-pipeline/raw-ffi`    | C ABI (`staticlib`/`cdylib`) for Apple's `RawPipeline.xcframework`, Windows P/Invoke, and the server's `bun:ffi` dylib. Thin marshalling only.                                                                            |
| `raw-wasm`   | `src/raw-pipeline/raw-wasm`   | `wasm-bindgen` surface for the Angular workspace.                                                                                                                                                                         |
| `maple-cli`  | `src/raw-pipeline/maple-cli`  | Deterministic headless renderer used by every parity/diagnostic harness.                                                                                                                                                  |
| `codegen`    | `src/raw-pipeline/codegen`    | Emits Swift / TypeScript / SCSS / XAML / WGSL mirrors of raw-core constants.                                                                                                                                              |
| `maple-pano` | `src/raw-pipeline/maple-pano` | Panorama stitching — see [pano](pano.md). It consumes `raw-core`'s pano ingest entry (`pipeline::decode_for_pano`) but is otherwise its own subsystem.                                                                    |

## Decode

`raw_core::decode` wraps **rawler 0.7** — `decode_bytes(bytes, ext)` is the primary entry and `decode(path)` is a `std::fs::read` wrapper over it, so the browser (which has no filesystem) and native callers share one code path. The extension is passed to rawler as a filename hint because several formats are not magic-byte-distinguishable. Foveon X3F is detected on that hint and rejected with a structured "unsupported format" error rather than rawler's internal stub message.

Decode produces a `RawImage` (`raw-core/src/image.rs`): the mosaic `Vec<u16>`, black/white levels per CFA position, the CFA pattern, and the metadata the colour chain needs — `AsShotNeutral` (inverted from rawler's reciprocal WB multipliers so it matches the DNG spec's semantics), `UniqueCameraModel`, `BaselineExposure`, `ColorMatrix1/2`, `ForwardMatrix1/2`, `ProfileHueSatMapData1/2`, `ProfileToneCurve`, `ProfileGainTableMap`, `DefaultCrop*`, EXIF orientation, ISO, noise profile, aperture and focal length.

Three decode-path details are worth knowing:

- **Embedded matrices are only trusted from real DNG tags.** `color_matrices` is populated only when the source file itself shipped `ColorMatrix1`/`ColorMatrix2`. Vendor RAWs (`.cr2`, `.arw`, `.nef`, `.fff`, …) leave it empty even though rawler substitutes its own dcraw-lineage matrices internally, because surfacing those measurably regressed colour.
- **`LinearizationTable` is not applied by Maple.** rawler already applies it inside the decoder; `raw_core::linearize` documents this explicitly so nobody double-remaps it.
- **Two mosaic shapes.** `CfaPattern::LinearRgb` marks a LinearRaw/DNG-Converter file whose data is already interleaved RGB; it skips the mosaic path entirely via `linearize::linearraw_to_camera_rgb`. `CfaPattern::XTrans` routes to the X-Trans demosaicers. Everything else is Bayer.

DNG `OpcodeList3` (tag 51022) is parsed at decode time by `raw-core/src/pipeline/pano/opcodes/` and applied post-demosaic by `pipeline/pano/opcode_apply/`. Three opcodes are implemented: `GainMap` (id 9, a bilinearly-interpolated per-plane gain lattice — vignette/shading), `WarpRectilinear` (id 1, geometric distortion + lateral CA as a full-image inverse-map resample), and `FixVignetteRadial` (id 3). They run in list order, in `ActiveArea`-relative coordinates, and — unlike the DNG SDK — the result is deliberately _not_ clamped to 1.0, because the working space is unbounded. `ProfileGainTableMap` (tag 52525, DNG 1.6 § 6.8; found in a SubIFD by `raw-core/src/dng_ifd_walker.rs`) is parsed onto `RawImage` but not applied: the spec pairs it with the profile's `ProfileToneCurve` as a vendor look layer, which #425 dropped (see `color/profile_gain_table_map.rs` and #2774).

`decode_cache.rs`, `preview.rs` (embedded-JPEG extraction, shared by native and browser), `jpeg.rs`, `png.rs`, `tiff.rs`, `avif.rs` and `icc.rs` round out the I/O surface.

## The develop chain

`raw-core/src/pipeline/develop/mod.rs` holds the single funnel every full-image render goes through — `develop_scene_linear_from_raw_with_quality` and its cancellable / AE-gain-returning variants. `pipeline/develop_sized.rs` is the same chain with a downsample inserted right after demosaic (see "Sized and tile renders"). Stages, in the order they actually run:

| #   | Stage                                       | Implementation                                             | Working space                                                                  |
| --- | ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `linearize` (or `linearraw_decode`)         | `linearize.rs`                                             | raw codes → normalized `[0,1]` camera mosaic                                   |
| 2   | `hot_pixel`                                 | `stages/hot_pixel.rs`                                      | raw mosaic domain                                                              |
| 3   | `demosaic`                                  | `demosaic/{half_res,bilinear,hamilton_adams,amaze,xtrans}` | camera-native linear RGB                                                       |
| 4   | `opcode_list3`                              | `pipeline/pano/opcode_apply/`                              | camera RGB, ActiveArea coords                                                  |
| 5   | `crop_to_default` (DNG `DefaultCrop`)       | `pipeline/develop/geometry.rs`                             | camera RGB                                                                     |
| 6   | `baseline_exposure`                         | inline in `develop/mod.rs`                                 | camera RGB (one gain per channel)                                              |
| 7   | WB pre-gain (divide by `AsShotNeutral`)     | `stages/white_balance.rs`                                  | camera RGB                                                                     |
| 8   | `highlight_recovery`                        | `stages/highlight_recovery.rs`                             | camera RGB, post-pre-gain; sensor ceilings include BaselineExposure (#3267)    |
| 9   | `wb_camera::apply` (user temperature/tint)  | `stages/wb_camera.rs`                                      | camera-native linear RGB                                                       |
| 10  | `dcp::apply_colorimetry`                    | `color/dcp.rs`, `color/hsm.rs`                             | camera RGB → linear ProPhoto D50 (CM/FM + HSM) → **scene-linear Rec.2020 D65** |
| 11  | `highlight_recovery_oklab`                  | `stages/highlight_recovery_oklab.rs`                       | scene-linear Rec.2020, via Oklab                                               |
| 12  | `chroma_prefilter`                          | `stages/chroma_prefilter.rs`                               | scene-linear Rec.2020                                                          |
| 13  | `deep_denoise` (BM3D)                       | `stages/bm3d/`                                             | scene-linear Rec.2020                                                          |
| 14  | `capture_sharpening` (Richardson–Lucy)      | `stages/capture_sharpening.rs`                             | scene-linear Rec.2020, luma plane                                              |
| 15  | `auto_exposure`                             | `stages/auto_exposure/`                                    | scene-linear Rec.2020                                                          |
| 16  | `white_balance` (CAT16, fallback path only) | `stages/white_balance.rs`                                  | scene-linear Rec.2020                                                          |
| 17  | `scene_tone_controls`                       | `stages/scene_tone_controls/`                              | scene-linear Rec.2020                                                          |
| 18  | `tone_curves`                               | `stages/tone_curves/`                                      | scene-linear Rec.2020                                                          |
| 19  | `vibrance`                                  | `stages/vibrance.rs`                                       | Oklab                                                                          |
| 20  | `saturation`                                | `stages/saturation.rs`                                     | Oklab                                                                          |
| 21  | `hsl` (8-band)                              | `stages/hsl.rs`                                            | Oklab                                                                          |
| 22  | `clarity`                                   | `stages/clarity.rs`                                        | scene-linear Rec.2020, luma guided filter                                      |
| 23  | `texture`                                   | `stages/texture.rs`                                        | same, finer radius                                                             |
| 24  | `dehaze`                                    | `stages/dehaze.rs`                                         | scene-linear Rec.2020                                                          |
| 25  | `local_adjustments`                         | `stages/local_adjustments/`                                | scene-linear Rec.2020                                                          |
| 26  | `vignette`                                  | `stages/vignette.rs`                                       | scene-linear Rec.2020                                                          |
| 27  | `sharpen`                                   | `stages/sharpen.rs`                                        | scene-linear Rec.2020, luma-only USM                                           |
| 28  | `nr_luminance`                              | `stages/noise_reduction.rs` → `stages/nlm.rs`              | Oklab L plane                                                                  |
| 29  | `nr_color`                                  | same                                                       | Oklab a/b planes                                                               |

The develop function returns the scene-linear `Image` (and, on the `_with_gain` entries, the scalar gain auto-exposure applied — the tile path threads that back in so a tile reproduces the full-image anchor).

`RenderQuality` (`pipeline/mod.rs`) picks the demosaic: `Preview` uses the half-res quad kernel (4× fewer pixels downstream, and the buffer comes back at half dimensions — callers scale it themselves), `Full` uses bilinear (or Hamilton-Adams under the `high-quality-demosaic` feature), and `Amaze` uses the tiled AMaZE kernel and is `maple-cli`'s default. Cancellation is cooperative: `CancelToken` is threaded into demosaic, BM3D, capture sharpening, sharpen and both NR stages, and checked between the heavy stages, so a superseded cold open unwinds mid-stage instead of finishing an 8-second denoise nobody wants.

### Colour management

**DCP profiles.** `color/dcp.rs` builds a `DcpProfile` — a camera→XYZ `ColorMatrix` at the scene illuminant, an optional `ForwardMatrix` (white-balanced camera RGB → XYZ-D50 per the DNG SDK, _not_ XYZ→ProPhoto), the scene white point, and an optional HueSatMap. Dual-illuminant profiles interpolate CM, FM and HSM together by reciprocal CCT (`interpolated_profile`). Apply runs CM/FM chromatic adaptation plus HSM metameric correction in linear ProPhoto D50, then converts to Rec.2020. Adobe's aesthetic layers — `ProfileToneCurve` and `ProfileLookTable` — deliberately do **not** run: they were calibrated under Adobe's tone mapping and stacking them on AgX produced compound hue errors.

`profile_for_with_source` resolves in tiers, reported as a `ProfileSource`: `EmbeddedFull` (the DNG ships CM + FM + HSM — an internally consistent vendor triad, used whole), `BundleConfident` (a byte-exact `UniqueCameraModel` hit in Maple's bundled table), `EmbeddedCmOnly`, and `RawlerFallback` (no calibration for this body — synthesises an XYZ-D65→Rec.2020 matrix, which is visibly imperfect but bounded, and is logged once per model).

The bundle is `raw-core/src/color/profiles/profiles.bin`, embedded with `include_bytes!` and read by `color/profile_loader/`. Coverage is tracked in the sibling `COVERAGE.md`. The format has an inline v1 layout and a v3 split layout that dedups HueSatMap tables into a zlib-compressed pool with an offset directory (matrices alone are ~210 KB for ~1,447 profiles; with HSM inline the bundle balloons to tens of megabytes). `maple-cli transcode-dcp` repacks v1 → v3.

**White balance.** Temperature/tint are applied in camera-native linear RGB _upstream_ of DCP (`stages/wb_camera.rs`), matching ACR: the gain is `as_shot_neutral[c] / target_neutral_camera[c]`, a purely diagonal per-channel scale bounded by what the sensor can physically report. When user WB moves off as-shot, `retargeted_render_profile` re-interpolates only the ForwardMatrix at the target's CCT; the Bradford source stays at the true as-shot chromaticity. The slider _frame_ (`wb_camera::SliderFrame`) prefers the DNG's own embedded calibration when present, because that is the scale ACR's displayed numbers are defined in. Two paths fall back to the older post-DCP CAT16 matrix in scene-linear Rec.2020 (`stages/white_balance.rs`): LinearRaw sources and `RawlerFallback` bodies. `WbMethod` selects `Cat16` (default) or the legacy `DiagonalRec2020`. Sidecars carry a `WbScaleVersion` stamp so values authored under an older tint scale are converted on load rather than silently reinterpreted.

**Highlight recovery.** `HighlightRecoveryMode` defaults to `ChromaticAdaptation`, which runs pre-DCP in camera RGB where the per-channel ceiling after baseline exposure and WB pre-gain is `2^BaselineExposure / AsShotNeutral[c]` rather than 1.0. The clipping tolerance receives the same baseline-exposure gain as the pixels and ceilings; otherwise sufficiently negative exposure makes even black look clipped. `OklabChromaReduction` is an opt-in variant that instead runs post-DCP in scene-linear Rec.2020, scaling Oklab `a`/`b` by a common factor so hue is preserved by construction. `Blend` and `Luminance` are legacy XMP values silently upgraded to `ChromaticAdaptation`.

### Auto exposure, Auto Profile, Auto Adjustments

Three separate things share the word "auto":

- **Auto exposure** (`stages/auto_exposure/`) is a per-image scene anchor, on by default, inside the develop chain. It measures the geometric mean of luma over the middle 50 % percentile band plus the 95th percentile, takes the larger of `0.18/midgrey` and `0.85/p95` capped at 8× (+3 EV), and multiplies. Its purpose is to land every camera at the same point on the AgX sigmoid. User exposure stacks additively in EV downstream, and `papp:AutoExposure="Off"` makes the stage a bit-identical no-op.

- **Auto Profile** (`view/auto_profile/`) is a per-image _view_ tail selected by `papp:Profile="Auto"`: extract the camera's embedded JPEG preview, fit a per-channel tone curve against it in f32 sRGB-encoded display space, then fit a residual 3D LUT on top of the curved buffer. It layers on top of AgX rather than replacing it. When a fit is predicted to succeed, the render pins auto-exposure Off so the fitted curve owns the whole scene→JPEG brightness relationship. Results are cached in a bounded LRU keyed on `(raw identity, mtime, quality, fit origin, fit-model version)` (mtime applies to path keys; fit origin distinguishes standalone, render-size and curve-only producers); a post-LUT Oklab gamut guard runs after it so the terminal quantizer cannot hard-clip a pushed colour.
- **Auto Adjustments** (`stages/auto_adjustments.rs`) is a one-shot recommendation for all eight tone/WB sliders, derived from one probe develop with auto-exposure off, WB pinned to D65, and highlight recovery disabled so reconstructed chromaticity cannot vote as sensor evidence (#3267). Its `exposure` output _replaces_ the anchor, so a caller writing it back must also set `papp:AutoExposure="Off"`. The white-balance half (`stages/auto_adjustments_awb.rs`, #2247) maps each probe pixel back to post-gain camera RGB through the inverse of the chain's own render matrix, drops anything at a sensor clip ceiling (`2^BaselineExposure · pre_gain · wb_gain` per channel), re-centres its chroma gate on the running estimate (seeded from where a neutral surface under the camera's as-shot reading lands in the probe — the as-shot gain on a calibrated body, plain neutral in the post-DCP tier), blends gray-world and white-patch as G-normalised chromaticities, and solves the result in the DNG slider frame — the same Robertson path `dcp::estimate_as_shot_cct_tint` uses — so a develop at the recommendation neutralises the population it was measured on. Its CI gate is the fixture-tier agreement with the as-shot reading plus idempotence on its own recommendation.

**Auto is the shipped default, by design (settled 2026-09-04, CLAUDE.md principle 8).** Neutral's flatness is AgX's headroom working as intended; Auto restores the colour and contrast the photographer expects by fitting the camera's embedded preview. Neutral is a selectable mode, not the default. Auto vs Neutral measures grand mean ΔE2000 5.98 across the fixture set, and the server's `thumb`/`preview` stages fit the same embedded JPEG, so the default keeps the grid thumbnail and the full view in agreement.

### The view transform and output

After develop, `pipeline/render/mod.rs` runs the display tail:

1. **AgX** (`view/agx.rs`) — inset matrix → ratio-preserving sigmoid applied to `max(R,G,B)` with RGB scaled by the ratio (hue-invariant by construction) → outset matrix → hue-preserving Oklab gamut compression into `[0,1]³`. The sigmoid is a baked 512-entry `f32` LUT (`view/agx_lut.bin`); the coefficients and matrices in `view/agx_coeffs.rs` are derived by `src/scripts/derive_agx_lut.py`. Output space is display-linear Rec.2020. `model.contrast` modulates the sigmoid slope about mid-grey.
2. **`color_grade`** (`stages/color_grade.rs`) — three-zone (shadow/midtone/highlight) plus global hue+saturation and per-zone lightness offsets, in display-linear Oklab, with the zone axis being Oklab `L` and the balance slider warping that axis.
3. **`film_look`** (`stages/film_look.rs`) — an optional baked `.mlut` film-print LUT, sampled tetrahedrally in the encoded-sRGB lattice domain and blended back by strength. The pack lives at `resources/film-luts/` and the 100-entry catalog is `raw-core/src/film_catalog.rs`; the codec is `raw-core/src/film.rs`. A host that cannot resolve the asset passes `None` and gets a bit-identical no-look render.
4. **`grain`** (`stages/grain.rs`) — display-linear, so its amplitude does not swing with exposure.
5. **`rec2020_to_display`** (`view/encode.rs`) — the primaries matrix, `TargetPrimaries::Srgb` (0) or `P3` (1), with Oklab soft gamut compression (`color/oklab_gamut.rs`) rather than a hard clip.
6. **`srgb_gamma_encode`** — IEC 61966-2-1 transfer function, identical for both primaries.
7. **Auto Profile curve + residual LUT + gamut guard**, when the profile is `Auto`.
8. **Quantize** — `encode::dither_and_quantize` (8-bit) or `view/quantize16.rs` (16-bit for TIFF masters, quantized straight off f32 rather than promoted from 8-bit). Both add ±0.5 LSB of deterministic 64×64 blue-noise jitter (`view/dither.rs`, void-and-cluster, zero DC bias) so smooth gradients read as fine noise instead of contour bands.
9. **Geometry tail** — `pipeline/render/finish.rs` applies EXIF orientation and then the user crop, depth-generically, so the canvas render and the export master frame identically.

`render_display_scene` is the shared body; `render_display_from_raw` finishes at 8 bits and `pipeline/render/export.rs` finishes at `ExportDepth::Eight` or `Sixteen`. `raw-core/src/export.rs` encodes the result to JPEG/PNG/TIFF and tags every file with a real ICC profile written by `raw-core/src/icc.rs` — an untagged Display P3 file would be re-stretched as sRGB by every viewer, so tagging is what makes the P3 option mean anything.

### The per-tick chain

`pipeline/scene_linear_chain.rs` is what the editor actually calls on a slider tick when the GPU path is unavailable. It takes an already-decoded fp16 or f32 RGBA scene-linear Rec.2020 buffer and re-applies only the model-dependent stages: `white_balance::apply_delta` → `scene_tone_controls` → `tone_curves` → `vibrance` → `saturation` → `hsl` → `clarity` → `texture` → `dehaze` → `local_adjustments` → `vignette` → `sharpen` → `nr_luminance` → `nr_color` → `agx` → `color_grade` → `grain` → display encode. White balance is applied as a _delta_ against the temperature/tint the buffer was decoded at (carried in `ChainOptions`), so opening a saved sidecar does not double-apply WB; when the decode exported a `SliderFrameExport`, the delta is derived in that same camera-calibration frame, which is what closes the live-vs-refine seam. `ChainOptions::skip_agx` turns off the whole display tail for non-RAW inputs (a JPEG/HEIF already carries a baked tone curve).

This chain is both the CPU oracle for the GPU live chain and its no-GPU fallback, which is why it runs `sharpen` and `nr_color` even though they are the expensive pair — the GPU path is the one held to the 16 ms tick budget.

### Sized and tile renders

`develop_sized` inserts `downsample_image_area` immediately after demosaic, so every post-demosaic stage runs on a viewport-sized buffer — roughly 8× less work when a 100 MP sensor is being shown in a 3 MP viewport. Profile labels are prefixed `sized_` so traces do not collide with the full-res ones.

`pipeline/tile/` linearizes only a padded crop region and runs a stripped develop chain on it, then trims the overlap and packs oriented fp16/f32 RGBA. Auto-exposure is never recomputed per tile (a tile's histogram is not the scene's) — the caller threads in the gain the full-image develop measured. `TILE_OVERLAP_PX` is pinned by a const-assert to clarity's guided-filter reach (`2 × CLARITY_GUIDED_RADIUS`); stages whose stencil does not fit — dehaze, vignette, deep denoise, local adjustments, capture sharpening — are rejected loudly at the entry rather than rendered wrong. See [zoom](zoom.md).

## The GPU path

`raw-gpu` is a headless wgpu 23 crate: a `GpuContext` (device, queue, lazily-compiled pipeline cache), a `GpuImage` uploaded **once**, and a `ChainRunner` that executes an ordered `Vec<Box<dyn Pass>>` by ping-ponging two scratch buffers with exactly one readback for the whole chain and cooperative cancellation. Every buffer is f32 RGBA; fp16 exists only at the FFI transport boundary (`pipeline/fp16.rs` packs and unpacks it, and `pipeline::finite_or_zero` scrubs NaN/Inf at the pack endcaps because sampling NaN in a GPU texture is implementation-defined).

Ported stages, each parity-gated directly against its `raw-core` function rather than a hand-copied oracle: capture sharpening, white balance, scene tone controls, tone curves, vibrance, saturation, HSL, clarity, texture, dehaze, local adjustments, vignette, sharpen, NLM luma, NLM colour, colour grade, film LUT, grain, AgX, display encode, sRGB gamma, Auto Profile curve, residual LUT, and the terminal dither. Auto exposure stays on the CPU. Spatial stages (clarity/texture/dehaze/NLM/sharpen/capture sharpening) stay a single `Pass` each but orchestrate a small DAG or a dispatch loop over scratch planes via the shared `spatial.rs` primitives, because the WGSL downlevel baseline allows only four storage buffers per kernel. `local_adjustments` sits AT that same ceiling too (#3271): a `Mask::Bitmap` layer's raster pixels ride a fourth storage buffer (the concatenated "mask plane", alongside the src/dst/layer-stack buffers), leaving no headroom for a fifth.

`full_chain.rs` composes the canonical chain unconditionally; `live_chain.rs` is the caller that _gates_ pass inclusion from the live `AdjustmentModel` using the same thresholds raw-core's `apply` functions early-return on, so a neutral model omits every no-op pass. The view tail always runs. `live_session.rs` holds the resident state across ticks so a slider move allocates no new GPU buffers and recompiles no pipelines. Present paths are per-platform and `#[cfg]`-gated: `CAMetalLayer` on Apple, `SwapChainPanel` on Windows, a WebGPU `OffscreenCanvas` on the web, all sharing `present_chain.wgsl` and `present_chain_pipeline.rs`.

The vectorscope scope pass (#3272, spec §4/§5.4) is a side channel off the live chain, not a `Pass`: `scope_vectorscope.wgsl` reads the chain's FINAL buffer (after the view tail, before dither) and bins it into a 128×128 Rec.709 Cb/Cr histogram with integer atomics, weighted per pixel by the alpha lane — `local_adjustments.wgsl` writes one layer's mask×range weight there instead of the untouched upload alpha when `ScopeRequest.layer` names a target, so the histogram can show "just this mask's colours" without a second render. `LiveSession` owns a pair of `MAP_READ` staging buffers and alternates between them every tick (`live_session/scope.rs`): each render REQUESTS an async map of its own sample and reports whichever OTHER slot's map has already completed — always the PREVIOUS tick's, one tick late, and `take_scope_stats` only polls, never blocks, so a still-in-flight map costs nothing and is retried on the next call. A dithered-and-requantized u8 frame is deliberately not treated as a valid oracle for cross-checking the histogram in tests — see `live_session/tests_scope.rs`'s module doc for why quantization alone can move a large fraction of total bin weight with no individual pixel being wrong; only a full-precision f32 readback is a valid comparison.

Constants the kernels bake in are generated, not hand-typed: `src/generated/color_matrices.wgsl` (Rec.2020↔sRGB/P3 and the Oklab pair) and `src/generated/agx_coeffs.wgsl` (inset/outset matrices and the log-encode scalars). The Rust pipeline accessors prepend those modules before compiling a kernel — WGSL has no `#include` — and `src/scripts/check_wgsl.sh` reproduces that concatenation to run naga's front-end and validator on CPU, so shader breakage is caught on a runner with no GPU.

## The FFI surface

`raw-ffi` is thin marshalling over `raw-core`: type shims, pointer helpers, error codes, and a `LAST_ERROR` thread-local read back through `maple_last_error`. The generated header is `RawPipeline.h`, produced by cbindgen (config in `raw-ffi/cbindgen.toml`) as part of `src/apple/scripts/build-xcframework.sh`, not by `tools/codegen.sh`. Platform-specific entries are wrapped by cbindgen `[defines]` mappings — `__APPLE__`, `TARGET_OS_IOS`, `_WIN32`.

Entry families:

| Family                               | Entries                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Display-encoded render               | `maple_render_file`, `maple_render_bytes`, `maple_render_file_with_film`                                                                                                                                                                                                                                                                                                                                                                               |
| Scene-linear fp16 RGBA               | `maple_render_{file,bytes}_scene_linear[_sized]`, `maple_render_{file,bytes}_scene_linear_tile`                                                                                                                                                                                                                                                                                                                                                        |
| Scene-linear f32 RGBA                | the `_f32` siblings of the above                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Handle model                         | `maple_open_raw_handle[_bytes]`, `maple_render_handle_scene_linear_tile[_f32,_ae_f32]`, `maple_close_raw_handle`                                                                                                                                                                                                                                                                                                                                       |
| Per-tick chain                       | `maple_apply_scene_linear_chain[_f32][_with_patches]`, `maple_apply_chain_and_encode_display_f32`, `maple_apply_chain_and_encode_display_scoped_f32` (#3272 — the CPU-fallback vectorscope scope pass), `maple_encode_display_srgb_f32`                                                                                                                                                                                                                |
| GPU live (feature `gpu`)             | `maple_gpu_live_open/render/close`, `maple_gpu_present_chain`, `maple_gpu_present_chain_winui[_scaled]`, `maple_gpu_fit_auto_profile`, `maple_gpu_exposure_parity`                                                                                                                                                                                                                                                                                     |
| Auto / profile                       | `maple_compute_auto_adjustments`, `maple_compute_auto_tone`, `maple_compute_profile_curve`, `maple_compute_profile_lut`, `maple_compute_auto_profile_lut`, `maple_compute_look_lut`                                                                                                                                                                                                                                                                    |
| Derivatives                          | `maple_export_developed_to_file`, `maple_render_develop_jpeg_to_file`, `maple_render_thumbnail_avif_to_file`, `maple_render_thumbnail_preview_jpeg_to_file`, `maple_histogram_{file,bytes}`                                                                                                                                                                                                                                                            |
| Utility                              | `maple_blake3_hex`, `maple_id_primary/fallback`, the streaming `maple_fallback_id_hasher_*`, `maple_render_filename_template[_buf]`, `maple_validate_filename`, `maple_film_lut_decode`, `maple_cancel_flag_*`, `maple_set_deep_denoise_progress`, `maple_free_*`, `maple_mask_raster_register/release` (#3271 — the process-wide bitmap-mask raster registry `Mask::Bitmap` resolves against; see `docs/xmp-canonical-format.md` § Local adjustments) |
| Panorama (feature `pano`/`pano-ios`) | `maple_pano_stitch`, `maple_pano_ort_selftest`                                                                                                                                                                                                                                                                                                                                                                                                         |

The **handle model** (`raw-ffi/src/handle.rs`) is what makes deep zoom viable: `maple_open_raw_handle` decodes the RAW and parses the XMP once and keeps both alive behind an opaque pointer, so a 100 MP decode runs once per asset open instead of once per tile. Re-rendering with a different model means closing and reopening — the handle never mutates its stored model. Callers must free it; failing to do so leaks tens to hundreds of megabytes.

The Apple xcframework is built by `src/apple/scripts/build-xcframework.sh` for `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-apple-darwin` and `x86_64-apple-darwin`, always with `--features gpu` plus `pano` (macOS) or `pano-ios` (iOS). The server's dylib is built by `src/api/scripts/build-raw-ffi.sh` into `src/api/native/`. See [apple](apple.md) and [api](api.md).

## The WASM surface

`raw-wasm` exports, via `wasm-bindgen`: `render_bytes` / `render_bytes_sized` / `render_bytes_with_film` (8-bit sRGB), `render_bytes_scene_linear[_sized]` (fp16 RGBA), `develop_non_raw` (an already-decoded scene-linear f32 RGBA buffer through the per-tick chain with AgX skipped), `export_bytes[_with_film]`, `extract_embedded_preview`, `compute_auto_tone`, `compute_auto_adjustments_from_bytes`, `compute_profile_lut`, `render_filename_template` / `validate_filename`, the streaming `FallbackIdHasher`, and — under the `gpu` feature — `render_bytes_gpu` (one-shot) and the persistent `WebLiveSession` (open → render(xmp)\* → drop, presenting straight to a transferred `OffscreenCanvas` with no CPU readback).

Build it with `src/raw-pipeline/raw-wasm/build.sh`, never a bare `wasm-pack build`:

```bash
cd src/raw-pipeline/raw-wasm && bash build.sh
cd ../../web && bash scripts/sync-raw-wasm.sh
```

The script runs `wasm-pack build --target web --release --features gpu,parallel -Z build-std=panic_abort,std`. The `-Z build-std` is not optional: `raw-wasm/.cargo/config.toml` sets `-C target-feature=+atomics,+bulk-memory,+mutable-globals` for `wasm32-unknown-unknown`, and the standard library has to be rebuilt with the same features for atomics to link. Those features only become _usable_ when the page is cross-origin isolated (COOP `same-origin` + COEP `require-corp`); JS checks `crossOriginIsolated` before calling `initThreadPool`, and the single-threaded path works everywhere else. The same config passes `--max-memory=4294967296` — 4 GiB is the wasm32 hard ceiling, and it still does not fit a full-resolution develop of a large sensor, which is why `raw-wasm/src/cpu_budget.rs` clamps every CPU render entry. One bundle ships both features; the worker picks the GPU entry when `'gpu' in navigator` and falls back to threaded CPU otherwise. See [web](web.md).

## maple-cli

The headless reference renderer. Subcommands (`maple-cli/src/commands/`):

| Subcommand                       | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `render`                         | RAW + optional XMP → PNG/JPEG/TIFF. `--demosaic` (`amaze` default), `--profile` (`xmp`/`auto`/`neutral`), `--film-lut-dir`.        |
| `batch`                          | Renders every case in a JSON manifest — the engine behind the colour-parity gate.                                                  |
| `diff`                           | Two PNGs through `compare_images.py`; prints JSON, exits non-zero past `--budget`.                                                 |
| `inspect`                        | Parsed `AdjustmentModel` for an `.xmp`, or RAW metadata for a RAW.                                                                 |
| `tile`                           | One source-pixel tile to PNG — validates the tile math without a UI.                                                               |
| `extract-preview`                | The camera's embedded preview JPEG. Exit 3 means "readable RAW, no preview" so harnesses can skip.                                 |
| `auto-tone` / `auto-adjustments` | JSON slider recommendations.                                                                                                       |
| `auto-tail-ramp`                 | Auto Profile tail ramps + stage dumps for the banding gate (needs `--features stage-dump`).                                        |
| `synthetic`                      | Synthetic scene-linear input through the view transform or the slider chain — drives the banding / hue-stability / halo harnesses. |
| `fit-acr`                        | Solves view-transform parameters against ACR-rendered charts (needs `--features test-support`).                                    |
| `film-pack`                      | Ingests an external `.cube` pack into the committed `.mlut` pack + `film_catalog.rs`.                                              |
| `transcode-dcp`                  | Repacks a v1 `profiles.bin` into the v3 split layout.                                                                              |
| `pano`                           | Panorama stitching (needs `--features pano`).                                                                                      |

## codegen

`tools/codegen.sh` builds and runs the `codegen` binary, then writes the cross-language mirrors. It is idempotent, and `.github/workflows/cross.yml`'s `codegen-drift` job fails if the committed outputs differ from a fresh generation.

| Schema           | Source                                                           | Outputs                                                                                                           |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `adjustment`     | `raw_core::types::ADJUSTMENT_SCHEMA` + `PIPELINE_OUTPUT_VERSION` | `AdjustmentModel+Generated.swift`, `adjustment-model.generated.ts`, `adjustment-tables.generated.ts`              |
| `ui-tokens`      | `raw_core::ui_tokens`                                            | `UITokens.swift` (MapleCore **and** MapleUI), `ui-tokens.ts`, `_ui-tokens.scss`, `Maple.WinUI/Themes/Tokens.xaml` |
| `color-matrices` | `raw_core::color::{matrices,oklab}`                              | `raw-gpu/src/generated/color_matrices.wgsl`, `color-matrices.generated.ts`                                        |
| `agx-coeffs`     | `src/scripts/derive_agx_lut.py`                                  | `raw-gpu/src/generated/agx_coeffs.wgsl`                                                                           |
| `film-catalog`   | `raw_core::film_catalog::FILM_CATALOG`                           | `FilmCatalog+Generated.swift`, `film-catalog.generated.ts`                                                        |

`agx_coeffs.rs`, `agx_lut.bin` and the Apple-bundled LUT copy are deliberately _not_ regenerated here; they belong to the AgX derivation workflow in `derive_agx_lut.py`. The cbindgen header step belongs to the xcframework build.

## Pipeline output version

`raw-core/src/version.rs` holds `PIPELINE_OUTPUT_VERSION: u32` — currently **2**. It is a monotonic counter that answers "when the meaning of a stored sidecar changes, how does every derived artifact know it is stale?" Bump it by one, in the same commit, whenever a change alters the develop pipeline's pixel output for any input, or silently reinterprets an already-stored `AdjustmentModel` value with no load-time converter. Adding a slider at an identity default, fixing a non-output-visible bug, or changing an estimator that only runs when no value is authored do not bump it. The current lineage: 1 = the initial epoch, 2 = `FixVignetteRadial` opcodes started being parsed and applied.

It reaches the platforms through codegen (`AdjustmentModel.pipelineOutputVersion` in Swift, `PIPELINE_OUTPUT_VERSION` in TypeScript), and rendered-output caches fold it into their keys so one bump invalidates stale entries everywhere at once. It is the cheap default; `WbScaleVersion` is the richer per-field alternative used where preserving the authored look justifies writing a converter. See [caching](caching.md) and [xmp-canonical-format](xmp-canonical-format.md).

## Diagnostics and profiling

`MAPLE_PROFILE` still exists. `pipeline::stage()` wraps every stage with an `Instant::now()` and, when the variable is **set to anything at all** (existence, not value — `MAPLE_PROFILE=0` enables it; only `unset` disables it), prints `[raw-core] <stage_name>  <elapsed>` to stderr. It is compiled into release builds because the cost when unset is one `Instant::now()` and one `getenv`. On `wasm32` there is no `std::time::Instant`, so the wrapper is a pass-through.

Other environment switches: `MAPLE_STAGE_DUMP` (with `--features stage-dump`) writes one OpenEXR per stage into the named directory for `src/scripts/stage_diff.py`; `MAPLE_DISABLE_AUTO_PROFILE`, `MAPLE_DISABLE_AUTO_LUT` and `MAPLE_AUTO_LUT_STRENGTH` gate the Auto Profile tail; `MAPLE_DISABLE_BUNDLED_PROFILES` forces the embedded/fallback DCP paths; `MAPLE_BE_OVERRIDE` is a dev-only absolute `BaselineExposure` override. These are development and harness affordances, not product configuration.

Diagnostic examples under `raw-core/examples/` include `dump_pixel` and `dump_scene_linear` (per-stage values at one pixel), `inspect-camera`, `probe-crop`, `wb_camera_probe`, `wb_gamut_probe`, `mem-probe`, and the `nlm_bench` / `clarity-bench` / `downsample-bench` / `tick-tail-bench` micro-benchmarks. Run them with `cargo run --release -p raw-core --example <name> -- <args>`.

## Build and test

```bash
cd src/raw-pipeline

cargo test -p raw-core --features test-support   # fixture-free unit tests
cargo test -p raw-ffi --lib                      # FFI shim guards
cargo test -p raw-gpu                            # WGSL kernels vs their raw-core stage
cargo test -p raw-wasm --features gpu            # render_bytes_gpu vs the CPU path
cargo build -p raw-ffi --features gpu
cargo check -p raw-wasm --all-features --all-targets
```

```bash
bash src/scripts/check_wgsl.sh              # naga front-end + validator, no GPU needed
bash src/scripts/test_color_pipeline.sh     # end-to-end perceptual gate vs ACR references
bash src/scripts/test_synthetic_grey.sh
bash src/scripts/test_synthetic_color_chart.sh
bash src/scripts/test_grey_adjustments.sh
bash src/scripts/test_grey_dcp.sh
bash src/scripts/test_banding.sh
```

`.github/workflows/raw-pipeline.yml` runs all of the above; the GPU job installs Mesa lavapipe as a software Vulkan adapter and fails closed if no adapter is reported. RAW fixtures are gitignored, so the fixture-dependent gates skip-pass on stock runners. The full gate inventory, budget files and the ratchet rule are in [testing](testing.md).
