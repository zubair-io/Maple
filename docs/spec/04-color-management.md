# 04 — Color Management

Profiles, working spaces, scene-referred vs display-referred, view transform, gamut handling, bit-depth transitions. This document tracks the colorspace and reference state of every pixel at every stage of the pipeline.

The single most important rule: **know which space and reference state a value is in at all times**. Bugs in this system are rarely obvious — they manifest as "slightly wrong pinks," "shadows too dense on P3 displays," or "neon signs that clip to cyan," and they take days to track down.

Stage order is in [`02-pipeline.md`](./02-pipeline.md); algorithm math is in [`03-algorithms.md`](./03-algorithms.md).

---

## Premise: scene-referred with a replaceable view transform

Maple is a **scene-referred editor**. The interactive working texture holds linear, physically-meaningful scene values — they can and do exceed 1.0 (diffuse white is nominally 1.0; specular highlights, skies, light sources run 5–20×). A **view transform** sits at the very end of the filter chain and maps scene-linear to display-linear, performing tone compression and gamut handling in one opinionated stage.

Maple's v1 view transform is **AgX** (Troy Sobotka, Blender 4.0+'s default). The view transform is implemented as a replaceable stage (scene-linear wide-gamut in, display-linear target-gamut out) so that OpenDRT or a future in-house transform can drop in without touching the rest of the pipeline.

### Why scene-referred

- **Highlight behavior.** Editing on scene-linear values, then applying a view transform, gives natural highlight rolloff. A saturated sky or a neon sign compresses into display gamut instead of clipping to a two-tone bar.
- **Exposure as multiplication.** An exposure slider is literally `pixel * 2^ev` on scene-linear data. The math is trivial and correct everywhere.
- **Edit portability.** The same edit values mean the same thing at any display brightness — there's no implicit assumption that "1.0 is the display's peak white." Future HDR output comes nearly for free.
- **Matches modern reference.** Blender, Nuke, Resolve, and most serious image work has moved to scene-referred with a view transform. Lightroom's internal pipeline is also scene-referred (its "display-referred" feel comes from how the sliders are scoped, not from the working space).

### Why AgX specifically

AgX is designed for still images (and the Blender community has tuned it against millions of renders), handles wide-gamut scene values gracefully via per-channel sigmoid compression, separates "base transform" from "look" so stylistic LUTs stack cleanly, and ships as open-source GLSL + OCIO references. It is the current state of the art for still photography on wide-gamut displays. See [`09-open-questions.md`](./09-open-questions.md) § Future view transform.

### Working space

| Space                            | Primaries       | White           | Encoding                   | Use                                                                        |
| -------------------------------- | --------------- | --------------- | -------------------------- | -------------------------------------------------------------------------- |
| **Camera native**                | sensor-specific | sensor-specific | linear                     | Demosaiced RAW, pre-DCP. Not directly displayable.                         |
| **XYZ (CIE)**                    | CIE 1931        | D50             | linear                     | Interchange inside DCP transform only.                                     |
| **Linear Rec.2020 (D65)**        | Rec.2020        | D65             | linear, **scene-referred** | **The one working space.** DCP output, filter chain, view-transform input. |
| **Display Rec.2020 / P3 / sRGB** | target          | D65             | linear then gamma          | View-transform output, display delivery.                                   |

**Rec.2020, not ProPhoto, not ACEScg.** Rec.2020 is D65 (no chromatic-adaptation surprises going to P3/sRGB displays), wide enough to hold every physical camera's gamut (slightly narrower than ProPhoto but ProPhoto's extra gamut is imaginary colors anyway), is the input space AgX's reference is tuned for, and is the primaries target for HDR delivery standards (PQ/HLG) so HDR export later is a natural extension. ProPhoto's D50 white and imaginary-primary headroom add complexity without buying anything here. ACEScg has D60 white, which is awkward for photo.

### Bit depth

