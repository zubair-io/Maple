# 03 — Algorithms

One subsection per non-trivial algorithm in the pipeline. Each subsection gives the math, the parameters, edge cases, and (where the algorithm is lifted from prior art) a lineage note and a rewrite recommendation (keep / adapt / drop).

Pipeline order and stage composition are in [`02-pipeline.md`](./02-pipeline.md). Where any algorithm produces or consumes a value in a particular colorspace, that's tracked in [`04-color-management.md`](./04-color-management.md).

Where behavior is unclear, the subsection says so and flags it in [`09-open-questions.md`](./09-open-questions.md).

---

## 3.1 RAW decode (container parse)

### Input / output

Input: bytes of a RAW container file (DNG, CR3, NEF, ARW, etc.).
Output: a `RawImage` record — sensor width/height, CFA pattern, black/white level, camera-to-XYZ matrix, a `Vec<u16>` of Bayer-patterned pixel values, and metadata (camera make/model, as-shot WB, exposure time, ISO).

### What this is

Not image processing — file-format parsing plus sensor linearization. The RAW container tells us which pixels are which color, what the black and white levels are, and what the embedded color matrices say.

### Approach

Use the `rawler` crate (fork of the older `rawloader`, actively maintained). `rawler` handles:

- DNG (TIFF-based, Adobe's open spec)
- Canon CR2, CR3
- Nikon NEF (compressed and uncompressed)
- Sony ARW
- Fuji RAF (X-Trans and Bayer)
- Olympus ORF, Panasonic RW2, Pentax PEF, Samsung SRW, Hasselblad 3FR/FFF, Kodak DCR, Leaf MOS, Minolta MRW, Phase One IIQ

### Edge cases

- **Missing black level** — default to the sensor's nominal floor from its metadata tag if the per-exposure black is absent.
- **Damaged preview** — the embedded JPEG may be corrupt; thumbnail fallback is to decode the first NxN pixels of the RAW directly.
- **Non-standard CFA** — X-Trans (Fuji) requires a different demosaic (see 3.3). Detect via CFA pattern string.

### Lineage

Based on `dcraw` / `libraw` conventions for metadata extraction, reimplemented in Rust. **Keep `rawler`** — maintaining a RAW container parser is not a productive use of engineering time.

---

## 3.2 Sensor linearization

### Input / output

Input: `RawImage.raw_data: Vec<u16>`, `black_level`, `white_level`.
Output: `Vec<f32>` in `[0, 1]`.

### Math

```
linear[i] = (raw_data[i] - black_level) / (white_level - black_level)
         clamped to [0, 1]
```

That's it. Three-line function. The only subtlety is whether `white_level` is saturation (clip) or the sensor's nominal full-well; Maple uses the sensor's tagged white level without correction.

### Edge cases

- **Dead pixels** — not corrected in v1. Dead-pixel maps are a Phase 4 addition. See [`09-open-questions.md`](./09-open-questions.md).
- **Hot pixels from long exposures** — same: not corrected.

### Lineage

Universal. No lineage to name. **Keep.**

---

## 3.3 Demosaic

Converts Bayer-pattern single-channel data into full RGB. Maple implements three variants at different quality/speed points.

### 3.3.1 Bilinear (preview default)

#### Math

For each missing channel at each pixel, interpolate from the nearest neighbors of that channel. For an RGGB pattern:

- **Red at G and B positions**: average 2 or 4 nearest reds.
- **Green at R and B positions**: average 4 nearest greens.
- **Blue at G and R positions**: average 2 or 4 nearest blues.

This is classical bilinear. Four-point averages use centers-of-cell arithmetic; two-point averages use the two horizontally or vertically adjacent same-channel pixels.

#### Parameters

None.

#### Edge cases

- **Image borders** — use mirroring (reflect) for out-of-bounds reads; do not clamp (produces visible green tint at edges).
- **Non-RGGB patterns** — dispatch table on CFA pattern (`GRBG`, `GBRG`, `BGGR`) chooses offsets.

#### Performance

Used for interactive preview. Runs rayon-parallel across scanlines.

#### Lineage

Universal, pre-digital-photography (1970s imaging). **Keep as the fast-path baseline.**

### 3.3.2 Half-res quad (fast path for very large sensors)

#### Math

Collapse each 2×2 Bayer quad into a single RGB pixel:

```
R_out[y, x] = raw[2y, 2x]                    // R position
G_out[y, x] = (raw[2y,   2x+1] + raw[2y+1, 2x]) / 2    // two Gs averaged
B_out[y, x] = raw[2y+1, 2x+1]               // B position
```

Result is half-resolution in each dimension (quarter pixel count). For a 100MP sensor, this drops to 25MP — comfortably fits in iOS memory and renders at interactive latency.

#### Parameters

None.

#### Edge cases

- **Non-even sensor dimensions** — crop one row/column if needed.
- **Must skip for X-Trans** — 2×2 logic is incompatible with Fuji's 6×6 pattern. Fallback to bilinear at full res for X-Trans.

#### Lineage

Not a real demosaic — a deliberate undersampling that happens to be near-lossless for preview. Common trick; no specific lineage. **Keep as the iOS / very-large-image preview path.**

### 3.3.3 AMaZE / Hamilton-Adams (export path)

#### Math

Hamilton-Adams: interpolate green first using a directional gradient test, then interpolate red and blue using color-difference (R−G, B−G) smoothness. This preserves edges better than bilinear because the green channel is twice as densely sampled and carries most luminance.

AMaZE (Adaptive, Mathematically-Optimized, Zero-bias, Edge-preserving): an extension that makes the directional decision adaptive based on local color correlation. Produces fewer zipper artifacts at high-contrast edges than HA.

Full algorithm description is in:

- Hamilton & Adams, _Adaptive color plane interpolation in single sensor color electronic camera_, US Patent 5,629,734, 1997.
- AMaZE: see RawTherapee's `amaze_demosaic_RT.cc`, based on Emil Martinec's 2010 analysis.

Summary steps for HA (as a reference; AMaZE is similar but with adaptive weights):

1. **Green interpolation at R/B positions.** Compute horizontal and vertical gradients using a 5×5 neighborhood:
   ```
   ΔH = |Gright - Gleft|  + |center - (Rleft + Rright)/2|
   ΔV = |Gup   - Gdown|  + |center - (Rup   + Rdown)/2|
   if ΔH < ΔV:   G_at_R = (Gleft + Gright)/2 + (2*center - Rleft - Rright)/4
   elif ΔV < ΔH: G_at_R = (Gup   + Gdown)/2 + (2*center - Rup   - Rdown)/4
   else:         average the two
   ```
2. **R at G positions**: interpolate using `R = G + (Rleft + Rright)/2 - (Gleft + Gright)/2` where the G values are now available.
3. **R at B positions**: 2D interpolation using the four diagonal R neighbors minus their G estimates, plus the center G.
4. **B interpolation**: symmetric to R.

#### Parameters

None exposed; algorithm is deterministic.

#### Edge cases

- **Image borders** — fall back to bilinear in a 2-pixel border; AMaZE's neighborhood extends too far for mirror-reflect to behave cleanly at borders.
- **Uniform areas** — gradient test is a tie; use the average.
- **X-Trans** — AMaZE doesn't apply. Maple does not support X-Trans high-quality demosaic in v1; Fuji RAFs fall through to bilinear at full res or to the CIRAWFilter fallback path. See [`09-open-questions.md`](./09-open-questions.md).

#### Performance

Expensive. Runs rayon-parallel across horizontal bands (minimum 4 rows per band because of the 5×5 neighborhood). A 100MP frame takes 1–3s on an M-series CPU. Used only on the export path.

#### Lineage

HA: Kodak patent (public, expired). AMaZE: RawTherapee-originated optimization by Emil Martinec. **Adapt AMaZE** — reimplement from the published analysis plus cross-reference RT's source, without copying code. The algorithm is well-understood enough that a clean Rust implementation is straightforward.

---

## 3.3a Highlight reconstruction

Recovers detail and corrects hue in pixels where one or two channels saturated at `white_level` while the others did not. Operates on demosaiced **camera-space RGB**, before the DCP color matrix — the matrix mixes channels, so any reconstruction has to happen here or it can't see which channel clipped.

Two modes ship co-resident:

- **Blend** (default when the toggle is on). For pixels where one or two channels are within ε ≈ 0.005 of 1.0, lerp the clipped channels toward the max of the unclipped channels, allowing the result to exceed 1.0 by the ratio implied by an unclipped neighborhood. AgX's shoulder absorbs the result. Cheap; failure mode is gray-haze in cloud detail when overdone.
- **Luminance Recovery.** For single-channel-clipped pixels, set the clipped channel to `max(unclipped) * scale`, where `scale` is the local luminance ratio inferred from a 5×5 unclipped neighborhood. Allows reconstructed values well above 1.0. More expensive; failure mode is haloing at hard specular edges.

**XMP.** `papp:HighlightRecoveryMode: "off" | "blend" | "luminance"` (default `"off"`).

**Why scene-referred matters here.** Reconstructed values that exceed 1.0 are valid scene radiances, not display-clipped pixels — AgX renders them on the highlight shoulder rather than hard-clipping. This is one of the architectural payoffs of stages 12 (AgX) + scene-linear working space.

**Tuning.** A person-week against a reference scene set (sunsets, snow, neon, stage-lit concerts, specular metal) before this feature is considered shippable. The calibration produces the ε threshold, the neighborhood radius for LR, and the per-mode default behavior. See [`09-open-questions.md`](./09-open-questions.md) § 9.10.

---

## 3.4 DCP-based color transform

Converts camera-native RGB (sensor space) to a calibrated wide-gamut reference color space using a DNG Camera Profile.

### Input / output

Input: `demosaiced: Vec<f32>` (camera linear RGB), `DcpProfile` parsed from a `.dcp` file or embedded in the DNG.
Output: `Vec<f32>` in **scene-referred linear Rec.2020 D65**. Values are unbounded; typical scenes run 0 to ~20 with specular highlights exceeding 1.0.

The DCP math is specified in ProPhoto D50 (per the DNG spec). Maple runs the math there and then applies a compiled-constant `M_pro_to_rec2020` exit matrix (folding ProPhoto→XYZ D50, Bradford D50→D65, XYZ D65→Rec.2020 into a single 3×3) so the rest of the pipeline operates in Rec.2020 D65. See [`04-color-management.md`](./04-color-management.md) § Camera-native → Rec.2020.

### What a DCP contains

- **ColorMatrix1 (CM1)** — **XYZ → camera** at illuminant 1 (typically StdA / ~2850K) per the DNG spec convention. The pipeline inverts it (`inv(CM)`) when it needs camera→XYZ on the non-FM path; see `src/raw-pipeline/raw-core/src/color/profile_loader/types.rs` field docstring.
- **ColorMatrix2 (CM2)** — **XYZ → camera** at illuminant 2 (typically D65 / ~6500K). Same convention as CM1.
- **ForwardMatrix1/2 (FM1, FM2)** — **white-balanced camera RGB → XYZ-D50** under each illuminant (optional but increasingly standard). NOTE: this is the DNG SDK contract per `dng_camera_profile.h` (FM field comment) and `dng_color_spec.cpp:444-446`; older Maple commentary occasionally described FM as "XYZ → ProPhoto", which is wrong. FM's _input_ is the white-balanced camera RGB (camera RGB divided by AsShotNeutral, i.e. the post-pre-gain buffer); FM's _output_ is XYZ chromatically adapted to D50.
- **HueSatMapData1/2** — 3D lookup tables (hue × saturation × value) of additive hue and saturation offsets, per illuminant.
- **ProfileLookTable** — an optional final 3D LUT applied after HueSatMap for "look" character (stylistic tweaks).
- **CalibrationIlluminant1/2** — the CIE illuminant codes for the above matrices.

### Math

Given the camera's as-shot white balance as a correlated color temperature (CCT), and the two calibration illuminants, Maple computes an interpolation weight `t ∈ [0, 1]`:

```
t = (1/CCT_asShot - 1/CCT_1) / (1/CCT_2 - 1/CCT_1)     // reciprocal-CCT lerp
```

Then every DCP component is interpolated between illuminant 1 and illuminant 2:

```
CM     = lerp(CM1, CM2, t)
FM     = lerp(FM1, FM2, t)
HSM    = lerp(HSM1, HSM2, t)   // per-cell
```

Pipeline application per pixel. Two branches, dispatched on whether
white-balance pre-gain has run upstream (the pipeline runs it for every
path except the 8-bit lossy LinearRaw escape hatch):

**FM path (post-#354 — when ForwardMatrix is present AND pre-gain has run):**

1. The buffer arriving at DCP is already `camera_raw / AsShotNeutral`
   (white-balanced camera RGB).
2. `xyz_D50 = FM * rgb_camera_wb` — FM's contract per the DNG SDK
   (`dng_color_spec.cpp:444-446`) is exactly this: white-balanced camera
   RGB → XYZ-D50.
3. `rgb_pro = inv(M_pro_to_xyz_d50) * xyz_D50` — invert the ROMM matrix
   to enter linear ProPhoto D50.

FM is NOT composed with `inv(CM)` on this path — that's the pre-#354
bug. CM is unused when FM fires (it's the camera→XYZ rotation that
FM's column-space already encodes).

**Bradford fallback (no FM, OR pre-gain was skipped):**

1. `xyz = inv(CM) * rgb_camera`.
2. `xyz_D50 = Bradford(scene_white, D50) * xyz`.
3. `rgb_pro = inv(M_pro_to_xyz_d50) * xyz_D50`.
4. **HueSatMap application** (in ProPhoto-HSV space, per DNG spec):
   ```
   (h, s, v) = rgb_pro_to_hsv(rgb_pro)
   (Δh, Δs, m_v) = trilinear_sample(HSM, h, s, v)
   (h', s', v') = (h + Δh, s * Δs, v * m_v)
   rgb_pro' = hsv_to_rgb_pro(h', s', v')
   ```
5. **ProfileLookTable** (if present): same shape as HSM, applied as a "look" tweak. Runs BEFORE the tone curve, per `dng_render.cpp:1094-1121` (the SDK's `Render` method chains `DoBaselineHueSatMap` (HSM) → `DoBaselineHueSatMap` again with `fLookTable` (PLT) → `DoBaselineRGBTone` (PTC)).
6. **ProfileToneCurve** (if present): 1D tone curve applied to the max channel with R/G/B scaled proportionally to preserve hue (DNG 1.4 § 6.4.4, `dng_render.cpp::DoBaselineRGBTone`).
7. **ProPhoto → Rec.2020 D65 exit matrix** (pipeline handoff):
   ```
   rgb_rec2020 = M_pro_to_rec2020 * rgb_pro'
   ```
   `M_pro_to_rec2020` is a compiled constant 3×3. No per-pixel Bradford runtime cost — the D50→D65 adaptation is folded into the matrix at startup.

### Parameters

User-facing: none in v1. The DCP is selected automatically per camera body. Future: `dcpPath` slot in `AdjustmentModel` for custom profiles.

### Edge cases

- **Profile has only CM1/CM2** (no ForwardMatrix) — use a standard D50 Bradford adapt from XYZ to ProPhoto.
- **Profile has only one illuminant** — skip interpolation; use it directly.
- **HueSatMap is 1×N×M (single-hue)** — a few profiles ship this way for monochrome or tinted profiles; handle by broadcast.
- **As-shot WB CCT outside [1500K, 20000K]** — clamp before interpolation.

### Lineage

Adobe DNG spec (public). **Keep** — the DCP ecosystem is large enough that any RAW editor reinventing color science here is making a mistake. RawTherapee's `dcp.cc` is a good cross-reference for edge cases; Maple reimplements from the Adobe DNG 1.7 spec plus RT for the fiddly bits (HSV space choice, Lerp weighting near CCT endpoints).

---

## 3.5 White balance (interactive)

### Input / output

Input: `decoded` (already through DCP transform, scene-linear Rec.2020 D65), `temperature` in Kelvin, `tint` in [-100, 100].
Output: `adjusted` in scene-linear Rec.2020 D65.

### Math

Two components: a CCT shift (temperature) and a green-magenta shift (tint).

1. **Compute target white point** from `(temperature, tint)`:
   ```
   xy_target = cct_to_xy(temperature)                        // Planckian locus approx
   xy_target.y += tint * 0.001                                // green-magenta nudge
   XYZ_target = xy_to_XYZ(xy_target, Y=1)
   ```
2. **Current white point** is D65 (the pipeline working-space white after DCP's Rec.2020 exit matrix).
3. **RGB gain factors** in Rec.2020-linear space:
   ```
   gain = XYZtoRec2020 * (XYZ_target / XYZ_D65)
   gain /= gain.g    // normalize so green = 1
   ```
4. Apply as a per-channel multiply:
   ```
   out = in * gain
   ```

Note that WB is a simple per-channel multiplication in scene-linear — the same math is correct for any linear RGB working space, only the matrix coefficients change. Scene-referred headroom is preserved: a scene value of 5.0 remains 5.0 after WB, scaled by the gain.

### Parameters

- `temperature`: 2000K … 12000K. Default 6500K (D65 equivalent, no shift from D50 after CCT mapping).
- `tint`: −100 … +100. 0.001 scaling was chosen to match Lightroom's perceived strength.

### Edge cases

- **Extreme temperatures** (< 3000K or > 10000K) — Planckian-locus approximation diverges from actual black-body; acceptable for creative use, not for scene-accurate matching. User-visible only.
- **Eyedropper sample** — user clicks a point they want to be neutral. Maple computes the gain that would make that sample's RGB equal, back-solves for `(temperature, tint)`, and writes those values into the model.

### Lineage

Standard. Planckian-locus CCT is a textbook formula (Kim et al. 2002 or the simpler Hernández-Andrés polynomial). **Keep.**

---

## 3.6 SceneToneControls (custom Metal kernel / fused WebGL stage)

Applies the user's scene-shaping tone controls in **scene-linear Rec.2020** before the view transform. Replaces the display-referred RtToneCurve from Maple's pre-scene-referred implementation.

### Input / output

Input: `rgb_in` in scene-linear Rec.2020 (values 0 to ~20, possibly slightly negative from DCP matrix operations on saturated scenes).
Output: `rgb_out` in scene-linear Rec.2020.

### Scene-referred mental model

The user's **contrast** slider maps to the AgX sigmoid's slope parameter (see § 3.6a AgX), **not** to a curve applied here. SceneToneControls is responsible only for redistributing scene-linear energy _before_ AgX sees it: exposure (linear gain), highlight recovery (pull down scene values > 1.0), shadow lift (boost values < ~0.1), and per-channel tone curves for creative stylization.

The result is that `contrast` feels like the display-side contrast knob users expect (more punch, deeper blacks), while `highlights`/`shadows`/`whites`/`blacks` behave as scene-manipulating tools that preserve highlight rolloff through AgX.

### Math (per pixel)

```
// 1. Exposure (2^EV gain, scene-linear)
rgb = rgb_in * exp2(exposure)

// 2. Highlights: compress scene values above a soft knee at 1.0
//    Positive highlights slider → more compression (recover blown highlights)
//    Negative → extend highlight range
if (highlights != 0):
    knee = 1.0                             // scene-linear diffuse white
    amount = highlights / 100.0            // in [-1, 1]
    for each channel c in {r, g, b}:
        if rgb[c] > knee:
            excess = rgb[c] - knee
            // soft compress: more amount → flatter curve above knee
            compressed = excess / (1.0 + amount * 2.0)
            rgb[c] = knee + compressed

// 3. Shadows: lift deep scene values below a soft threshold at ~0.1
if (shadows != 0):
    threshold = 0.1
    amount = shadows / 100.0
    luma = dot(rgb, LUMINANCE_WEIGHTS_REC2020)   // (0.2627, 0.6780, 0.0593)
    mask = 1.0 - smoothstep(0.0, threshold, luma) // 1 in deep shadows, 0 above
    rgb += rgb * (mask * amount * 0.5)

// 4. Whites: pull or push the scene-linear endpoint near diffuse white
if (whites != 0):
    rgb *= (1.0 + whites / 200.0)          // small scalar shift

// 5. Blacks: linear endpoint shift near zero (scene-linear, unbounded below)
if (blacks != 0):
    rgb += blacks / 400.0                  // can produce small negatives; AgX handles

// 6. Master tone curve (if non-identity) — creative, scene-linear space
//    Curve is defined over the scene-linear normalized range [0, 4] mapped to [0, 1] texture UV
if (masterCurve != identity):
    rgb = sample_scene_lut(masterCurveLUT, rgb, ref_max=4.0)

// 7. Per-channel curves (if non-identity)
if (redCurve != identity):   rgb.r = sample_scene_lut(redCurveLUT,   rgb.r, ref_max=4.0)
if (greenCurve != identity): rgb.g = sample_scene_lut(greenCurveLUT, rgb.g, ref_max=4.0)
if (blueCurve != identity):  rgb.b = sample_scene_lut(blueCurveLUT,  rgb.b, ref_max=4.0)

// Contrast is NOT applied here. It modulates the AgX sigmoid slope. See § 3.6a.
```

### Sample-curve-in-scene-space detail

A tone curve authored against scene-linear data needs a reference range. Maple picks `ref_max = 4.0` — scene values 0…4.0 map to the curve's 0…1 domain; values > 4.0 are clamped to the curve's endpoint (the user's curve effectively has a flat tail). This covers 2 stops above diffuse white, which is enough range for creative tone curves without letting the user accidentally truncate specular detail that AgX would have preserved. For a true "log curve" editor, see [`09-open-questions.md`](./09-open-questions.md) § Log-space tone curve UI.

### Tone curve representation

Same wire form as Lightroom: up to 16 `(x, y)` points in `[0, 255]` in the sidecar. At shader bind time, curves are sampled into a 256-entry f32 LUT. **Two curve families exist** with different XMP namespaces and different pipeline placements:

- **Scene-linear curves** (Maple's primary). XMP keys `papp:SceneLinearToneCurve`, `papp:SceneLinearToneCurveRed`, `papp:SceneLinearToneCurveGreen`, `papp:SceneLinearToneCurveBlue`. The `[0, 255]` domain maps to scene values `[0, ref_max]`. Applied at stage 3 (`SceneToneControls`) before the view transform.
- **Display-referred curves** (Lightroom-compatible). XMP keys `crs:ToneCurvePV2012`, `crs:ToneCurvePV2012Red`, `crs:ToneCurvePV2012Green`, `crs:ToneCurvePV2012Blue` — Lightroom's exact byte format. The `[0, 255]` domain maps to display-linear `[0, 1]`. Applied at stage 12a (`DisplayReferredCurve`) after AgX.

Both families can be live on the same image. See § 3.6b for the display-referred stage and [`09-open-questions.md`](./09-open-questions.md) § 9.50 for the discrimination logic and import semantics.

Identity curve: `[(0,0), (255,255)]`. Serializer skips emit when only these two points exist. See [`01-data-model.md`](./01-data-model.md) § Tone curves.

### Parameters

- `exposure`: −4 … +4 EV
- `contrast`: −100 … +100 (routed to AgX slope; see § 3.6a)
- `highlights`, `shadows`, `whites`, `blacks`: −100 … +100
- `masterCurve`, `redCurve`, `greenCurve`, `blueCurve`: curve point arrays (scene-linear interpretation)

### Edge cases

- **Values slightly negative** (from DCP on saturated colors, from shadows lift, from tone curve) — pass through unmodified. AgX handles negatives.
- **Values very large** (> 20 from specular highlights, extreme WB) — pass through unmodified. AgX's log encode clamps at its max-EV parameter.
- **Curve with 0 or 1 points** — treat as identity.
- **Curve with points out of order** — sort by x before LUT generation.

### Scene-referred slider ranges are a v1 tuning task

The `0.5` coefficient on shadows, the `200.0` denominator on whites, the `400.0` denominator on blacks, the `2.0` multiplier on highlights compression — these are initial guesses. Getting the sliders to feel like Lightroom (where users expect them from) is a one-person-week v1 deliverable against a reference scene set (high-contrast outdoor, low-key portrait, neon night, overcast gray). See [`09-open-questions.md`](./09-open-questions.md) § Scene-referred slider tuning.

### Verified invariants (Ticket #433)

The four scene-tone sliders are verified scene-referred and (with one documented asymmetry) hue-preserving. Future audits — and refactors — should rely on the named tests below rather than re-deriving the invariants.

**Scene-referred (operates on linear Rec.2020 f32 BEFORE the AgX view transform).**

- `pipeline::scene_linear_chain::apply_scene_linear_chain` invokes `scene_tone_controls::apply` before `agx::apply`. The stage asserts `ColorSpace::SceneLinearRec2020` on entry (`assert_space`) and never returns a clamped buffer.
- Test: `stages::scene_tone_controls::tests::scene_referred_handles_values_above_unity` — a specular `5.0` survives `exposure=+1` as an unclipped `10.0`.
- Test: `stages::scene_tone_controls::tests::scene_referred_does_not_clip_negatives_introduced_upstream` — slight negatives (typical of DCP on saturated colours) are passed through; AgX handles them downstream.

**Hue-preserving — uniform scalar multiply per pixel.**

| Slider                        | Operation                                                          | Hue test                                                                              |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `highlights`                  | Compute scene-luma `Y`, compress `Y` above knee, scale RGB by `Y_new/Y_old`. | `highlights_preserves_hue_on_partial_specular_below_knee_luma`, `highlights_preserves_hue_on_specular_above_knee_luma`, `highlights_preserves_hue_on_arbitrary_saturated_above_knee` |
| `shadows`                     | Luma-masked multiplicative lift: `p *= 1 + mask*amount*0.5`.        | `shadows_preserves_hue_on_saturated_deep_shadow`, `shadows_negative_preserves_hue_on_saturated_deep_shadow` |
| `whites`                      | Smoothstep-weighted scalar gain: `p *= 1 + (w_slider/200)*smoothstep(0.5,1.0,Y)`. | `whites_preserves_neutral_hue`, `whites_preserves_hue_on_arbitrary_saturated`         |
| `blacks` &lt; 0 (crush)       | Luma-masked multiplicative compression: `p *= 1 + (b_slider/100)*w`. | `blacks_negative_preserves_hue_on_saturated_deep_shadow`                              |

**Documented asymmetry — `blacks > 0` is additive, NOT multiplicative.**

The positive blacks branch applies `p += (b_slider/400) * w` (luma-masked). On a pixel where one channel is `0.0`, the uniform delta lifts it to a positive value — by construction this shifts chromaticity. The asymmetry is deliberate (matches legacy `blacks` semantics so zero pixels visibly lift) and is pinned by `blacks_positive_lift_is_additive_not_multiplicative_by_design`. A future refactor that swaps the lift to multiplicative would silently change a user-visible behaviour; that test is the alert.

Closed-form predictor coverage for each slider lives in `raw_core::test_support::predictions::{predict_exposure, predict_highlights, predict_shadows, predict_whites, predict_blacks}` and is exercised end-to-end through the full RAW pipeline by `tests/grey_adjustments.rs` (the `src/scripts/test_grey_adjustments.sh` harness).

### Lineage

Scene-referred tone controls are a departure from RtToneCurve's display-referred math. The mental model is closer to Darktable's "filmic" module (which separates scene manipulation from view transform) and to Lightroom's internal pipeline (which is scene-referred despite its display-referred UI feel). **Derive the math from first principles for v1**, tune against references, and iterate. RT and RtToneCurve are no longer a useful numeric reference — their math was scoped to [0, 1].

---

## 3.6a AgX view transform (new in scene-referred pipeline)

Scene-linear Rec.2020 → display-linear Rec.2020. The single tone-mapping stage that compresses scene range into display range. Controlled by the user's `contrast` slider (remapped to AgX sigmoid slope) and, later, by "look" presets.

### Input / output

Input: `rgb_in` in scene-linear Rec.2020 (typical range 0 to ~20, may be slightly negative).
Output: `rgb_out` in display-linear Rec.2020, clamped to [0, 1].

### Reference implementation

Maple's AgX is derived from Blender 4.x's reference (which is itself derived from Troy Sobotka's original). The authoritative reference shaders are in Blender's source tree (`source/blender/imbuf/intern/colormanagement.cc` and the associated OCIO config); Maple reimplements in Rust (reference), Metal (Apple), and GLSL (web) with numeric parity enforced to 1e-4. See [`06-cross-platform.md`](./06-cross-platform.md) § AgX parity.

### Math (per pixel)

```
// Constants (matching Blender AgX reference; see v1 tuning notes)
const float MIN_EV    = -10.0;
const float MAX_EV    = +6.5;
const float MID_GRAY  = 0.18;                  // scene-linear middle gray

// Input: scene-linear Rec.2020 (may exceed 1.0 or go slightly negative)

// 1. Clamp below toe. Scene values below MIN_EV get pinned to the log floor.
rgb = max(rgb, MID_GRAY * exp2(MIN_EV));       // per-channel

// 2. Log encode (per-channel)
log_rgb = log2(rgb / MID_GRAY);                 // now in [MIN_EV, MAX_EV]
log_rgb = clamp(log_rgb, MIN_EV, MAX_EV);
norm_rgb = (log_rgb - MIN_EV) / (MAX_EV - MIN_EV);   // now in [0, 1]

// 3. Optional look (3D LUT or matrix). v1 ships neutral look only.
// norm_rgb = apply_look(norm_rgb, look_id);

// 4. Sigmoid (per-channel 6-piece polynomial, approximated by Blender's AgX_Base_sRGB shape).
//    Coefficients published in Blender source; Maple holds them as a 1D LUT of 512 entries per channel,
//    sampled with linear interpolation.
//    `contrast` slider modulates slope: effective_slope = base_slope * (1 + contrast/100)
display_norm = sample_agx_sigmoid(norm_rgb, effective_slope);   // [0, 1]

// 5. Inverse log → display-linear (implicit; the sigmoid's output is already display-linear)
rgb_out = display_norm;

// 6. Clamp (sigmoid is designed to keep output in [0, 1] but floats may overshoot by epsilons)
rgb_out = clamp(rgb_out, 0.0, 1.0);
```

### Gamut compression is implicit

AgX applies its sigmoid per channel in a log-transformed space. When one channel (e.g., saturated red) is significantly larger than the others, its sigmoid rolls off toward 1.0 while the other channels' sigmoids stay lower — the resulting display-linear triple is less saturated than the input. This is perceptual gamut compression at no extra cost. No separate gamut-compression stage is needed.

### Contrast slider mapping

The user's contrast slider modulates AgX's sigmoid slope:

```
base_slope = 2.4   // Blender AgX default (approximate)
effective_slope = base_slope * (1.0 + contrast/100.0 * 0.5)  // +100 slider → 1.5x slope, −100 → 0.5x
```

The `0.5` scaling factor keeps the slider from producing visually unusable extremes. Exact value is part of the slider-tuning task.

### Look presets

Two Looks ship today (`Look::Neutral`, `Look::Default`), surfaced as the
`look` field on `AdjustmentModel` and the `papp:Look` XMP attribute.
**`Look::Default` is the new-user default.** Implementation lives in
`raw-core::view::look` (ticket #371).

The actually-shipped Look is a **1D per-channel u8 LUT applied
post-encode** — after `view::encode::quantize_u8` returns the
sRGB-encoded display-encoded `Vec<u8>`. This is a deliberate deviation
from the planned step-3 (log-domain) placement above: the empirical LUT
was derived from per-pixel `(Maple sRGB u8, ACR sRGB u8)` pairs and only
makes sense in the same domain. Trying to apply it pre-sigmoid would
index the wrong domain (Rec.2020 primaries, no gamma) and the gain
disappears.

The 1D LUT closes ~65% of the bias-to-ACR gap (3x MAE reduction on 14
training fixtures, 2x on held-out). The residual scatter — same canonical
Maple value mapping to a 125-160 sRGB-unit spread of ACR values within
the same image — is per-pixel scene-content-dependent and is the brief
for follow-up #389 (3D LUT, context-aware tone, learned mapping).

Future "Punchy" / "Muted" / per-camera looks slot into the same `Look`
enum.

### Parameters

`look: Look` — `Neutral` (identity) or `Default` (empirical 1D LUT).
Default is `Look::Default`. AgX itself remains parameter-free apart from
the `contrast` slider.

### Edge cases

- **Negative inputs** — clamped by the `max(rgb, floor)` step. Very dark scene regions map to the sigmoid's toe (display black).
- **Inputs > exp2(MAX_EV) \* MID_GRAY ≈ 16.3** — clamped to `MAX_EV` in log domain. Specular highlights beyond 16× middle-gray map to the sigmoid's shoulder (near display white); detail at 20× vs 100× is not distinguishable post-AgX.
- **NaN / Inf inputs** — must not propagate. Metal kernel and GLSL shader both include `isfinite` guards; NaNs become `MID_GRAY`, Infs are clamped by the log-domain clamp.

### Lineage

Troy Sobotka's AgX (2020–), upstreamed into Blender 4.0 (2023) as the default view transform. Extensive community tuning against real-world still photography in the Blender community. **Reimplement from Blender reference with numeric parity tests** — do not ship a deviation from the reference unless we have a specific justification tracked in `09-open-questions.md`.

---

## 3.6b DisplayReferredCurve (Lightroom-compat slot)

Optional pipeline stage 12a (see [`02-pipeline.md`](./02-pipeline.md) § Filter chain). Active only when the active asset's sidecar carries any `crs:ToneCurvePV2012*` curves. Operates on **display-linear Rec.2020** — the output of AgX (stage 12), before the target-gamut matrix (stage 13).

### Input / output

Input: `display_linear_rec2020: vec3<f32>` in the nominal `[0, 1]` display range. AgX's output is in `[0, 1]` for in-gamut content; out-of-gamut values may slightly exceed the range and are clamped by the LUT sample.

Output: same domain, after applying up to four tone curves (master, R, G, B).

### Math

For each populated curve, sample a 256-entry f32 LUT (built once at sidecar bind time from the curve's `(x, y)` points in `[0, 255]`):

```
if masterDR != identity:
    rgb.r = sample_display_lut(masterDR_LUT, rgb.r)
    rgb.g = sample_display_lut(masterDR_LUT, rgb.g)
    rgb.b = sample_display_lut(masterDR_LUT, rgb.b)
if redDR != identity:   rgb.r = sample_display_lut(redDR_LUT,   rgb.r)
if greenDR != identity: rgb.g = sample_display_lut(greenDR_LUT, rgb.g)
if blueDR != identity:  rgb.b = sample_display_lut(blueDR_LUT,  rgb.b)
```

Where `sample_display_lut(lut, x)` clamps `x` to `[0, 1]`, scales to LUT index, and bilinearly samples. No `ref_max` rescaling — the curve's `[0, 255]` domain maps to display `[0, 1]` directly.

### Why this exists

Lightroom-imported curves were authored against a display-referred view. Re-deriving them as scene-linear curves requires knowing Lightroom's view transform exactly (proprietary, version-dependent); approximating via inverse AgX is lossy and breaks Lightroom round-trip. A separate pipeline slot operating in display space preserves the user's authored intent and round-trips losslessly with Lightroom. See [`09-open-questions.md`](./09-open-questions.md) § 9.50 for the full rationale.

This slot is also editable — once Maple writes a display-referred curve (whether originally imported or authored from scratch), it stays in this slot permanently. Display-referred curves are a real feature, not a temporary import-compat bridge.

### Lineage

Display-space curves are universal (Photoshop, Lightroom, Capture One, every consumer photo tool). The math is trivial; the architectural decision is where they apply. Maple applies them post-AgX deliberately — see [`04-color-management.md`](./04-color-management.md) § Interop.

---

## 3.7 SceneVibrance (custom Metal kernel / WebGL stage)

Vibrance is saturation with skin protection. Scene-referred implementation operates in a **gamut-invariant chroma space** (Oklab) rather than per-channel HSL of the working-space RGB — this ensures the same slider value produces the same perceived color adjustment regardless of target display gamut.

### Math (per pixel)

```
// 1. Transform scene-linear Rec.2020 → scene-linear Oklab
//    Oklab is perceptually uniform and gamut-invariant; chroma adjustments there are stable.
//    Transform is a 3x3 matrix to LMS, cube root, 3x3 matrix to Lab.
lab = rec2020_linear_to_oklab(rgb_in)
L = lab.L
a = lab.a
b = lab.b

// 2. Compute chroma and hue
chroma = sqrt(a*a + b*b)
hue_deg = atan2(b, a) * 180 / PI   // [-180, 180]

// 3. Skin-tone protection window: smoothstep in Oklab hue angle.
//    Endpoints (15/22/35/42) are PLACEHOLDERS — locked by the pre-ship
//    vibrance calibration pass against a 30-portrait reference set
//    (Fitzpatrick I–VI × 6 lighting conditions). See 11-testing.md
//    § Render gates (gate 7) and 09-open-questions.md § 9.4.
//    Not user-tunable; final values become spec constants.
skinMask = smoothstep(15, 22, hue_deg) * (1 - smoothstep(35, 42, hue_deg))

// 4. Non-linear chroma scale: low-chroma pixels get more boost
chromaBoost = (1 - min(chroma / 0.3, 1.0)) * vibrance / 100

// 5. Attenuate boost in skin window
chromaBoost *= (1 - skinMask * 0.6)     // protect skin by 60%

// 6. Apply chroma scale in Oklab, preserving L
new_chroma = chroma * (1 + chromaBoost)
scale = (chroma > 0) ? new_chroma / chroma : 1.0
a *= scale
b *= scale

// 7. Back to scene-linear Rec.2020
rgb_out = oklab_to_rec2020_linear(vec3(L, a, b))
```

### Parameters

- `vibrance`: −100 … +100. Negative values desaturate, still with skin protection.

### Edge cases

- **Negative vibrance on skin** — also attenuated. A user who wants full desaturation of skin uses the saturation slider, not vibrance.
- **Achromatic pixel (s == 0)** — `satBoost` is a no-op because `(1 - 0) * vibrance/100 * hsl.s = 0`. Correct.
- **Hue in the protected window with low saturation** — the formula handles this: low saturation ⇒ more boost ⇒ attenuated by skin mask ⇒ net small boost. Visually, skin tones in the shadow areas stay where they are.

### Lineage

RT's `vibrance.cc` is the algorithmic inspiration (skin-protected non-linear saturation scaling). The move to **Oklab as the chroma space** (rather than per-channel HSL) is a scene-referred-era upgrade — Oklab (Björn Ottosson, 2020) is perceptually uniform and independent of the RGB working space, so vibrance produces the same visual result regardless of display gamut. The 20–40° hue window is approximate; actual skin tones vary by ethnicity, lighting, and camera. See [`09-open-questions.md`](./09-open-questions.md) § Vibrance hue window.

**Reimplement from scratch** for the Oklab path; RT's RGB-HSL math is not a useful numeric reference. Oklab reference implementation is trivially small (≈20 lines including constants).

---

## 3.8 Clarity, Texture (dual-band mid-frequency contrast)

### Math

Both are unsharp masks with different radii, operating on **scene-linear Rec.2020**:

- **Clarity**: unsharp mask at large radius (~40px reference at 1MP — scales with image size).
- **Texture**: unsharp mask at small radius (~3px reference).

```
blurred = gaussian_blur(rgb, radius)     // scene-linear Gaussian
out = rgb + (rgb - blurred) * intensity
```

Where `intensity = slider_value / 100`.

Scene-linear unsharp can produce:

- Values > 1.0 (light side of a bright edge gets amplified) — **allowed**; AgX handles it.
- Values < 0 (dark side of a dark edge dips below zero) — **allowed** as long as the dip is small. Clamping to ≥ 0 introduces visible banding on dark edges; letting small negatives through and relying on AgX's toe clamp is cleaner.

### Radius scaling

Both radii scale with image long edge so that a given slider value produces the same perceptual effect across preview and export:

```
actualRadius = referenceRadius * (imageLongEdge / 2000)
```

Reference radii: clarity = 40px at 2000px long-edge, texture = 3px at 2000px long-edge. An 8000px long-edge export uses 160px clarity / 12px texture; a 1000px preview uses 20px / 1.5px. Long-edge (rather than total pixel count or DPI) scales with the linear features the user perceives — face size, building edges — independent of aspect ratio. See [`09-open-questions.md`](./09-open-questions.md) § 9.5.

### Parameters

- `clarity`: −100 … +100
- `texture`: −100 … +100

### Edge cases

- **Negative slider values** — `out = rgb - (rgb - blurred) * intensity`, which blends toward the blurred image. A soften effect.
- **Luminance-only application?** v1 applies per-channel in scene-linear Rec.2020. Adobe's reference converts to Lab and applies to L only. Maple's choice: per-channel on scene-linear, because the Oklab transform roundtrip adds two matrix multiplies and a cube-root per pixel (noticeable on large images) and the perceptual difference is modest on well-exposed material. See [`09-open-questions.md`](./09-open-questions.md) § Per-channel vs Oklab-L clarity.

### Lineage

Standard unsharp-mask variant, reworked for scene-linear input. Adobe's spec names this form explicitly. **Keep as the baseline; evaluate Oklab-L variant in v1.1 against reference scenes.**

---

## 3.9 Dehaze (dark-channel prior)

### Math

Based on He, Sun, and Tang (2009), _Single Image Haze Removal Using Dark Channel Prior_. Summary:

1. **Compute dark channel**: for each pixel, `dark(x, y) = min over 15×15 neighborhood of min(r, g, b)`.
2. **Estimate atmospheric light A**: the brightest 0.1% of pixels in the dark-channel map, take the average of the original image at those locations.
3. **Estimate transmission t**:
   ```
   t(x, y) = 1 - ω * min_channel(rgb / A) over 15×15 neighborhood
   ```
   where `ω = 0.95` (leaves some haze for realism).
4. **Refine transmission** via guided filter (Kaiming He, 2010).
5. **Recover scene radiance**:
   ```
   J = (I - A) / max(t, t0) + A         // t0 = 0.1 floor to avoid division blowup
   ```

### Interactive vs export

Same algorithm on both paths; only image size varies. **Interactive** runs the full dark-channel prior on a **¼-size buffer**, upsamples the resulting transmission map to full resolution (bilinear), and applies the upsampled map at full res. **Export** runs the full algorithm at full resolution end-to-end.

The ¼-size optimization is correctness-preserving because the dark-channel prior's transmission map is inherently low-frequency (it estimates atmospheric scatter, which varies smoothly across a scene). The visual difference between ¼-res-derived transmission and full-res transmission is well below visible threshold on real photographic haze.

For negative dehaze (−100…0): same algorithm with the recovered transmission inverted to add a low-frequency luminance desaturation. Same ¼-size pattern on interactive. See [`09-open-questions.md`](./09-open-questions.md) § 9.7.

### Parameters

- `dehaze`: −100 … +100.

### Edge cases

- **No haze, positive slider** — acts like a contrast-and-saturation boost. Acceptable.
- **Strong haze, negative slider** — adds a wash. Occasional creative use.

### Lineage

He et al. 2009 (published paper). **Adapt** — reimplement the paper in Rust for the export path; keep the interactive approximation for speed.

---

## 3.10 Capture sharpening (Richardson-Lucy)

### Richardson-Lucy (the default and only capture-sharpening path)

Maple ships **3-iteration Richardson-Lucy deconvolution** on scene-linear Rec.2020 as the sole capture-sharpening algorithm. RL runs identically on every path and platform — Apple interactive, Apple refine, Apple export, web interactive, web refine, web export — with the same iter count and the same PSF. Only image size varies (viewport vs full resolution); convergence is per-pixel so the iter count doesn't depend on resolution. There is no path-split fallback to unsharp mask; if a viewport-sized RL pass doesn't fit the 16ms interactive budget on a supported device, the fix is kernel optimization, not algorithm substitution. See [`09-open-questions.md`](./09-open-questions.md) § 9.51.

**Web implementation.** WebGL2 fragment shaders with ping-ponged FBOs for the iteration. 4 passes per iteration × 3 iterations = 12 passes per render at viewport size. Requires `EXT_color_buffer_float` (already gated for the rest of the scene-referred pipeline; see [`05-performance.md`](./05-performance.md) § Fallbacks).

**RL math (per iteration).** Given observed image `O`, current estimate `E_n`, PSF `P`:

```
E_{n+1} = E_n * ((O / (E_n ⊛ P)) ⊛ P_flipped)
```

where `⊛` is convolution. Initialize `E_0 = O`. Three iterations.

**Slider mapping.** `sharpenAmount` 0…150 maps to a mix weight between the unmodified input and the RL output:

- 0 = stage skipped entirely.
- 100 = full RL output (no mix with unmodified).
- 100…150 = overdrive band; a final unsharp pass is applied on top of the RL output, weighted from 0 at amount=100 to ~0.5 at amount=150. The overdrive unsharp pass uses the same `sharpenRadius` (treated as Gaussian blur radius for the unsharp), `sharpenDetail`, and `sharpenMasking` parameters; its math is the classical:
  ```
  blurred = gaussian_blur(rl_out, sharpenRadius)
  unsharp = rl_out + (rl_out - blurred) * (amount - 100)/100
  mask    = edge_detect(rgb, sharpenMasking)
  out     = mix(rl_out, unsharp, mask * sharpenDetail/100 + (1 - sharpenDetail/100))
  ```

The 0…100 band is the principled range; 100…150 is for users who specifically want the over-sharpened look.

### Parameters

- `sharpenAmount`: 0 … 150 (mix weight; 100 = full RL, 100…150 = overdrive)
- `sharpenRadius`: 0.5 … 3.0 (interpreted as **PSF Gaussian sigma** under RL; default 0.5 — XMP key `crs:SharpenRadius` for Lightroom interop, semantic meaning differs from unsharp)
- `sharpenDetail`: 0 … 100 (edge-attenuation strength applied to the mix)
- `sharpenMasking`: 0 … 100 (edge mask threshold; 0 = sharpen everywhere, 100 = sharpen only hard edges)

### Edge cases

- **Amount == 0** — stage is skipped entirely.
- **Radius < 0.5** — clamp. Sub-pixel kernels introduce artifacts.
- **High amount + high detail + low masking** — amplifies noise dramatically. UX caveat, not an algorithmic one.

### Lineage

Richardson-Lucy is a well-known deconvolution method (1972 for Richardson; 1974 for Lucy). RT's `capturesharpening.cc` is a reference for edge cases and PSF modeling. **Reimplement RL in scene-linear from first principles**, clean implementation from the published math plus RT as a numeric cross-reference. The optional unsharp overdrive component (amount > 100) is universal and trivial to implement directly.

---

## 3.11 Noise reduction

### Math

Uses `CINoiseReduction` (Apple) on the interactive path, which wraps a non-local-means variant:

```
output(x, y) = weighted_average of patches in neighborhood,
               weights = exp(-patch_distance^2 / h^2)
```

### Parameters

- `nrLuminance`: 0 … 100. Controls `h` (smoothing strength).
- `nrColor`: 0 … 100. Controls a separate chroma-NR pass; default is 25 (mild always-on color NR).

### Edge cases

- **High luminance NR** — smears fine detail. The sharpening stage runs before NR, which means detail lost here cannot be recovered later. This is a known trade-off; Lightroom orders the same way.

### Lineage

Non-local means (Buades, Coll, Morel 2005) for the underlying algorithm. Core Image's implementation is opaque; Maple's Apple path uses `CINoiseReduction` on scene-linear textures (parameters rescaled from display-referred defaults — `noiseLevel` is halved and `sharpness` reduced since scene-linear noise has different perceptual characteristics). Maple's web path ships a simple scene-linear bilateral in v1 as a minimal NR option; full non-local means on web is a v1.x item. See [`09-open-questions.md`](./09-open-questions.md) § Web NR parity.

---

## 3.12 Crop and rotation

### Math

Trivial. Given `(top, left, bottom, right)` normalized to [0, 1] and an optional `angle`:

```
1. Rotate around image center by angle:
   T_rotate = rotation matrix
2. Extract rect:
   out = input[top*H : bottom*H, left*W : right*W]
```

Applied via `CICrop` with an affine-transform pre-step when `angle ≠ 0`.

### Parameters

- `crop.top`, `crop.left`, `crop.bottom`, `crop.right`: [0, 1]
- `crop.angle`: degrees

### Edge cases

- **Inverted rects** (bottom < top) — invalid; treat as identity.
- **Empty rect** — invalid; treat as identity.
- **Rotation angle > 45°** — valid; the rotated bounds may require crop adjustment to avoid empty corners.

### Lineage

Universal. **Keep.**

---

## 3.13 Auto-exposure (utility)

Not on the interactive path; used by the "Auto" button in the WB preset row and by the initial suggestion for very under/over-exposed RAWs.

### Math

1. Compute image histogram on a downsampled Y (luminance) channel.
2. Find `p_low` (5th percentile) and `p_high` (95th percentile).
3. Target `p_high ≈ 0.9` (a bit below clip).
4. Compute required exposure shift:
   ```
   exposure_ev = log2(0.9 / p_high)
   ```
5. Clamp to [-2, +2] EV (conservative).

### Parameters

Internal.

### Lineage

Standard. RT has a similar auto-exposure. **Keep.**

---

## 3.14 Histogram matching (utility)

Not on the interactive path; used for copy-paste of adjustments when the source and target have different exposures, as a future "match this image's look" feature. Currently unused. See [`09-open-questions.md`](./09-open-questions.md).

### Math

CDF-based matching:

1. Compute CDF of source and target images.
2. For each intensity `i` in the input, find `j` in the target such that `cdf_target[j] == cdf_source[i]`.
3. Build a 1D LUT mapping `i → j`.

### Lineage

Textbook (Gonzalez & Woods, _Digital Image Processing_). **Keep if/when the UI feature ships.**

---

## 3.15 Bradford chromatic adaptation

Used inside DCP transform (§ 3.4), white balance (§ 3.5), and export color conversion.

### Math

Bradford transform matrix (published; fixed):

```
M_Bradford = [  0.8951,  0.2664, -0.1614,
               -0.7502,  1.7135,  0.0367,
                0.0389, -0.0685,  1.0296 ]
```

Adaptation from source white `Ws` (in XYZ) to destination white `Wd`:

```
Lms_s = M_Bradford * Ws
Lms_d = M_Bradford * Wd
D     = diag(Lms_d / Lms_s)      // 3x3 diagonal
M_adapt = M_Bradford^-1 * D * M_Bradford
XYZ_adapted = M_adapt * XYZ_input
```

### Lineage

Standard (Lam 1985; widely used since). **Keep.**

---

## 3.16 Panorama stitching (Phase 4, deferred)

Detailed in [`maple-maple-panorama-spec.md`](../maple-maple-panorama-spec.md). Uses:

- **Feature detection**: Apple `VNDetectImageAlignmentRequest` for homography, or ORB/BRISK features via Rust `imageproc` as a portable fallback.
- **Bundle adjustment** over feature correspondences.
- **Cylindrical or equirectangular projection**.
- **Multi-band blending** (Burt & Adelson 1983 Laplacian pyramid blend).

Not implemented in v1. **Adapt from the panorama spec when Phase 4 begins.**

---

## Algorithm-to-stage cross-reference

Maps § numbers here to the pipeline stages in [`02-pipeline.md`](./02-pipeline.md):

| Stage                 | Algorithm                               | Band                          |
| --------------------- | --------------------------------------- | ----------------------------- |
| 1 Neutral decode      | §§ 3.1, 3.2, 3.3 (+ 3.4 DCP → Rec.2020) | scene-linear                  |
| 2 White balance       | § 3.5                                   | scene-linear                  |
| 3 Scene tone controls | § 3.6 (SceneToneControls)               | scene-linear                  |
| 4 Vibrance            | § 3.7 (SceneVibrance, Oklab)            | scene-linear                  |
| 5 Saturation          | chroma scale in Oklab (see § 3.7)       | scene-linear                  |
| 6 Clarity             | § 3.8 (scene-linear unsharp)            | scene-linear                  |
| 7 Texture             | § 3.8 (scene-linear unsharp)            | scene-linear                  |
| 8 Dehaze              | § 3.9                                   | scene-linear                  |
| 9 Capture sharpening  | § 3.10 (Richardson-Lucy)                | scene-linear                  |
| 10 Noise reduction    | § 3.11                                  | scene-linear                  |
| 11 Crop & rotate      | § 3.12                                  | scene-linear                  |
| 12 View transform     | § 3.6a (AgX)                            | scene-linear → display-linear |
| 13 Target gamut       | Rec.2020 → sRGB or P3 matrix            | display-linear                |
| 14 Gamma encode       | piecewise sRGB                          | display gamma-encoded         |

---

## What this document does not define

- **How an algorithm is executed on GPU** (shader specifics, tile sizes, buffer formats). See [`05-performance.md`](./05-performance.md).
- **What colorspace an algorithm's inputs and outputs are in**. See [`04-color-management.md`](./04-color-management.md).
- **Parameter round-trip through the sidecar**. See [`01-data-model.md`](./01-data-model.md) and [`xmp-canonical-format.md`](../xmp-canonical-format.md).
- **Platform-specific implementation choices** (Metal vs WebGL2 shader sources). See [`06-cross-platform.md`](./06-cross-platform.md).
