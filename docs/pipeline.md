# Image Pipeline & Editing

The image pipeline takes a RAW (or standard) file from disk and develops it through a **scene-referred Rust core** (`src/raw-pipeline/raw-core`): decode → linearize → demosaic → a scene-linear adjustment chain → a single view transform (AgX) → display encode. The same crate runs on every platform — compiled to a static library for Apple (via C-FFI) and to WebAssembly for the Web. Platform GPU paths (wgpu + WGSL, epic #925) mirror the Rust reference and are gated against it for pixel parity.

The working space is **linear Rec.2020 D65 at f32**. Exposure is a linear multiply; nothing before the view transform clips. See [Architecture](./architecture.md) for the cross-platform shape.

---

## Decode → scene-linear develop

The canonical funnel is `develop_scene_linear_from_raw_with_quality` in `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs`. Every full-image entry point (CLI, WASM, the Apple FFI, the parity harness) runs through it, so all platforms develop identically. The stages, in order:

```
RAW file on disk
  │
  ▼
decode (rawler)  →  RawImage  (CFA mosaic, EXIF, DCP tags, AsShotNeutral, crop rect)
  │
  ├─ 1.  linearize            (sensor values → linear; black/white-level normalize)
  ├─ 2.  hot_pixel            (#1106; pre-demosaic outlier suppression — Off by default)
  ├─ 3.  demosaic             (Bayer: half-res / bilinear / Hamilton-Adams / AMaZE by
  │                            RenderQuality; X-Trans: bilinear / Markesteijn)
  ├─ 4.  crop_to_default      (DNG DefaultCrop — drop optical-black border)
  ├─ 5.  baseline_exposure    (DNG BaselineExposure gain, scene-linear multiply)
  ├─ 6.  white_balance pre-gain(divide camera RGB by AsShotNeutral → neutral = (1,1,1))
  ├─ 7.  highlight_recovery   (per-channel clip reconstruction)
  ├─ 8.  wb_camera            (#1726; camera-space user WB — a per-channel diagonal
  │                            gain in camera-native linear RGB, ACR's own pre-DCP
  │                            approach. Primary WB path for the three calibrated
  │                            ProfileSource tiers (EmbeddedFull, BundleConfident,
  │                            EmbeddedCmOnly); a no-op for RawlerFallback, which
  │                            carries no real per-camera calibration matrix)
  ├─ 9.  dcp::apply_colorimetry(ColorMatrix/ForwardMatrix + HSM in linear ProPhoto-D50 —
  │                            the ForwardMatrix path multiplies straight through; the
  │                            non-FM fallback inverts ColorMatrix to camera→XYZ, then
  │                            Bradford-adapts the as-shot scene white to D50 — then
  │                            gamut-convert to scene-linear Rec.2020 D65)
  ├─ 10. highlight_recovery_oklab (opt-in Oklab chroma reduction; no-op by default)
  ├─ 11. profile_gain_table_map (DNG 1.6 spatially-varying gain, when present)
  ├─ 12. chroma_prefilter     (#1104; decode-time chroma denoise — 0 by default)
  ├─ 13. deep_denoise         (#1105; BM3D collaborative filtering — 0 by default)
  ├─ 14. capture_sharpening   (Richardson-Lucy deconvolution — 0/Off by default)
  │  ── end of the cached "decode product"; the stages below re-run per slider tick ──
  ├─ 15. auto_exposure        (#429; per-image scene anchor — measures mid-gray,
  │                            multiplies toward 0.18 so every camera lands on the same
  │                            AgX point. On by default; opt out via papp:AutoExposure="Off")
  ├─ 16. white_balance        (post-DCP fallback — CAT16 chromatic adaptation by default,
  │                            or the legacy per-channel DiagonalRec2020 gain via
  │                            papp:WbMethod; scene-linear Rec.2020. Runs only when
  │                            wb_camera above did NOT apply — RawlerFallback or 8-bit
  │                            lossy LinearRaw — the two WB stages are mutually exclusive)
  ├─ 17. scene_tone_controls  (#1103 DAG: exposure, brightness #1102, contrast→AgX slope,
  │                            highlights, shadows, whites, blacks)
  ├─ 18. tone_curves          (parametric + per-channel R/G/B curves — identity by default)
  ├─ 19. vibrance
  ├─ 20. saturation
  ├─ 21. hsl                  (#1112; 8-band per-hue H/S/L — identity by default)
  ├─ 22. clarity              (midtone local contrast, large-radius unsharp)
  ├─ 23. texture              (fine-detail local contrast, small-radius unsharp)
  ├─ 24. dehaze
  ├─ 25. local_adjustments    (#280; masked region edits — empty by default)
  ├─ 26. vignette             (#1109; scene-linear radial gain)
  ├─ 27. sharpen              (output sharpening; default amount 40)
  ├─ 28. nr_luminance         (luminance noise reduction)
  └─ 29. nr_color             (color noise reduction; default 25)
  │
  ▼
Image in ColorSpace::SceneLinearRec2020  (unbounded f32, no clipping yet)
```

Stages whose slider sits at its default short-circuit to a **bit-identical** no-op, so the parity-harness baseline is unchanged when a feature lands.

### White balance

White balance is not a single "CAT16" step; three distinct chromatic-adaptation strategies are in play, gated by which `dcp::ProfileSource` tier an image resolved to and by how the resolved DCP profile is shaped. The full design writeup lives in the `stages::wb_camera` module doc (`src/raw-pipeline/raw-core/src/stages/wb_camera.rs`, ticket #1726).

The primary path is the camera-space diagonal gain in `stages::wb_camera::apply`. For the three calibrated tiers — `EmbeddedFull`, `BundleConfident`, and `EmbeddedCmOnly`, every source that carries a real per-camera `ColorMatrix` — the Temperature/Tint sliders apply as a per-channel gain in camera-native linear RGB, upstream of DCP, matching where ACR itself applies its WB sliders. `wb_camera::camera_wb_gain` computes `gain[c] = as_shot_neutral[c] / target_neutral_camera[c]`, where the target neutral is the camera-native reading a scene patch neutral under the slider's `(temperature, tint)` would produce through the calibration matrix (`wb_camera::SliderFrame`, re-interpolated at the target's own CCT for dual-illuminant DNGs). Bounding the gain to what the sensor can physically report per channel is what fixes the posterization/banding #1726 was opened for — the old post-DCP matrix could push saturated pixels outside Rec.2020 at extreme slider settings, and the pipeline's hard gamut clip then collapsed those pixels to a flat plate. `wb_camera::apply` is a no-op for the `RawlerFallback` tier: its calibration matrix is a synthetic Rec.2020-primaries stand-in, not a real per-camera calibration, so projecting a target chromaticity through it would be meaningless.

The fallback path is the post-DCP matrix in `stages::white_balance::apply`, which runs only when `wb_camera` above did not — the `RawlerFallback` tier (no usable calibration at all) and 8-bit lossy LinearRaw DNGs (where the converter has already baked WB into the pixels and the pre-gain stage is skipped). This stage applies Temperature/Tint as a matrix in scene-linear Rec.2020, after DCP, and supports two methods selected by `papp:WbMethod` (`WbMethod` in `types::adjustment`): **CAT16** (the default) is a proper cone-space chromatic-adaptation transform per Li, Ronnier, Pointer, Hellwig, Melgosa & Cui (2017), built in `wb_cat16_matrix`; **DiagonalRec2020** is the legacy per-channel diagonal gain (`wb_gains`), kept for parity A/B comparison and known to introduce hue error at extreme WB settings. `wb_camera` and this stage are mutually exclusive per image — never stacked.

Independent of either slider-driven stage, DCP's own camera→ProPhoto-D50 colorimetric transform (`dcp::apply_colorimetry`) performs its own chromatic adaptation whenever the resolved profile lacks a ForwardMatrix, or pre-gain was skipped: it inverts `ColorMatrix` to camera→XYZ, then Bradford-adapts from `scene_white_xyz` — the image's as-shot scene illuminant — to D50. When a ForwardMatrix is present and pre-gain ran, DCP instead multiplies straight through by the ForwardMatrix with no runtime Bradford step. `scene_white_xyz` always stays at the image's true as-shot chromaticity; it is never retargeted by the user's WB sliders, so the camera-space gain (or the post-DCP matrix) remains the sole carrier of the user's WB cast. Only the ForwardMatrix itself gets re-interpolated at the slider's target CCT (`wb_camera::retargeted_render_profile`), mirroring the DNG spec's `SetWhiteXY` semantics.

The CCT/tint mapping itself changed under #1894: both the calibrated-tier slider frame and the as-shot estimate that seeds an unedited image's sliders now go through the same Robertson (1968) isotherm solve the DNG SDK uses to derive the temperature/tint pair ACR displays (`color::dng_temperature`, a port of `dng_temperature.cpp`), replacing the earlier Hernández-Andrés-locus-plus-perpendicular-uv-displacement construction. `wb_camera::target_xyz` (via `white_balance::slider_source_xy`) maps a `(temperature, tint)` slider pair forward to source-illuminant CIE xy on the calibrated path; `dcp::estimate_as_shot_cct_tint` runs the inverse — camera-native `AsShotNeutral` → xy → `(temperature, tint)` — to seed an unedited image at its own as-shot point. The uncalibrated fallback tier (`wb_gains` / `wb_cat16_matrix`) still evaluates the older Hernández-Andrés daylight locus, since those bodies have no ACR references to fit a Robertson mapping against.

Sidecars carry a `papp:WbScaleVersion` tag (`WbScaleVersion`, V1 through V5) recording which slider-value convention a stored `crs:Temperature`/`crs:Tint` pair was authored under — the meaning of the same numeric pair changed as the WB implementation evolved (#1756 moved WB from post-DCP to camera-space; #1893/#1894 changed the tint scale and the CCT/tint curve). `wb_camera::resolve_target_versioned` and `white_balance::resolve_wb` re-express an older-versioned pair in the current convention before either WB stage runs, so previously-authored sidecars keep rendering the look they were saved with.

### Decode product vs. per-tick chain

The expensive, model-independent work — decode, demosaic, DCP, the decode-time denoise stages, and auto-exposure — is run once and its result cached as an fp16/f32 RGBA buffer in scene-linear Rec.2020. On every slider tick only the cheap, model-dependent stages re-run, via `apply_scene_linear_chain` in `src/raw-pipeline/raw-core/src/pipeline/scene_linear_chain.rs`:

```
white_balance (delta) → scene_tone_controls → tone_curves → vibrance → saturation
  → hsl → clarity → texture → dehaze → local_adjustments → vignette → nr_luminance
  → [view tail: agx → split_tone → grain]
```

The per-tick chain deliberately omits `sharpen` and `nr_color` — those stay on the platform GPU path (Metal / WGSL compute) because sharpen at viewport size exceeds the 16 ms tick budget on CPU. The stage order matches `develop_scene_linear_from_raw_with_quality` exactly so the color-pipeline harness stays the single canonical metric.

The per-tick `white_balance (delta)` step re-derives the WB shift between the live slider value and the WB the cached decode product was rendered at, rather than an absolute WB — so a slider tick never re-derives the full DCP-relative transform. When the decode exported a calibrated-tier `wb_camera::SliderFrameExport` (#1781), the delta is computed in that same camera-calibration frame, closing the seam between a live GPU tick and a cold/refine render; otherwise it falls back to the legacy post-DCP CAT16 (or DiagonalRec2020) delta from `white_balance::apply_delta`.

The early-downsample variant `develop_scene_linear_sized_from_raw_with_quality` (in `pipeline/develop_sized.rs`) downsamples to fit the viewport immediately after demosaic, so every later stage runs on the smaller buffer — this is the fast-phase cold-open path.

---

## View transform (AgX + Auto Profile)

A single view transform at the end of the chain compresses the unbounded scene-linear range into display range. It lives in `src/raw-pipeline/raw-core/src/view/`.

```
scene-linear Rec.2020 (unbounded)
  │
  ├─ AgX (view/agx.rs)            Sobotka AgX: inset matrix → ratio-preserving sigmoid
  │                              (sigmoid on max(R,G,B), RGB scaled by sigmoid_norm/norm
  │                              so hue is invariant) → outset matrix → Oklab hue-preserving
  │                              gamut compression to [0,1]³.  Contrast modulates the slope.
  │  → display-linear Rec.2020 [0,1]
  ├─ split_tone (stages/split_tone.rs)   #1111; display-linear Oklab shadow/highlight tint
  ├─ grain (stages/grain.rs)             #1110; display-linear deterministic hash noise
  ├─ display encode (view/encode.rs)     Rec.2020 → sRGB / display-P3 via the Oklab-aware
  │                              rec2020_to_srgb (#877), then srgb_gamma_encode.
  ├─ Auto Profile (view/auto_profile/)   #536; per-image tone residual fit from the embedded
  │                              JPEG preview, applied on the display-ENCODED sRGB buffer —
  │                              i.e. AFTER rec2020_to_srgb + srgb_gamma_encode (#550).
  │                              Profile = "Auto" (default) or "Neutral" (AgX-only, no residual).
  └─ dither + quantize (view/encode.rs)  optional blue-noise dither, then pack to 8-bit / fp16.
  │
  ▼
display-encoded pixels (sRGB / display-P3, 8-bit or fp16)
```

The AgX matrices, sigmoid coefficients, and LUT are derived by `src/scripts/derive_agx_lut.py` and emitted as `agx_coeffs.rs` (constants) + `agx_lut.bin` (512×f32, `include_bytes!`-embedded). Apple bundles a byte-identical `agx_lut.bin`; the Web/GPU side uses `raw-gpu/src/agx.wgsl` (a hand-written WGSL shader that prepends generated constant blocks — `raw-gpu/src/generated/agx_coeffs.wgsl` and `color_matrices.wgsl` — at module creation time; `tools/codegen.sh` generates those constant files, not `agx.wgsl` itself). Cross-platform AgX parity at 1e-4 per channel is a CI gate.

**Profile.** The `papp:Profile` enum chooses between **Auto** (fit a per-image CDF tone curve from the camera's embedded JPEG so output tracks the camera maker's rendering) and **Neutral** (the scene-referred AgX transform alone). Auto Profile runs _after_ AgX as a per-channel residual — AgX owns chroma and cross-channel coupling; the curve only nudges tone. The retired static "Look" LUT (`papp:Look`, ticket #371 → retired #443) survives as a no-op enum for sidecar back-compat; the `look` field still parses but does nothing.

---

## Slider ranges & defaults

Authoritative source: `ADJUSTMENT_SCHEMA` in `src/raw-pipeline/raw-core/src/types/adjustment/schema/mod.rs`. This table is single-sourced from there and mirrored to Swift / TypeScript by `tools/codegen.sh`.

| Slider                | Field                             | Range          | Default | Stage                                             |
| --------------------- | --------------------------------- | -------------- | ------- | ------------------------------------------------- |
| Temperature           | `temperature`                     | 2000 … 12000 K | 6500    | wb_camera (calibrated) / white_balance (fallback) |
| Tint                  | `tint`                            | -100 … +100    | 0       | wb_camera (calibrated) / white_balance (fallback) |
| Exposure              | `exposure`                        | -4 … +4 EV     | 0       | scene_tone_controls (linear mult)                 |
| Brightness            | `brightness`                      | -100 … +100    | 0       | scene_tone_controls (#1102)                       |
| Contrast              | `contrast`                        | -100 … +100    | 0       | scene_tone_controls → AgX slope                   |
| Highlights            | `highlights`                      | -100 … +100    | 0       | scene_tone_controls                               |
| Shadows               | `shadows`                         | -100 … +100    | 0       | scene_tone_controls                               |
| Whites                | `whites`                          | -100 … +100    | 0       | scene_tone_controls                               |
| Blacks                | `blacks`                          | -100 … +100    | 0       | scene_tone_controls                               |
| Parametric Highlights | `parametric_highlights`           | -100 … +100    | 0       | tone_curves                                       |
| Parametric Lights     | `parametric_lights`               | -100 … +100    | 0       | tone_curves                                       |
| Parametric Darks      | `parametric_darks`                | -100 … +100    | 0       | tone_curves                                       |
| Parametric Shadows    | `parametric_shadows`              | -100 … +100    | 0       | tone_curves                                       |
| Vibrance              | `vibrance`                        | -100 … +100    | 0       | vibrance                                          |
| Saturation            | `saturation`                      | -100 … +100    | 0       | saturation                                        |
| Clarity               | `clarity`                         | -100 … +100    | 0       | clarity                                           |
| Texture               | `texture`                         | -100 … +100    | 0       | texture                                           |
| Dehaze                | `dehaze`                          | -100 … +100    | 0       | dehaze                                            |
| Sharpen Amount        | `sharpen_amount`                  | 0 … 150        | **40**  | sharpen                                           |
| Sharpen Radius        | `sharpen_radius`                  | 0.5 … 3.0      | 1.0     | sharpen                                           |
| Sharpen Detail        | `sharpen_detail`                  | 0 … 100        | 25      | sharpen                                           |
| Sharpen Masking       | `sharpen_masking`                 | 0 … 100        | 0       | sharpen                                           |
| Capture Sharpening    | `capture_sharpening_amount`       | 0 … 100        | 0       | capture_sharpening (RL deconv)                    |
| Capture Sharpen Sigma | `capture_sharpening_sigma`        | 0.5 … 2.0      | 1.0     | capture_sharpening                                |
| NR Luminance          | `nr_luminance`                    | 0 … 100        | 0       | nr_luminance                                      |
| NR Color              | `nr_color`                        | 0 … 100        | **25**  | nr_color                                          |
| Chroma Pre-filter     | `chroma_prefilter`                | 0 … 100        | 0       | chroma_prefilter (#1104)                          |
| Deep Denoise          | `deep_denoise`                    | 0 … 100        | 0       | deep_denoise / BM3D (#1105)                       |
| Vignette Amount       | `vignette_amount`                 | -100 … +100    | 0       | vignette (#1109)                                  |
| Vignette Feather      | `vignette_feather`                | 0 … 100        | 50      | vignette                                          |
| Grain Amount          | `grain_amount`                    | 0 … 100        | 0       | grain (#1110)                                     |
| Grain Size            | `grain_size`                      | 0 … 100        | 25      | grain                                             |
| Grain Roughness       | `grain_roughness`                 | 0 … 100        | 50      | grain                                             |
| Split-tone Shadow Hue | `split_tone_shadow_hue`           | 0 … 360°       | 0       | split_tone (#1111)                                |
| Split-tone Shadow Sat | `split_tone_shadow_saturation`    | 0 … 100        | 0       | split_tone                                        |
| Split-tone Hi Hue     | `split_tone_highlight_hue`        | 0 … 360°       | 0       | split_tone                                        |
| Split-tone Hi Sat     | `split_tone_highlight_saturation` | 0 … 100        | 0       | split_tone                                        |
| Split-tone Balance    | `split_tone_balance`              | -100 … +100    | 0       | split_tone                                        |

Enum fields (defaults in **bold**): `wb_method` = **Cat16** (chromatic adaptation) / DiagonalRec2020 — selects the method the post-DCP _fallback_ white-balance stage uses; it has no effect on `wb_camera`'s camera-space gain, which is the primary path on calibrated images (see [White balance](#white-balance)); `highlight_recovery` = **ChromaticAdaptation** / OklabChromaReduction / …; `auto_exposure` = **On** / Off; `profile` = **Auto** / Neutral; `tone_curve_mode` = **PerChannel** / RatioPreserving; `hot_pixel_suppression` = **Off** / On.

---

## Render entry points

`render_scene_linear_from_raw_with_quality` (and the `_sized`, `_f32`, and `_cancellable` variants in `pipeline/render/scene_linear.rs`) run the develop chain, pack to fp16/f32 RGBA, apply EXIF orientation, and hand the **scene-linear** buffer to the platform view transform. The cold-open fast phase routes through the cancellable sized entry so a slider tick during a long decode can unwind mid-stage (#951 — the ~8.5 s `nr_color` on a 100 MP frame is the freeze the cancel token interrupts).

- **Apple**: on the default wgpu path (#1066), the f32 scene-linear buffer is uploaded to the GPU and the full view transform (AgX, split-tone, grain, display encode) plus sharpen/NR run as WGSL compute shaders, presenting via wgpu → CAMetalLayer — this present path has no CIImage filter chain. The CPU/Metal fallback (`MAPLE_GPU_LIVE=0`) runs the same Rust FFI view-transform chain to produce a 3-D LUT, then applies it via a `CIColorCubeWithColorSpace` filter (CoreImage) plus Metal kernels for sharpen/NR; the Rust core computes the color math, CoreImage applies it.
- **Web**: on WebGPU-capable browsers the live canvas defaults to the GPU live path (`WebLiveSession` / `render_bytes_gpu`) with the `render_bytes` WASM-CPU path as fallback; the canvas surface is tagged **display-P3**.

`RenderQuality` selects the demosaic kernel: `Preview` (half-res Bayer, fast), `Full` (bilinear or Hamilton-Adams), `Amaze` (AMaZE / Markesteijn, export quality).

---

## Two-phase rendering

To keep sliders responsive while supporting pixel-perfect zoom:

| Phase      | Debounce    | Target                      | Purpose                                   |
| ---------- | ----------- | --------------------------- | ----------------------------------------- |
| **Fast**   | immediate   | viewport size, cancellable  | Immediate feedback during slider drag     |
| **Refine** | ~150ms idle | full image, full resolution | Crisp pixels once the user stops dragging |

After the refine completes, the rendered preview is persisted to the disk cache (see [Caching](./caching.md)) so future cold-opens of the same image are instant. The rendered-preview cache key includes the adjustment version and the view-transform version, so a pipeline change invalidates stale previews.

---

## Export

The export path develops the full-resolution image at `RenderQuality::Amaze`, runs the full adjustment chain + view transform, optionally resizes to a long-edge constraint, and encodes to the requested format (JPEG / HEIC / TIFF-16 / PNG). Because the develop chain is the same one the editor uses, an export is pixel-identical to the on-screen full-resolution refine.

---

## Non-destructive editing & sidecars

Every edit is non-destructive: the original file is never modified. Adjustments serialize to an **XMP sidecar** (`crs:` namespace for Adobe-compatible fields, `papp:` for Maple-specific fields like `papp:Profile`, `papp:Brightness`, `papp:AutoExposure`). The sidecar is the contract; the pixels are derived. See [`sidecar-schema.md`](./sidecar-schema.md) for the schema and [Architecture](./architecture.md) for how the Swift and TypeScript writers stay in lockstep.