| Depth                      | Where used                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **float32 linear**         | Rust core throughout; interactive GPU textures on Apple (`CIImage`/Metal `RGBA32Float`); WebGL2 FBOs (`EXT_color_buffer_float`). |
| **uint16 linear**          | High-bit-depth export intermediate (TIFF 16-bit).                                                                                |
| **uint8/10 gamma-encoded** | Display delivery; JPEG/PNG/HEIC export.                                                                                          |

**f32 everywhere interactive, no f16.** Scene-referred values span 0 – ~20 (not 0 – 1), and f16 has only ~3 decimal digits of mantissa. That's fine at f16 in [0, 1] (display-referred), but scene-referred a deep shadow at 0.001 nudged with a contrast curve produces visible banding at f16. f32 costs 2× working-texture memory (25MP → 400MB) — fine on Mac and M-series iPads, tight on older iPads (tile the interactive path, see [`05-performance.md`](./05-performance.md)).

### Encoding

All pipeline intermediates are **linear**. The only gamma encoding happens at the final display-encode step, after the view transform, on the way to the texture the OS composites. No pipeline stage reads or writes gamma-encoded values as a first-class working representation.

---

## Pipeline state, stage-by-stage

This is the authoritative trace. For each pipeline stage in [`02-pipeline.md`](./02-pipeline.md), what space and reference state the data is in when the stage begins and ends.

```
STAGE                        IN                          OUT
---------------------------  --------------------------  --------------------------
RAW container parse          bytes                       u16 Bayer-patterned
Sensor linearization         u16                         f32 linear camera-native
Demosaic                     f32 linear camera           f32 linear camera
DCP transform                f32 linear camera           f32 linear Rec.2020 (D65)
                                                         SCENE-REFERRED
Upload to GPU texture        f32 linear Rec.2020         f32 linear Rec.2020 (scene)
---- interactive chain: all scene-referred, linear Rec.2020, f32 ----
Exposure                     f32 scene Rec.2020          f32 scene Rec.2020
White balance                f32 scene Rec.2020          f32 scene Rec.2020
Highlights / Shadows         f32 scene Rec.2020          f32 scene Rec.2020
Whites / Blacks              f32 scene Rec.2020          f32 scene Rec.2020
Vibrance / Saturation        f32 scene Rec.2020          f32 scene Rec.2020
Clarity (unsharp @ mid)      f32 scene Rec.2020          f32 scene Rec.2020
Texture (unsharp @ fine)     f32 scene Rec.2020          f32 scene Rec.2020
Dehaze                       f32 scene Rec.2020          f32 scene Rec.2020
Capture sharpen              f32 scene Rec.2020          f32 scene Rec.2020
Noise reduction              f32 scene Rec.2020          f32 scene Rec.2020
Crop                         f32 scene Rec.2020          f32 scene Rec.2020
---- view transform ----
AgX                          f32 scene Rec.2020          f32 display Rec.2020 [0,1]
                             (per-channel log → sigmoid → optional look → display-linear)
---- display encode ----
Target-gamut conversion      f32 display Rec.2020        f32 display (sRGB | P3 | Rec.2020)
Gamma encode                 f32 display-linear          u8/10 gamma-encoded
Canvas / texture delivery    u8/10 gamma-encoded         composited by OS
```

The view transform (AgX) is the **only** stage that compresses scene range into display range. Every upstream stage is free to produce values > 1.0 or < 0 — that's expected.

---

## Stage-by-stage detail

### Camera-native → Rec.2020 (Rust core, the DCP stage)

The entire DCP transform (§ 3.4 in [`03-algorithms.md`](./03-algorithms.md)) is in f32 linear. Output is scene-referred linear Rec.2020 D65.

Steps inside this transform:

1. Linear camera RGB (demosaiced).
2. `CameraMatrix * rgb` → linear CIE XYZ, camera white point.
3. Bradford adapt from camera white → D50 white. XYZ D50.
4. `ForwardMatrix * xyz_D50` → linear ProPhoto. (If no ForwardMatrix, synthesize via `XYZ_D50 → ProPhoto` with the ROMM matrix.)
5. (Optional) HueSatMap and ProfileLookTable — operate in ProPhoto-HSV, per the DNG spec.
6. **`M_pro_to_rec2020 * rgb_pro` → linear Rec.2020 D65.** This composed matrix folds ProPhoto→XYZ D50, Bradford D50→D65, XYZ D65→Rec.2020 into a single 3×3, computed once at startup.

Output: f32 linear scene-referred Rec.2020, D65, headroom unbounded (practically 0 to ~20 on a normal exposure).

Step 6 is new in the scene-referred rewrite — the DCP spec is defined in ProPhoto D50, and Maple still does the DCP math there, but the handoff to the interactive pipeline is Rec.2020. The matrix composition is transparent and numerically harmless; the only visible difference is the working space all downstream stages see.

### Interactive chain: scene-linear Rec.2020

All filter chain stages operate in scene-linear Rec.2020, f32. Design rules for authors of filter stages:

- **Assume values can be >> 1.0.** A specular highlight at 10.0 must survive every stage unharmed unless the stage is specifically designed to compress it.
- **Assume values can be < 0.** A DCP forward matrix on a saturated signal can produce small negatives. Unsharp masks can produce negatives on dark edges. Don't clip; the view transform handles it.
- **No implicit display assumptions.** Thresholds like "clip at 1.0" or "shadow below 0.1" that come from the display-referred era must be re-derived against scene-linear reference points (diffuse white = 1.0, middle gray = 0.18).
- **Chroma operations use display-neutral math.** Vibrance and saturation operate in a chroma space (e.g., chroma-preserving adjustments in CIE LCh or Oklab), not in per-channel HSL of the RGB primaries. Per-channel HSL in Rec.2020 would give different results than in P3 or sRGB — chroma math should be gamut-invariant in v1 so the same adjustment produces the same perceived color on any display.

The tone-shaping sliders (highlights, shadows, whites, blacks, contrast) **do not** perform the final tone mapping — AgX does. They scoop and redistribute scene-linear energy before AgX sees it, so that AgX's sigmoid operates on the user's intended tonal distribution. See [`03-algorithms.md`](./03-algorithms.md) § Scene-referred tone controls and [`09-open-questions.md`](./09-open-questions.md) § Scene-referred slider design for the redesign of the tone-control math from the display-referred RtToneCurve.

### View transform: AgX

AgX compresses scene-linear Rec.2020 into display-linear Rec.2020 (or the final target gamut) with graceful highlight rolloff and gamut compression. Maple's implementation follows Blender 4.x's reference, with one small extension: Maple exposes a scalar **contrast** control that multiplies the sigmoid's slope parameter, giving the user a familiar "contrast" slider that modulates the view transform rather than the scene.

Stage math (approximate; exact coefficients in [`03-algorithms.md`](./03-algorithms.md) § AgX):

1. **Log encode.** Per-channel: `log_value = log2(clamp(scene, MIN_EV, MAX_EV) / MID_GRAY)` with AgX's chosen min/mid/max (e.g., −10 EV, 0.18, +6.5 EV). Linear below the toe; hard min/max clamps define the input range.
2. **Sigmoid.** Per-channel 6-piece polynomial sigmoid with parameters `(slope, toe, shoulder)`. Contrast slider modulates `slope`.
3. **Optional look.** A 3D LUT or direct matrix modifies the log-encoded value before the sigmoid (for presets / looks). Maple v1 ships only a "neutral" look; a "Punchy" and "Muted" preset land in v1.1.
4. **Display-linear.** Inverse log → display-linear in [0, 1] (clamped; the sigmoid already put it there).
5. **Gamut compression implicit.** Per-channel sigmoid already compresses saturated chroma because extreme values on one channel roll off while the others don't. This is why AgX doesn't need a separate gamut-compression pass.

AgX's Rec.2020 output is still in Rec.2020 primaries; target-gamut conversion (P3 or sRGB) is a separate matrix step downstream.

### Display encode

After AgX:

1. Matrix convert display-linear Rec.2020 → display-linear target (`M_rec2020_to_p3` or `M_rec2020_to_srgb`, compiled constants).
2. Gamma encode (piecewise sRGB curve for both sRGB and P3 delivery; Rec.2020 PQ/HLG for HDR, v1.x).
3. Quantize to u8 (sRGB/P3 SDR) or u10 (HDR PQ, later).
4. Hand to CIContext (Apple) or canvas (web) for composite.

### Web parity

The web pipeline performs the same sequence in a fused WebGL2 shader:

```glsl
// In fused.frag:
vec3 scene = texture(u_decoded, v_uv).rgb;          // scene-linear Rec.2020
scene = apply_exposure_wb_tone_chroma_clarity(scene); // filter chain
vec3 display = agx(scene);                           // display-linear Rec.2020
vec3 target = M_rec2020_to_target * display;         // to sRGB or P3 primaries
vec3 out    = gamma_encode(target);                  // piecewise sRGB
FragColor = vec4(out, 1.0);
```

Required capability: `EXT_color_buffer_float` (WebGL2) for f32 offscreen FBOs. Without it, the web path falls back to a reduced-quality mode (f16 FBOs where supported, sRGB-only output) — see [`05-performance.md`](./05-performance.md) § Fallbacks. The canvas itself is always tagged `colorSpace: 'display-p3'` where supported and `'srgb'` elsewhere; Maple detects `navigator`/context support at startup.

**Testing.** Playwright reads the raw canvas buffer and bypasses the browser's color management — numerical RGB values in a Playwright screenshot will not match what the user sees on a P3 display. Use real browsers for visual QA; use `compare_images.py` with known references for numeric CI. See [`08-io.md`](./08-io.md) § Testing.

---

## CIRAWFilter fallback: incompatible with scene-referred

`CIRAWFilter` is Apple's built-in RAW decoder. In the display-referred era, Maple used it as a fallback when Rust decode failed. **In the scene-referred pipeline, CIRAWFilter cannot be a drop-in fallback.** Its output is already tone-mapped and display-referred; feeding it into a pipeline that expects scene-referred values would apply AgX on top of Apple's implicit tone map, producing a doubly-compressed image.

Options for fallback (v1 decision deferred to [`09-open-questions.md`](./09-open-questions.md) § CIRAWFilter in scene-referred):

1. **No CIRAWFilter fallback.** If Rust decode fails, surface an error. Simplest; narrowest camera support.
2. **Run CIRAWFilter in a "linear, no tone map" mode** and treat the result as scene-referred ProPhoto (Apple does support this via `kCIInputDisableGamutMapKey` and related flags). Then apply Maple's view transform. Best quality but fragile — Apple's "linear" output isn't always truly scene-referred.
3. **Bypass the view transform** when the source was CIRAWFilter — treat CIRAWFilter output as display-referred and skip AgX. Produces a different look than the Rust path but remains usable. Viable as a transition strategy.

v1 ships with option 1 (no CIRAWFilter fallback) unless support gaps prove painful in testing. The Rust decoder must be robust enough that fallback is genuinely unusual. See [`08-io.md`](./08-io.md) § RAW formats.

---

## Interop with display-referred tools

Maple is scene-referred internally but reads and writes XMP that Lightroom and other Lightroom-compatible tools also touch. That asymmetry mostly resolves into separate XMP namespaces — Maple's scene-linear state lives under `papp:`, Lightroom-readable state under `crs:` — but tone curves are a special case because Lightroom's `crs:ToneCurvePV2012*` keys describe a **display-referred** curve and there is no scene-referred equivalent in Lightroom's vocabulary.

**Maple's resolution:** maintain both a scene-linear curve family (`papp:SceneLinearToneCurve*`, applied at stage 3 inside `SceneToneControls`) and a display-referred curve family (`crs:ToneCurvePV2012*`, applied at the new stage 12a `DisplayReferredCurve` immediately after AgX). Both families can be live on the same image. A Maple → Lightroom round-trip preserves any display-referred curve byte-exactly because Maple writes it in Lightroom's own format. A Lightroom → Maple round-trip loads the curve into the stage 12a slot, where it continues to behave as a display-referred operation.

**Why post-AgX placement.** A display-referred curve was authored against an image that had already been view-transformed. Applying it before AgX would mean re-deriving the user's authoring intent through the inverse of an unknown view transform — lossy, fragile, and version-dependent on Lightroom internals. Applying it after AgX keeps the user's intent intact: the curve operates on display-linear values, which is exactly the space it was authored against.

**Why not re-derive to scene-linear at import.** Even if Maple's AgX were a perfect stand-in for Lightroom's view transform (it isn't — Lightroom's is proprietary and changes across releases), the inverse operation is numerically lossy near the curve's endpoints, and re-opening the file in Lightroom would show a different image than the user originally saw.

The discrimination logic for which writer produced a `crs:ToneCurvePV2012*` field is in [`08-io.md`](./08-io.md) § Sidecar import discrimination. The pipeline placement is in [`02-pipeline.md`](./02-pipeline.md) § Filter chain (stage 12a). The math is in [`03-algorithms.md`](./03-algorithms.md) § 3.6b. The full rationale is in [`09-open-questions.md`](./09-open-questions.md) § 9.50.

---

## Export color transforms

Export produces bytes in a user-chosen container and color space. Each export format is a specific view-transform and target-gamut combination.

| Export format                  | Target gamut          | Bit depth | View transform                 | Profile embed       |
| ------------------------------ | --------------------- | --------- | ------------------------------ | ------------------- |
| **JPEG (default)**             | sRGB                  | 8         | AgX → sRGB                     | embedded            |
| **JPEG (wide gamut)**          | Display P3            | 8         | AgX → P3                       | embedded            |
| **HEIC**                       | Display P3            | 10        | AgX → P3                       | embedded            |
| **TIFF 16-bit**                | ProPhoto RGB (linear) | 16        | **none** (scene-referred TIFF) | embedded            |
| **TIFF 16-bit (display)**      | Display P3            | 16        | AgX → P3                       | embedded            |
| **PNG**                        | sRGB                  | 8         | AgX → sRGB                     | embedded            |
| **EXR (scene-referred, v1.x)** | Rec.2020 or ACEScg    | float16   | **none**                       | scene-linear tagged |

Pipeline per format:

```
interactive output: f32 scene-linear Rec.2020
    ↓
JPEG sRGB:   AgX → display-linear Rec.2020
             → matrix Rec.2020→sRGB → gamma (piecewise sRGB) → u8
JPEG P3:     AgX → display-linear Rec.2020
             → matrix Rec.2020→P3 → gamma → u8
HEIC P3:     AgX → display-linear Rec.2020
             → matrix Rec.2020→P3 → gamma → u10
TIFF Pro:    (no AgX; round-trip scene-linear)
             → matrix Rec.2020→ProPhoto (D50, with Bradford baked in)
             → clamp to [0, 65535/ref_white] (choose ref_white; default 1.0)
             → u16 linear, embed ProPhoto linear profile
TIFF P3:     AgX → Rec.2020 → P3 → u16 linear → embed P3 profile
PNG sRGB:    same as JPEG sRGB but PNG container
EXR:         no transform; write scene-linear Rec.2020 as f16 EXR, tag linear Rec.2020
```

**Scene-referred TIFF (linear ProPhoto 16-bit) preserves the entire scene range up to the chosen reference-white clip point.** This is the round-trip format for users who want to re-edit in another tool (or in Maple v2 with a different view transform). The default ref_white is 1.0 — values above diffuse white get clipped in the u16 quantization. An advanced export option "raise ref_white to preserve specular headroom" scales the data so 1.0 → 0.25 (or similar) inside the u16 range, trading display-referred ease for scene-range preservation.

**Gamut mapping on export.** AgX's per-channel sigmoid already performs perceptual gamut compression. No separate gamut-mapping pass is needed for JPEG/HEIC/PNG. For TIFF scene-referred export, the target gamut (ProPhoto or Rec.2020) is wide enough that clipping is rare; when it occurs, clip-to-gamut is the v1 policy. See [`09-open-questions.md`](./09-open-questions.md) § Gamut mapping on export.

---

## Thumbnails and rendered-preview cache

Thumbnails and cached previews are **display-referred, sRGB, u8, gamma-encoded JPEG**. They're produced by running the full pipeline (including AgX) once at cache time and persisting the JPEG.

Consequences:

- Thumbnail color is locked to sRGB regardless of the user's display. On a P3 display, thumbnails look slightly less saturated than the full-resolution editor image. Acceptable for browse.
- **Thumbnails must be invalidated when the view transform changes.** If Maple v2 replaces AgX with OpenDRT, every thumbnail in the cache is stale. Cache-key includes a view-transform version tag.
- Rendered-preview cache is sized to match the screen at 1× (not retina) to keep size manageable. Refine pass replaces on settle; see [`02-pipeline.md`](./02-pipeline.md).

---

## Profile handling

### Input profiles

- **RAW**: camera profile via DCP (preferred). CIRAWFilter fallback carries its own display-referred assumptions — see § CIRAWFilter fallback.
- **JPEG / HEIC / PNG**: read the embedded ICC profile; convert to **scene-referred Rec.2020** by treating the embedded-space values as display-linear (after inverse-gamma), then applying an **inverse view transform** to lift them back into scene range. This is lossy — information AgX compressed is unrecoverable — but for an 8-bit JPEG import it's the best we can do. For a TIFF 16-bit scene-linear import, read linear and treat as scene values directly. For EXR, treat as scene values.
- **TIFF**: check the profile. Linear-tagged TIFF is scene-referred; gamma-tagged TIFF is display-referred and gets the inverse-view-transform path.
- **Untagged files**: assumed sRGB, display-referred. Inverse-view-transform applied.
- **Malformed profiles**: treat as untagged.

Inverse view transform math: for AgX, the inverse is well-defined on the sigmoid's active range. For values that AgX originally clamped (below toe, above shoulder), the inverse produces the clamp endpoints and real scene values there are unrecoverable. Practically, importing an 8-bit JPEG and re-editing it in Maple does not recover detail that wasn't in the JPEG — the path is correct for round-tripping the image through the pipeline, not for magic recovery.

### Output profiles

Always embed the target profile in the exported file. Users who edit in Maple, export JPEG sRGB, and view in a color-managed viewer (Photos.app, most browsers) see consistent color. Users whose viewer ignores profiles see sRGB regardless — Maple's deliberate default so untagged consumers see reasonable colors.

### ICC library

Apple: Core Image handles ICC internally. No external dep.

Web: no ICC library in v1. Conversions are done with compiled constant matrices between known spaces (Rec.2020, P3, sRGB, ProPhoto). Arbitrary ICC profiles on input are not supported on the web in v1. See [`09-open-questions.md`](./09-open-questions.md) § Web ICC.

Rust core: no ICC library. DCP math and Maple's known space matrices cover the working set. LCMS2 deliberately excluded — see [`09-open-questions.md`](./09-open-questions.md) § LCMS.

---

## Bradford adaptation: when and where

The Bradford transform is used at two specific points, both compile-time:

1. **Inside DCP transform**: adapts the XYZ value from the camera's as-shot white to D50 (the connecting white point before ForwardMatrix). Runtime computation per pixel via a precomputed matrix for the interpolated-illuminant case.
2. **ProPhoto D50 → Rec.2020 D65 exit matrix at the end of DCP**: the composite matrix folds Bradford D50→D65 in.

At no runtime stage in the interactive pipeline does Bradford actually compute per pixel — it's folded into constant matrices. Chromatic adaptation inside a shader is expensive and unnecessary when both endpoints are known.

---

## f32 precision: why we're not using f16

The classic display-referred pipeline uses f16 working textures because f16's 10-bit mantissa is enough precision for values in [0, 1] to quantize to 8-bit display without banding.

Scene-referred changes the arithmetic:

- Scene values range 0 to ~20 (or more for light sources).
- A deep shadow in scene-linear at 0.001 is a valid, editable value.
- Contrast and tone manipulations on 0.001 with f16 precision (step ≈ 2^-14 ≈ 6×10^-5 at that magnitude) produce visible quantization when lifted.
- f16 has no headroom problem at the top (it goes to 65504) but the precision-per-decade shrinks at small values, exactly where shadow recovery operates.

f32 costs 2× working-texture memory (f16: 2 bytes/channel → f32: 4 bytes/channel). For 25MP RGBA: f16 ≈ 200MB, f32 ≈ 400MB. Fine on all Mac targets. Fine on M1/M2/M3/M4 iPads. Tight on iPad Air 4 / iPad mini 6 generation and older — the interactive path on these devices tiles the working texture to stay under a 200MB live budget. See [`05-performance.md`](./05-performance.md) § Memory budgets.

---

## Sanity-check table

Debugging cheat sheet:

| Symptom                                        | Likely cause                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Highlights crush to gray, no rolloff           | AgX not applied — skipped view transform or fell through CIRAWFilter path                           |
| Everything looks doubly-compressed             | CIRAWFilter output treated as scene-referred when it's display-referred                             |
| Banding in deep shadows on lifted scenes       | f32 texture misallocated as f16, or WebGL2 missing `EXT_color_buffer_float`                         |
| Neon sign clips to cyan/yellow                 | Per-channel clip before the view transform; AgX's gamut compression didn't see the saturated values |
| Skin tones wrong color on P3 vs sRGB export    | Vibrance/saturation done in RGB-HSL instead of a chroma-preserving space                            |
| Warm pink cast on web P3 display               | Canvas colorSpace tag wrong, or target-gamut matrix applied but canvas not tagged to match          |
| Export JPEG looks dull in Photos.app           | Missing embedded profile in JPEG writer                                                             |
| TIFF scene-linear looks saturated in viewer    | Viewer ignored profile; TIFF is wide gamut + linear, not previewable without a color-managed tool   |
| DCP-transformed image is green-magenta shifted | Wrong illuminant interpolation weight; check `t` clamped to [0, 1]                                  |
| Contrast slider does nothing visible           | Contrast mapped to AgX sigmoid slope, but AgX stage disabled in debug                               |

---

## What this document does not define

- **Exact AgX coefficients and slider-to-sigmoid mapping.** See [`03-algorithms.md`](./03-algorithms.md) § AgX and § Scene-referred tone controls.
- **Tile sizes and memory policies that let f32 work on iPad.** See [`05-performance.md`](./05-performance.md).
- **How the Rust core, Metal kernels, and WebGL fused shader agree on AgX math.** See [`06-cross-platform.md`](./06-cross-platform.md).
- **How exported metadata is propagated.** See [`08-io.md`](./08-io.md).
- **Open decisions: the replaceable view-transform interface shape, EXR export timing, scene-linear TIFF ref_white default, CIRAWFilter fallback policy.** See [`09-open-questions.md`](./09-open-questions.md).
