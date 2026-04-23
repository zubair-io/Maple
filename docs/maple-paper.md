# Maple: A Scene-Referred, Cross-Platform RAW Editor with Adobe-Compatible Lossless Round-Trip

*A technical paper describing the design, image science, and engineering of a cross-platform non-destructive RAW photo editor.*

-----

## Abstract

Maple is a non-destructive RAW photo editor that runs natively on macOS, iPadOS, and iOS, and in evergreen web browsers, over a single Rust image-processing core. Three design commitments shape every decision in the system: (1) the image pipeline is **scene-referred** in linear Rec.2020 D65 at full 32-bit floating-point precision, with a single AgX view transform at the end of the chain mapping scene-linear radiances onto display-linear targets; (2) every adjustment is losslessly round-trippable with Adobe Lightroom through the `crs:` XMP namespace, so sidecars written by either application open cleanly in the other; (3) the three user-facing platforms render the same `AdjustmentModel` to pixel-parity within 1×10⁻⁴ linear on an AgX parity harness and ΔE₀₀ ≤ 1 on a perceptual harness. This paper describes the image-science foundations (scene-referred working space, DCP-driven camera calibration, the AgX view transform, Bradford chromatic adaptation, chroma-preserving vibrance in Oklab), the pipeline architecture (decode → demosaic → DCP → scene-linear chain → view transform → display encode), the cross-platform strategy (Rust core behind C-FFI and WASM, platform-native pipeline implementations with numeric parity gates), and the engineering work that makes it interactive on a 100MP RAW on consumer hardware (two-phase rendering, five-layer cache hierarchy, tiled f32 working textures on constrained devices).

-----

## 1. Introduction

### 1.1 Problem statement

Raw digital camera files are not images — they are measurements. A 14-bit Bayer-patterned array records scene radiance, one color channel per sensor site, in a sensor-specific linear space that no display can reproduce directly. Turning this into a viewable photograph requires a long chain of operations — sensor linearization, demosaicing, white balance, color calibration, tone mapping, gamut mapping, and display encoding — each of which can be implemented well or badly, and each of which the photographer may want to re-tune weeks later with the original capture preserved.

A modern non-destructive RAW editor is, then, three systems bolted together: a **color-science renderer** that takes measurements and produces pixels, a **persistence format** that records the user's intent without touching the original file, and an **interactive UI** that keeps the renderer responsive while the user drags sliders on a 100-megapixel image.

Three constraints have historically forced compromises in this design:

1. **Display-referred working spaces.** Most editors have operated in a working space whose [0, 1] range represents "display black to display white." This simplifies the UI and the GPU pipeline — values clamp, hardware is fast at fixed-point — but it means every highlight-recovery operation is fighting values that have already been tone-mapped. The information loss happens before the user's slider sees it.
1. **Platform-native is exclusive with portable.** A Core Image pipeline on macOS uses CIFilter graphs and Metal kernels; a WebGL2 pipeline in a browser uses GLSL fragment shaders. Writing image-science code twice (or more) means two paths to diverge subtly under load, and color science is exactly where "subtly" is expensive — a 1% drift in an AgX sigmoid coefficient produces visible hue shifts on saturated highlights that users will notice and blame on the editor.
1. **Proprietary persistence.** Adobe's `.xmp` sidecar schema is a de facto standard, but most non-Adobe editors either ignore it or embed it as one opaque field among others. A user who imports a Lightroom-edited sidecar into a non-Adobe editor typically loses masks, history entries, and any proprietary field the editor doesn't understand — and often can't round-trip back.

Maple takes a deliberate position on each of these.

### 1.2 Position

**Scene-referred, not display-referred.** The working texture holds physically-meaningful scene values — diffuse white is nominally 1.0, specular highlights and light sources run 5–20× higher, and every stage before the view transform is free to produce values above 1.0 or below 0. A dedicated view transform (AgX, following Blender's default in version 4.0+) is the single stage that compresses scene range into display range. Shadow and highlight manipulation operate on radiometrically-meaningful data.

**One Rust core, three native pipelines.** The expensive, testable mathematics — RAW container parsing, demosaic, DCP interpretation, Bradford adaptation, tone-curve LUT generation, dark-channel dehaze, Richardson-Lucy capture sharpening — lives in a single Rust crate. That crate is compiled once as a static library for Apple (consumed through cbindgen-generated C headers) and once as WebAssembly for browsers (through wasm-bindgen). The *interactive* GPU path is implemented separately on each platform in its idiomatic GPU language (Metal Shading Language on Apple, GLSL ES 3.0 on the web), but both consume constants and coefficients generated from the same Rust source, and both are gated against the Rust reference implementation to per-pixel numeric parity.

**XMP as contract, not container.** Maple's sidecars are byte-canonical files in the `crs:` namespace, compatible with Lightroom's PV11 (Process Version 2022) schema. Fields Maple implements round-trip through the full `parse → interpret → mutate → serialize` chain and emerge byte-identical when nothing changed; fields Maple does not implement are preserved verbatim as passthrough XML, so that Lightroom-authored masks, history, and snapshots survive a Maple edit session unmodified.

The rest of the paper walks through the technical decisions that follow from these positions.

-----

## 2. Scene-Referred Imaging: The Foundation

The single most load-bearing decision in Maple is the choice of working space and reference state. Everything downstream — the shape of the slider UI, which algorithms are tractable, how exports behave, whether the same edit looks the same on an sRGB and a P3 display — depends on what space the pixels are in during editing.

### 2.1 Display-referred: the classical pipeline

A display-referred pipeline holds values whose [0, 1] range represents "what the display will show." A pixel of value `(1.0, 1.0, 1.0)` is display white; a pixel of value `(0.0, 0.0, 0.0)` is display black. Values above 1.0 are not allowed (they have no representable display output), and values below 0 are typically clamped.

Implementing in a display-referred space is attractive for three reasons: fixed-point GPU arithmetic is fast, `uint8` and `float16` textures are adequate for precision, and many operations (saturation, gamma, 3D LUTs) have well-understood formulations in this space. Almost every raster editor before the mid-2010s was structured this way.

The cost becomes apparent when a scene contains light that exceeds display reproducibility — bright skies, specular reflections, neon signs, direct sun. In a display-referred pipeline, these pixels are clipped before the user's sliders ever see them. A "highlight recovery" slider in this regime is, operationally, either (a) bending the tone curve to decompress values that were already compressed (information is gone) or (b) running a separate RAW decode pass with reduced exposure and compositing (possible but awkward). Neither is mathematically clean.

### 2.2 Scene-referred: the physical model

A scene-referred pipeline holds values whose magnitudes are proportional to scene radiance. Middle gray is conventionally 0.18 (from the 18% reflectance of a photographic gray card), diffuse white is 1.0, a bright sky is 3–5, a specular highlight is 20, direct sun is 10⁴ or higher. Zero represents zero light; negative values, if they appear, are numerical artifacts of subtractive operations on channels and are carried through without clamping because downstream stages can handle them cleanly.

The mathematical consequence is that **exposure becomes a linear operation**:

$$\text{exposure}(x, \text{EV}) = x \cdot 2^\text{EV}$$

This is the correct physics of camera exposure — a one-stop-brighter exposure is literally twice the photons at the sensor — and the math holds at every value. In a display-referred pipeline, the same slider has to be nonlinear because `1.0 × 2 = 2.0` is outside the representable range; a display-referred exposure has to be implemented as a curve that asymptotes toward 1.0, which changes the semantics depending on where in the range the pixel starts.

Similar simplifications apply throughout:

- **White balance** is a per-channel multiply. Correct at every value.
- **Highlight recovery** lifts information that was clipped at the *sensor*, not at the working space. Reconstructed values can legitimately reach 3.0 or higher; they are passed downstream unmodified.
- **Per-channel tone curves** operate on a known radiometric domain; a curve authored against scene data has meaningful ranges (shadows 0–0.05, midtones 0.05–0.5, highlights above 1.0) independent of the target display.

### 2.3 The view transform

The payoff of a scene-referred working space requires a dedicated stage that compresses scene range into display range with taste. This is the **view transform**. Maple uses **AgX** (Troy Sobotka, 2020; upstreamed as Blender 4.0's default), chosen for three reasons:

1. **Per-channel sigmoid compression.** AgX encodes each RGB channel in log space, clamps to a defined exposure range (MIN_EV = −10, MAX_EV = +6.5 relative to middle gray), normalizes to [0, 1], and applies a sigmoid to compress the extremes into the display range. Because the sigmoid is applied *per channel*, a highly saturated pixel (say, a red channel at 20 and green/blue at 0.2) has its red channel roll off toward 1.0 while the green and blue remain low — the *result* is automatically desaturated as saturation approaches display-gamut limits. This is perceptual gamut compression at no additional cost, and it is why AgX does not need a separate gamut-clipping stage.
1. **Neutrality and tunability.** AgX ships with a "base" sigmoid that is deliberately photographic — not an attempt at a specific cinematographic look, but a reference compression curve that handles skin, sky, and specular highlights palatably. Creative "looks" (Maple's planned Punchy, Muted) are applied *before* the sigmoid, in the log-encoded domain, so they compose naturally with tone controls.
1. **Community validation.** AgX has been the default view transform for Blender's renderer since late 2023 and has been stress-tested against millions of photographic and CG images by the Blender community. The reference implementation is open-source GLSL and OCIO.

Maple's AgX is implemented three times for numeric parity (Rust reference on CPU, Metal on Apple GPU, GLSL on web GPU), with a pre-ship verification step that perturbs a single coefficient by 1% in the Rust reference and confirms the platform tests all detect it. The tolerance (1×10⁻⁴ per channel across the active sigmoid domain) is set deliberately tight — the sigmoid's steep midtone region amplifies coefficient drift, so a tighter tolerance here catches errors that would only become visible on rare images.

The contrast slider in the UI does not apply a contrast curve in scene-linear space; instead it modulates the AgX sigmoid slope:

$$\text{slope}_\text{effective} = \text{slope}_\text{base} \cdot (1 + \frac{\text{contrast}}{100} \cdot 0.5)$$

This places perceptual contrast at the one pipeline stage where it semantically belongs — the tone-compression stage — and keeps the scene-linear chain as a radiometric operation set.

### 2.4 Working space: Linear Rec.2020 D65

The pipeline's working space is **linear Rec.2020 with D65 white point**, held as 32-bit floating-point RGBA. Three considerations drove the choice:

|Candidate   |Verdict                                                                                                                                                                                           |
|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|**sRGB**    |Too narrow. Camera captures routinely exceed sRGB gamut in saturated reds and greens; clamping into sRGB during editing causes irrecoverable information loss.                                    |
|**ProPhoto**|D50 white point creates chromatic-adaptation overhead on every export to P3/sRGB displays. Gamut is "wider than any physical camera" only because it contains imaginary colors that nothing emits.|
|**ACEScg**  |D60 white point is awkward for stills (no common display native). Gamut is wider than Rec.2020 but not usefully so for photography.                                                               |
|**Rec.2020**|D65 native (matches sRGB, Display P3, and Rec.2020 HDR targets — no chromatic adaptation on export). Wide enough to hold every physical camera's gamut. **Chosen.**                               |

The rule of thumb: choose a white point that matches your delivery surface, a gamut that contains your input surface, and a transfer curve that matches your arithmetic (linear). Rec.2020 D65 linear is the smallest space satisfying all three for a modern photography pipeline.

### 2.5 Bit depth: f32, not f16

The classical display-referred pipeline uses `float16` working textures because f16's 10-bit mantissa is adequate for values in [0, 1] to quantize cleanly to 8-bit display output. Scene-referred changes this calculus.

A deep shadow in scene-linear at value 0.001 is a valid, editable pixel — it represents a real scene element (a dark leaf in shadow, a black cat's fur) that the user may want to lift with a shadows slider. At that magnitude, f16's quantization step is approximately 2⁻¹⁴ ≈ 6 × 10⁻⁵, which produces visible banding when multiplied up by a shadow-lift operation. f32's quantization step at the same magnitude is 2⁻³⁰, far below any visible threshold.

The cost is 2× working-texture memory. A 25MP RGBA scene-linear image at f32 occupies ~400MB; at f16 it would be ~200MB. This is manageable on all current Mac hardware and on M-series iPads; on older iPads (A14 and earlier) the pipeline tiles the working texture into sections to stay under a 200MB live budget. The memory pressure, not the bit depth itself, is what constrains performance on constrained devices — and tiling is a mature technique that does not compromise image quality.

### 2.6 Sanity-check intuition

The pipeline's reference-state invariant can be summarized with a few worked examples:

- A pixel at scene-linear value 0.18 (middle gray, the sensor's nominal 18% reflectance target) will, after AgX, land near display-linear 0.18 as well — AgX is tuned so middle gray passes through near-identically.
- A sensor-saturated pixel at 1.0 in scene-linear (post-decode, assuming no highlight recovery) will land on the *toe* of the AgX shoulder — around 0.92–0.95 in display-linear — not at display white.
- A specular highlight at scene-linear 20 will land on the AgX shoulder near 0.99.
- A reconstructed highlight at scene-linear 3.5 (blend mode of highlight recovery on a one-channel clip) will land cleanly between the sensor-saturation and specular cases, producing a natural highlight rolloff rather than a hard clip.

These are not parameters of any slider; they are consequences of the log encode + sigmoid shape.

-----

## 3. System Architecture

### 3.1 Three-layer structure

Maple is organized as three layers stacked vertically, with each layer having a clearly defined responsibility.

```
┌─────────────────────────────────────────────────────────┐
│  Platform-native UI                                     │
│   SwiftUI on Apple  /  Angular on Web                   │
├─────────────────────────────────────────────────────────┤
│  Platform-native interactive pipeline                   │
│   CIFilter + Metal on Apple  /  WebGL2 on Web           │
├─────────────────────────────────────────────────────────┤
│  Shared Rust core                                       │
│   raw-core + raw-ffi + raw-wasm                         │
└─────────────────────────────────────────────────────────┘
```

The UI layer is not shared between platforms and makes no attempt to be; SwiftUI and Angular are different frameworks with different idioms, and trying to abstract over them creates lowest-common-denominator interfaces that fit neither well.

The interactive pipeline layer *implements the same math twice*, once in Metal and once in GLSL, because the cost of a cross-platform GPU abstraction (WebGPU is the nearest candidate) is not yet recoverable — Safari support is still landing, and the abstraction would ship a degraded path on the platforms that already have well-tuned native GPU APIs.

The Rust core is the only truly shared code. It owns: RAW container parsing (the `rawler` crate, which handles the camera-vendor file formats), demosaic (four variants at different quality/speed points), DCP parsing and transform, Bradford chromatic adaptation, tone-curve LUT generation, dark-channel-prior dehaze, Richardson-Lucy capture sharpening, auto-exposure, histogram computation, and the tile planner. It does not own a GPU context or any async runtime — callers provide both, so the core is a pure CPU function library with no platform dependencies.

### 3.2 The FFI boundaries

**Rust → Apple** is a C ABI surface of three exported functions plus a handful of getters. A call to `raw_decode_and_demosaic(bytes, len, &handle)` parses the RAW, runs demosaic, and returns an opaque pointer to a heap-allocated `DemosaicedImage`. Apple-side Swift wraps this in a `DemosaicedImage` class whose `asCIImage()` method constructs a Metal buffer directly on top of the Rust allocation — zero-copy, enabled by `bytemuck` for safe reinterpretation — and hands it to Core Image as a `CIImage`. The Rust allocation outlives the Core Image reference because `EditSession` holds the handle for the session's lifetime.

**Rust → Web** is wasm-bindgen, which produces TypeScript-visible classes (`WasmDemosaiced`) and handles the marshaling between WASM linear memory and JavaScript `ArrayBuffer`s. The decoded pixel buffer is uploaded to a WebGL2 `RGBA32F` texture via `gl.texSubImage2D`. Unlike Apple, there is no zero-copy path — WebGL2 texture uploads always copy — but the cost is amortized over the session because the upload happens once per image open, not once per slider tick.

In both cases the contract is the same: **the Rust core produces a scene-linear Rec.2020 D65 RGBA f32 buffer, and the GPU pipeline picks it up from there**. Everything above the FFI line is platform-specific; everything below is shared.

### 3.3 Stage decomposition of the interactive pipeline

The pipeline is a 14-stage sequence, split into three bands by reference state:

**Scene-linear band (stages 1–11):**

1. Neutral decode (RAW container → sensor linearization → demosaic → highlight recovery → DCP transform → Rec.2020 D65)
1. White balance (CCT + tint → per-channel gain in Rec.2020)
1. Scene tone controls (exposure, highlights, shadows, whites, blacks, scene-linear tone curves; contrast is *not* here)
1. Vibrance (chroma-preserving, skin-protected, in Oklab)
1. Saturation (chroma scale in Oklab)
1. Clarity (wide-radius scene-linear unsharp mask)
1. Texture (narrow-radius scene-linear unsharp mask)
1. Dehaze (dark-channel prior, applied in scene-linear)
1. Capture sharpening (Richardson-Lucy deconvolution, 3 iterations)
1. Noise reduction (non-local means on Apple; scene-linear bilateral on web in v1)
1. Crop (applied in scene-linear; AgX and display encode see the cropped frame)

**View transform (stage 12):**

1. AgX view transform (scene-linear Rec.2020 → display-linear Rec.2020)
   12a. Display-referred tone curve (optional; only populated from Lightroom-imported or explicitly-authored display-space curves)

**Display encode (stages 13–14):**

1. Target-gamut matrix (Rec.2020 → sRGB or Rec.2020 → P3, compiled-constant 3×3)
1. Gamma encode (piecewise sRGB or P3 transfer curve)

The order is not arbitrary. Several constraints are load-bearing:

- **White balance before tone.** Tone-shaping semantics assume a neutrally balanced scene; applying tone before WB would couple highlight recovery to the illuminant.
- **Vibrance before saturation.** Vibrance's skin-protection heuristic relies on being able to measure chroma before saturation flattens it out.
- **Clarity before texture.** Clarity is a mid-frequency operator (reference radius 40px at 2000px long-edge); texture is a high-frequency operator (3px). Composing them in wide-then-narrow order lets texture shape the details that clarity left behind; reversing produces a flatter result.
- **Sharpening and NR before the view transform.** Edge artifacts introduced post-AgX would be modulated by the sigmoid's slope and become unpredictable across scenes. Applying sharpening on scene-linear produces predictable edges.
- **Crop inside scene-linear.** If crop were after display encode, zoom and pan would re-run AgX on every frame with a different input crop, making quality regressions hard to attribute.

Each stage is skippable when its parameters are at their defaults, and the Apple `CIFilter` graph composes lazily — stages that don't contribute are not in the graph. On the web, the main chain is fused into a single GLSL fragment shader (one draw call per slider change), with clarity/texture/sharpen/NR rendered into intermediate FBOs as separate passes when non-default.

### 3.4 Data model and the XMP contract

Every non-destructive edit in Maple is a field in a `AdjustmentModel` record, grouped by UI panel:

- **Tone:** exposure, contrast, highlights, shadows, whites, blacks
- **WB:** temperature (Kelvin), tint (green-magenta)
- **Presence:** vibrance, saturation, clarity, texture, dehaze
- **Detail:** sharpenAmount, sharpenRadius, sharpenDetail, sharpenMasking, nrLuminance, nrColor
- **Geometry:** crop.{top, left, bottom, right}, crop.angle
- **Tone curves:** sceneLinear{Master, R, G, B}, displayReferred{Master, R, G, B}
- **Passthrough buckets:** unknown fields and XML nodes preserved verbatim for Lightroom round-trip

The model is a plain record — no behavior attached, no references to GPU state, no dependencies on the pipeline. Copying, diffing, snapshotting for undo/redo, and serializing are all straightforward operations on the value type.

Serialization is byte-canonical. The rules are enforced strictly because the hardest test in the system is:

> bytes → parse → AdjustmentModel → serialize → bytes₂

must produce `bytes₂ == bytes` when no fields change, across every platform, for both Maple-authored and Lightroom-authored sidecars. This requires:

- Namespace declaration order is fixed by priority (`xmp:` → 0, `crs:` → 1, `papp:` → 2, `xmpMM:` → 3, unknown → 500), then alphabetical within each priority band.
- Numbers emit canonically: integers without `.0`; non-integers at 2 decimal places with trailing zeros stripped (`0.50 → "0.5"`, `0.123 → "0.12"`); NaN and Infinity are replaced with the field's default.
- Non-default fields only (except `crs:Version`, `crs:ProcessVersion`, `crs:HasSettings`, which are always emitted).
- Passthrough XML nodes — elements Maple doesn't interpret — are re-emitted verbatim from their stored raw form, preserving byte order, whitespace, and attribute ordering.
- Line endings are LF. No trailing newline. The UTF-8 BOM inside `<?xpacket begin="﻿" ...?>` is literal, not stripped.

The payoff is that a Lightroom sidecar containing ten mask groups, a history list, and a snapshot stack can pass through Maple — be edited in Maple's sliders, re-saved — and round-trip to Lightroom with every unsupported field intact.

The data model distinguishes two **tone curve families** that coexist on the same image:

- **Scene-linear curves** (Maple's primary, `papp:SceneLinearToneCurve*`) apply at stage 3 with the curve's `[0, 255]` domain mapped to scene `[0, 4.0]` — reaching two stops above diffuse white to let the user shape highlights without truncating specular detail that AgX would have preserved.
- **Display-referred curves** (Lightroom-compatible, `crs:ToneCurvePV2012*`) apply at stage 12a *after* AgX, in display-linear `[0, 1]`. These exist because Lightroom-imported curves were authored against Lightroom's internal (proprietary, version-dependent) view transform; re-deriving them as scene-linear curves would require knowing Lightroom's view transform exactly, and approximating via inverse AgX is lossy. A separate pipeline slot in display space preserves the authored intent and round-trips losslessly.

Both families can be active simultaneously. Users who exclusively edit in Maple converge on scene-linear curves; users who import Lightroom work retain display-referred curves until they choose to re-author.

-----

## 4. Image Science: Algorithms in Depth

This section describes the mathematics of the non-trivial stages in enough detail to reimplement them. Each algorithm is presented with its input/output contract, its math, its parameter surface, edge cases, and a lineage note identifying what is adopted from prior art vs derived for Maple.

### 4.1 RAW decode and sensor linearization

The RAW container (DNG, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, DCR, MOS, MRW, IIQ) is parsed via the `rawler` Rust crate, which produces a `RawImage` record containing the sensor's raw 16-bit data in Bayer-patterned layout, the black and white levels (either per-exposure from metadata or sensor-nominal), the CFA pattern string (RGGB, GRBG, GBRG, BGGR, or Fuji's X-Trans 6×6), and embedded color matrices if present.

Sensor linearization is a three-line operation:

$$\text{linear}_i = \text{clamp}\left(\frac{\text{raw}_i - \text{black}}{\text{white} - \text{black}}, 0, 1\right)$$

The result is a `Vec<f32>` in `[0, 1]` in camera-native space — not yet demosaiced, not yet color-calibrated, not yet in any standard color space.

### 4.2 Demosaic

Bayer-patterned data has one color channel per pixel; demosaic interpolates the missing two. Maple implements three variants at different quality/speed operating points:

**Bilinear** is the preview-default. For each missing channel at each pixel, interpolate from the nearest neighbors of the same channel: reds at green and blue positions average 2 or 4 nearest reds, and so on. Border pixels use mirror-reflection for out-of-bounds reads (simple clamping produces a visible green tint at image edges, because green is sampled twice as densely as red or blue in a Bayer pattern).

**Half-resolution quad** collapses each 2×2 Bayer cell into a single RGB pixel by taking the red and blue positions directly and averaging the two greens:

```
R_out[y, x] = raw[2y,   2x]
G_out[y, x] = (raw[2y,   2x+1] + raw[2y+1, 2x]) / 2
B_out[y, x] = raw[2y+1, 2x+1]
```

This produces a half-dimensional (quarter pixel count) output that is very close to lossless for preview purposes and fits comfortably in memory on constrained devices. A 100MP sensor produces 25MP of output at quarter the memory cost.

**AMaZE / Hamilton-Adams** is the export-quality demosaic. Hamilton-Adams interpolates green first using a directional gradient test over a 5×5 neighborhood:

```
ΔH = |G_right - G_left|  + |center - (R_left + R_right)/2|
ΔV = |G_up    - G_down|  + |center - (R_up    + R_down)/2|

if ΔH < ΔV:   G_at_R = (G_left + G_right)/2 + (2·center - R_left - R_right)/4
elif ΔV < ΔH: G_at_R = (G_up   + G_down)/2  + (2·center - R_up   - R_down)/4
else:         G_at_R = mean(all four neighbors)
```

then interpolates red and blue at green positions using color-difference (R−G, B−G) smoothness, and finally red at blue positions and blue at red positions using 2D diagonal interpolation. Because green is sampled twice as densely as red or blue on a Bayer sensor, green carries most of the luminance information; resolving green first and interpolating R and B as offsets from green preserves edges dramatically better than independent channel interpolation.

AMaZE (Martinec, ~2010) extends HA by making the directional decision adaptive based on local color correlation, producing fewer zipper artifacts at high-contrast edges. Both are exposed as RawTherapee's reference implementation; Maple reimplements from the published mathematics with RawTherapee as numerical cross-reference but without copying code.

### 4.3 Highlight reconstruction

Between demosaic and the DCP color transform sits an optional highlight reconstruction stage. The DCP matrix mixes channels, so any reconstruction must happen *before* it — otherwise the information about which channel clipped is destroyed by the matrix mix.

Two modes are available:

- **Blend** (default on): for pixels where one or two channels are within ε ≈ 0.005 of 1.0, lerp the clipped channels toward the maximum of the unclipped channels, allowing the result to exceed 1.0 by the ratio implied by a local 5×5 unclipped neighborhood. Cheap. Failure mode: gray-haze in cloud detail if overdone.
- **Luminance Recovery**: for single-channel-clipped pixels, set the clipped channel to `max(unclipped) · scale`, where `scale` is the local luminance ratio inferred from a 5×5 unclipped neighborhood. Allows reconstructed values well above 1.0. More expensive. Failure mode: haloing at hard specular edges.

The architectural payoff of scene-referred working space appears here: reconstructed values that exceed 1.0 are passed downstream without modification. AgX's sigmoid shoulder absorbs them. In a display-referred pipeline, these values would be clamped before any slider could see them; here, they remain editable through the full chain.

### 4.4 DCP-based color transform

Converting demosaiced camera-native RGB to a standard reference color space is the job of the DNG Camera Profile (DCP) — a file containing the camera-specific calibration matrices. A DCP contains:

- **ColorMatrix1/2** — camera-to-XYZ under two illuminants (typically StdA at ~2850K and D65 at ~6500K).
- **ForwardMatrix1/2** — XYZ-to-ProPhoto under each illuminant (optional but increasingly standard).
- **HueSatMap1/2** — 3D lookup tables (hue × saturation × value) of additive hue offsets and multiplicative saturation/value offsets, per illuminant.
- **ProfileLookTable** — optional final 3D LUT for "look" character.

The transform takes the camera's as-shot CCT (correlated color temperature) and interpolates between the two illuminant calibrations using a reciprocal-CCT weight:

$$t = \frac{1/\text{CCT}_\text{shot} - 1/\text{CCT}_1}{1/\text{CCT}_2 - 1/\text{CCT}_1}$$

Reciprocal (rather than linear) CCT interpolation is the DNG standard because equal-perceptual steps in color temperature are roughly equal in reciprocal Kelvin (mired). The interpolated matrices, forward matrix, and HueSatMap are then applied sequentially per pixel:

1. Camera RGB → XYZ via the interpolated color matrix.
1. Chromatic adaptation to D50 via Bradford (folded into ForwardMatrix when present).
1. XYZ → ProPhoto linear via interpolated ForwardMatrix.
1. HueSatMap application: convert to ProPhoto HSV, trilinearly sample the map for `(Δh, Δs·scale, Δv·scale)` corrections, apply, convert back.
1. Optional ProfileLookTable (same math as HueSatMap, applied once more as a stylistic tweak).
1. A compiled-constant exit matrix `M_pro_to_rec2020` that folds (ProPhoto → XYZ D50, Bradford D50 → D65, XYZ D65 → Rec.2020) into a single 3×3. No per-pixel chromatic adaptation at runtime.

The choice to do the DCP math in ProPhoto D50 rather than the working space's Rec.2020 D65 is dictated by the DNG specification — every DCP in existence was authored assuming ProPhoto D50 as the interchange space. Fighting the spec would require deriving our own camera profiles, which is the kind of reinvention that has destroyed other editors. The exit matrix does the cleanup once, at startup, and the rest of the pipeline never sees ProPhoto again.

### 4.5 White balance

White balance in a scene-linear working space is simply a per-channel multiplication:

```
xy_target  = cct_to_xy(temperature)              // Planckian locus approximation
xy_target.y += tint · 0.001                       // green-magenta shift
XYZ_target = xy_to_XYZ(xy_target, Y=1)

gain = XYZtoRec2020 · (XYZ_target / XYZ_D65)
gain /= gain.g                                    // normalize to green

out = in · gain
```

The `cct_to_xy` function can be any Planckian locus approximation; Maple uses the Hernández-Andrés polynomial. The 0.001 scaling on tint matches Lightroom's perceived strength from reference comparisons.

An eyedropper WB sample is the inverse of this: the user clicks a pixel that should be neutral, the solver computes the gain triple that would make that pixel's RGB equal, back-solves for `(temperature, tint)`, and writes those values into the model. The slider display then shows the sampled values.

### 4.6 Scene tone controls

Exposure, highlights, shadows, whites, blacks, and per-channel tone curves all operate on scene-linear Rec.2020 values. Contrast, notably, is not in this group — it modulates the AgX sigmoid slope.

```glsl
// 1. Exposure: linear, unbounded output.
rgb *= exp2(exposure);

// 2. Highlights: soft compression above a scene threshold at ~1.0
//    Compress the upper range into a shoulder; does NOT clip (AgX handles).
if (highlights != 0) {
    vec3 shoulder = smoothstep(0.8, 2.0, rgb);
    float amount = highlights / 100.0;
    // Negative highlights pull brights down; positive lifts toward more specular detail.
    rgb -= rgb * shoulder * amount * 2.0;
}

// 3. Shadows: lift deep scene values below ~0.1
if (shadows != 0) {
    float threshold = 0.1;
    float amount = shadows / 100.0;
    float luma = dot(rgb, LUMINANCE_WEIGHTS_REC2020);  // (0.2627, 0.6780, 0.0593)
    float mask = 1.0 - smoothstep(0.0, threshold, luma);
    rgb += rgb * (mask * amount * 0.5);
}

// 4. Whites: endpoint shift near diffuse white
rgb *= (1.0 + whites / 200.0);

// 5. Blacks: endpoint shift near zero (can produce small negatives; AgX handles)
rgb += blacks / 400.0;

// 6. Tone curves (master, R, G, B), sampled as 256-entry f32 LUTs
//    Curve's [0, 255] domain maps to scene [0, 4.0].
if (masterCurve != identity) rgb = sample_scene_lut(masterCurveLUT, rgb, 4.0);
if (redCurve    != identity) rgb.r = sample_scene_lut(redCurveLUT,   rgb.r, 4.0);
if (greenCurve  != identity) rgb.g = sample_scene_lut(greenCurveLUT, rgb.g, 4.0);
if (blueCurve   != identity) rgb.b = sample_scene_lut(blueCurveLUT,  rgb.b, 4.0);
```

The luminance weights `(0.2627, 0.6780, 0.0593)` are Rec.2020's primaries' luminance coefficients (same derivation as Rec.709's `(0.2126, 0.7152, 0.0722)`, with Rec.2020's wider-gamut primaries).

The scene-linear LUT reference range of `ref_max = 4.0` is deliberate: it covers two stops above diffuse white, which is enough headroom for creative tone curves without letting the user's curve truncate specular detail that AgX would have preserved. A curve authored in the tone-curve editor effectively has a flat tail above value 4.0.

The specific constants (`0.5` shadow coefficient, `200.0` whites denominator, `400.0` blacks denominator, `2.0` highlights multiplier) are initial values pending a one-person-week calibration pass against a reference scene set — this is what it takes to make the sliders feel like the sliders in Lightroom, which is where users bring their expectations.

### 4.7 Vibrance: chroma-preserving saturation with skin protection

Saturation and vibrance both adjust colorfulness. The difference is that vibrance protects skin tones — a positive vibrance boost should not turn a portrait orange. Maple implements vibrance in **Oklab**, the perceptually uniform color space (Björn Ottosson, 2020), for three reasons:

1. Oklab is designed so that equal Euclidean distances in the `(a, b)` plane correspond to roughly equal perceptual color differences. Chroma operations (scaling `sqrt(a² + b²)`) are perceptually uniform.
1. Oklab is a derivation from XYZ via a matrix and a cube root; it does not depend on the RGB working space. The same vibrance operation produces the same perceptual result whether the target is sRGB, P3, or Rec.2020.
1. Transforming in and out of Oklab is cheap: two 3×3 matrices and a per-component cube root per pixel.

The full per-pixel operation:

```glsl
// 1. Rec.2020 linear → Oklab (via LMS intermediate)
vec3 lms = rec2020_to_lms(rgb);          // 3x3 matrix
lms = sign(lms) * pow(abs(lms), 1.0/3.0); // perceptual compression
vec3 lab = lms_to_oklab(lms);             // 3x3 matrix
float L = lab.x, a = lab.y, b = lab.z;

// 2. Chroma and hue
float chroma  = sqrt(a*a + b*b);
float hue_deg = atan2(b, a) * 180.0 / PI;

// 3. Skin-tone protection window in Oklab hue
//    Endpoints locked by pre-ship calibration against 30-portrait
//    Fitzpatrick I-VI set.
float skinMask = smoothstep(15.0, 22.0, hue_deg)
               * (1.0 - smoothstep(35.0, 42.0, hue_deg));

// 4. Non-linear chroma boost: low-chroma pixels get more amplification
float chromaBoost = (1.0 - min(chroma / 0.3, 1.0)) * vibrance / 100.0;

// 5. Attenuate boost in skin window
chromaBoost *= (1.0 - skinMask * 0.6);     // 60% skin protection

// 6. Scale chroma, preserve lightness
float new_chroma = chroma * (1.0 + chromaBoost);
float scale = (chroma > 0.0) ? new_chroma / chroma : 1.0;
a *= scale;
b *= scale;

// 7. Back to Rec.2020
rgb = oklab_to_rec2020(vec3(L, a, b));
```

The non-linear boost — low-chroma pixels receive more amplification — is what distinguishes vibrance from saturation. A user boosting vibrance on a portrait lifts the saturation of pale sky and muted foliage more than the already-saturated skin, which achieves "the photo looks more alive without making the skin cartoonish."

The skin-tone hue window endpoints (15°, 22°, 35°, 42°) are placeholders pending a pre-ship calibration against 30 portraits covering Fitzpatrick I–VI skin tones across six lighting conditions (daylight, tungsten, overcast, golden hour, fluorescent, mixed) and unusual-WB shots. The endpoints are locked fixed once calibration produces them — they are precision parameters, not a creative slider, and exposing them would invite UX confusion ("why are my skin tones orange?"). This is a calibration gate that blocks shipping: CI enforces pixel-parity of the vibrance output against the 30-image golden set to 1×10⁻⁴ linear.

### 4.8 Clarity, Texture, Dehaze

Clarity and texture are both unsharp masks operating in scene-linear Rec.2020, distinguished by radius:

- **Clarity:** reference radius 40px at 2000px long-edge (a mid-frequency operation).
- **Texture:** reference radius 3px at 2000px long-edge (a fine-frequency operation).

The radius scales linearly with image long-edge:

$$\text{actual radius} = \text{reference radius} \cdot \frac{\text{long edge}}{2000}$$

This ensures the same slider produces the same perceptual effect across preview (at ~1000px long-edge) and export (at native resolution, possibly 10000+ px long-edge). Long-edge scaling is preferred over total pixel count because users perceive linear features (a face, a building, a leaf) that scale with linear dimension, not with area.

The unsharp operation:

```
blurred = gaussian_blur(rgb, radius)
out = rgb + (rgb - blurred) * (slider / 100)
```

Scene-linear unsharp has properties that are not possible in display-referred:

- Positive values can exceed 1.0 at the bright edge of a contrast edge (light-side ringing). **Allowed** — AgX compresses it into the highlight shoulder naturally, so no clipping artifact appears.
- Negative values slightly below 0 can appear at dark-edge ringing. **Allowed** in small amounts — clamping at 0 introduces visible banding on dark edges. AgX's toe clamp handles the dip.

**Dehaze** implements the He-Sun-Tang dark-channel-prior algorithm (2009). For each pixel, compute the dark channel as `min` over a 15×15 neighborhood of `min(r, g, b)`. This estimates atmospheric scatter — haze is characterized by non-zero minimums in all channels over small neighborhoods. The brightest 0.1% of dark-channel pixels give the atmospheric light `A`; the transmission map `t` is derived from the ratio of dark-channel to `A`. A guided filter refines `t`, and the scene radiance is recovered as `J = (I - A) / max(t, 0.1) + A`.

The interactive path runs the full algorithm on a quarter-size downsampled buffer (transmission maps are intrinsically low-frequency — atmospheric scatter varies smoothly across a scene — so the quarter-res approximation is below visible threshold) and upsamples the transmission map to full resolution for application. Export uses the full algorithm at native resolution.

### 4.9 Capture sharpening: Richardson-Lucy deconvolution

Capture sharpening recovers the high-frequency detail lost to the optical point-spread function (PSF) of the lens — diffraction, optical aberrations, and sensor pixel-aperture effects. Unlike display sharpening (which exists to compensate for downsampling to the output size), capture sharpening is an approximate inverse of a physical blur and has mathematical structure.

Maple uses **3-iteration Richardson-Lucy deconvolution** in scene-linear Rec.2020 as the sole capture-sharpening algorithm. Given an observed image `O`, a current estimate `E_n`, and a PSF `P`:

$$E_{n+1} = E_n \cdot \left(\frac{O}{E_n \circledast P} \circledast P_\text{flipped}\right)$$

where `⊛` is 2D convolution and `P_flipped` is the PSF flipped in both spatial dimensions. Initialize `E_0 = O`. Three iterations give a good balance between detail recovery and artifact amplification on most photographic content.

The PSF is modeled as a Gaussian with sigma controlled by the `sharpenRadius` slider (0.5–3.0). This is an approximation — a real lens PSF is not exactly Gaussian — but the Gaussian approximation is close enough that the deconvolution produces visibly sharper output without the ringing artifacts that over-accurate PSF models produce in the presence of noise.

The `sharpenAmount` slider (0–150) controls the mix between the unmodified input and the RL output:

- 0: stage skipped entirely.
- 100: full RL output.
- 100–150: overdrive — an additional unsharp pass is applied on top of the RL output, weighted from 0 at amount=100 to ~0.5 at amount=150.

The 0–100 band is the principled range; the overdrive band is for users who specifically want an over-sharpened look.

`sharpenMasking` applies an edge mask (smoothed `CIEdges` on Apple, Sobel gradient magnitude on web) that attenuates the sharpening in low-gradient regions, so that a portrait's skin does not receive sharpening but the eyelashes do. `sharpenDetail` controls the strength of this attenuation.

RL is more expensive than unsharp mask — 12 convolution passes per render at viewport size (4 passes per iteration × 3 iterations) — but the scene-referred architecture makes it feasible on the interactive path: pre-AgX scene-linear data has enough dynamic range that RL's tendency to over-shoot at aliased edges is absorbed by AgX's shoulder, which was not the case in a display-referred pipeline.

Pre-ship calibration is required to lock the slider-to-mix-weight curve, the edge-mask attenuation parameters at each `sharpenMasking` value, and per-iteration tuning against a reference scene set that covers the failure modes RL is prone to: aliased edges (chain-link, brick, distant power lines), low-contrast detail (foliage, fabric, sand), portrait skin, bokeh boundaries, and specular highlights.

### 4.10 Bradford chromatic adaptation

Bradford is the chromatic adaptation transform used inside the DCP pipeline and at the ProPhoto D50 → Rec.2020 D65 exit. Given a 3×3 Bradford matrix `M_B` (published constants from Lam 1985) and source/destination white points `W_s`, `W_d` in XYZ:

```
LMS_s = M_B · W_s
LMS_d = M_B · W_d
D = diag(LMS_d / LMS_s)      // 3x3 diagonal scale
M_adapt = M_B⁻¹ · D · M_B
XYZ_adapted = M_adapt · XYZ_input
```

In Maple's pipeline, Bradford never computes per-pixel at runtime. It is folded into compile-time constant matrices: the DCP exit matrix `M_pro_to_rec2020` already contains the D50 → D65 adaptation baked in, and the display-gamut matrices (Rec.2020 → sRGB, Rec.2020 → P3) are D65-to-D65 (no chromatic adaptation required). The cost is one matrix multiply per pixel per stage, not a full Bradford computation.

-----

## 5. Cross-Platform Parity

A pipeline that produces different pixels on different platforms for the same input is, operationally, three different editors pretending to be one. Maple's cross-platform strategy is organized around three parity invariants enforced by automated gates.

### 5.1 Three invariants

1. **Sidecar parity.** An `.xmp` written by any platform parses cleanly on any other; a byte-for-byte round trip is a hard test.
1. **Pixel parity.** The same `AdjustmentModel` on the same input RAW produces pixels within ΔE₀₀ ≤ 1 target (≤ 3 tolerance) on every platform.
1. **UX parity.** Slider behavior, keyboard shortcuts, zoom semantics, panel layout — shared concepts, platform-native execution.

Notably absent: code parity. The Rust core is shared; the pipeline implementations are deliberately idiomatic on each platform (Metal on Apple, GLSL on web). Sharing *behavior* is what matters; sharing *source* above the Rust line would force lowest-common-denominator choices that fit none of the platforms well.

### 5.2 Constant derivation

Every matrix and LUT that appears on all three platforms (Rust reference, Metal, GLSL) is generated by a single Python derivation script. The script writes:

- Rust source as `pub const` arrays.
- Swift source as `let` constants.
- TypeScript source as `export const` constants.

A golden-file CI test confirms all three outputs agree. When a matrix changes, the derivation script is the single source of truth; individual platform ports cannot drift.

### 5.3 AgX parity gate

AgX is the stage most sensitive to coefficient drift. A 1% error in a sigmoid coefficient in the midtone region produces visible hue shifts on saturated highlights that users notice. The parity gate:

- A 256×256 synthetic test image covers the scene domain from `MID_GRAY · 2^MIN_EV` ≈ 0.00018 to `MID_GRAY · 2^MAX_EV` ≈ 16.3.
- The Rust reference implementation (CPU, deterministic, floating-point-exact) renders the expected output.
- The Metal kernel on Apple renders the same image; the GLSL shader on the web renders the same image. Both are read back and compared pixel-by-pixel with the Rust reference.
- Tolerance: max absolute error ≤ 1×10⁻⁴ per channel.

The tolerance is set tight enough that the gate fires in the sigmoid's steep midtone region on even sub-1% coefficient drift. A pre-ship verification perturbs a single coefficient by 1% in Rust and confirms both Apple and Web parity tests fail — if they don't, the tolerance is tightened to 10⁻⁵ and the verification is re-run. This is a one-time sanity check, not a recurring CI loop.

### 5.4 Sidecar parity gate

The XMP sidecar is where cross-platform correctness is most visible to the user. A sidecar written by an iPad and read on a Mac must produce the same `AdjustmentModel`; a Lightroom sidecar with masks, history, and snapshots must round-trip through Maple with every byte preserved in the passthrough fields.

The gate runs on every change to the XMP parser, serializer, or `AdjustmentModel`:

1. **Swift self round-trip:** serialize → parse → assert `AdjustmentModel` equality.
1. **TS self round-trip:** same, in TypeScript.
1. **Cross round-trip:** Swift serialize → TS parse → TS serialize → Swift parse → assert equality; also compare serialized bytes.
1. **Fixture round-trip:** parse a real sidecar, re-emit, byte-compare against the original (modulo whitespace normalization for known elements; passthrough nodes must be exact).
1. **Lightroom survival:** a Lightroom sidecar with 10 `crs:MaskGroupBasedCorrections` entries — write → parse → write must preserve every byte.

### 5.5 Reference render gate (ACR golden dataset)

The ACR (Adobe Camera Raw) reference dataset is the spine of Maple's correctness testing. The dataset:

- **4 RAWs** — Hasselblad 100MP DNG, a mid-range DNG, a standard DNG, a Canon CR2.
- **43 cases per RAW** — ACR-rendered outputs for one slider at one endpoint per case (exposure min/max, contrast min/max, WB presets, clarity, texture, dehaze, vibrance, saturation, sharpening amount/radius/detail/masking, NR luminance/color), plus a baseline at ACR defaults.
- **Two tiers** — "down" at 4000px long-edge for spatially-invariant cases (tone, color), "full" at native resolution for spatial-frequency cases (sharpening, NR).
- **176 rendered PNG references** total, at sRGB IEC61966-2.1 8-bit, with matching `crs:`-namespaced XMP sidecars.

Maple's harness renders each case through its own pipeline and diffs the result against the ACR PNG using **CIEDE2000** (ΔE₀₀), the perceptual color-difference metric. CIEDE2000 is chosen over pixel-RMSE because a small numerical drift in a tone curve is invisible — what matters is whether the displacement is perceptually detectable.

Budgets are case-class dependent (baseline starts at ΔE₀₀ ≤ 10 initial, ≤ 2 target; exposure/contrast at ≤ 15 initial, ≤ 3 target; sharpening at ≤ 20 initial, ≤ 5 target) and ratchet downward over time. CI rejects a PR that raises any budget; budgets move only downward, by explicit commit.

### 5.6 Dual-path validation

Preview and export share the adjustment model but take different paths through the pipeline: preview at 25% zoom runs the downsampled-image path; export at 100% runs the tiled full-resolution path. A tile-boundary bug or preview-specific shortcut that diverges from export would be invisible if each were only tested against the ACR reference. The dual-path check fills the gap: for a rotating subset of cases, render the preview at max quality and the export at max quality, then compare them to each other to a tight internal budget (initial ΔE₀₀ ≤ 1.0, target exact). Catches divergences before either side drifts.

### 5.7 Deliberate asymmetries

Not every feature works identically on every platform in v1:

|Feature              |iPad                                |Web                             |Reason                                                      |
|---------------------|------------------------------------|--------------------------------|------------------------------------------------------------|
|Noise reduction      |`CINoiseReduction` (non-local means)|Scene-linear bilateral (minimal)|NLM on web in v1.x; web v1 ships a simpler shader.          |
|High-quality demosaic|Export only                         |Export only                     |Same on both.                                               |
|X-Trans (Fuji)       |Fallback to `CIRAWFilter`           |Not supported                   |rawler's X-Trans is weak; web has no CIRAWFilter equivalent.|
|SMB source           |Yes (AMSMB2)                        |No                              |No SMB client in browsers.                                  |
|Apple Photos source  |Yes (PhotoKit)                      |No                              |No PhotoKit in browsers.                                    |

These are documented as known-scope-limitations, not bugs. Each has a v1.x or v2 plan.

-----

## 6. Performance Engineering

The performance story is organized around a single target: **slider response below one 60Hz frame** (16ms target, 50ms hard limit) on the interactive path, with no exceptions for image size up to 100MP on supported devices.

### 6.1 Two-phase rendering

A slider move triggers two renders in sequence:

**Fast phase.** Render only the viewport rectangle at screen resolution. Core Image is asked for its default "good enough" quality — no hints to upscale precision. Cancellable: if a new slider value arrives while this render is in flight, the in-flight render is discarded. Target 25–33ms.

**Refine phase.** 150ms after the last slider change, render the full image at full resolution with best-quality filter settings. Debounced so that a user still dragging doesn't waste GPU work.

**Coalescing.** If two slider changes arrive while a fast render is running, the first change is rendering; the second sets a "pending refresh" flag. When the fast render completes, it immediately starts another fast render with the latest model. No queue, no batching — just cancel-and-restart.

The result: the user sees instant response on every tick of the slider, and the full-resolution image "crystallizes" 300ms after they stop dragging.

### 6.2 The five caches

Maple operates five distinct caches, each serving a different layer:

1. **ThumbnailMemoryCache** (NSCache, app-scoped in-memory). Source: grid cells. Key: `(asset.id, size)`. Invalidation: on edit session teardown (via a per-asset tick counter that `ThumbnailCell` observes).
1. **ThumbnailDiskCache** (`{folder}/.maple/thumbs/{sha256}.jpg`). Persistent JPEG, sRGB quality 80, max 500×500. Pruned on a 30-day LRU sweep.
1. **RenderedPreviewCache** (`~/Library/Caches/MapleMaple/rendered/{hash}.jpg`). The bytes the user last saw in the editor, encoded as opaque JPEG at screen-native resolution, Display P3. Key: `hash(primaryURL, primaryMtime, sidecarMtime, screenSize, adjustmentVersion, viewTransformVersion)`. The `viewTransformVersion` component means that replacing AgX with OpenDRT in a future version invalidates every preview at once — by design.
1. **DecodedCIImage** (in-memory, session-scoped). The post-decode scene-linear Rec.2020 f32 buffer. Never persisted. Single slot per `EditSession`. Lifetime: from session construction to `endEditing`.
1. **SMBFileData** (`~/Library/Caches/MapleMaple/smb/{hostname}/{path}`). Cached RAW bytes from SMB shares, keyed by SMB path + remote mtime. SMB is slow; re-fetching on every image open would be unusable.

The **RenderedPreviewCache** is the user-visible payoff. On a cold image open:

- **Without the cache:** ~250–1000ms (RAW parse 50–300ms + demosaic 100–500ms + GPU upload 50ms + first render 30ms). The user sees "image is loading."
- **With the cache hit:** ~35ms (read 200KB JPEG + decode + display). Within one frame. The image snaps open.

### 6.3 Memory budgets and tiling

Scene-linear f32 doubles the working-texture memory footprint vs display-referred f16. A 25MP RGBA f32 image is ~400MB.

|Device class             |Strategy                                                                                              |
|-------------------------|------------------------------------------------------------------------------------------------------|
|Mac (any M-series)       |No tiling up to 50MP. Tile above that.                                                                |
|iPad Pro (M-series)      |No tiling up to ~38MP. Half-res quad demosaic on > 40MP to avoid tiling entirely.                     |
|iPad Air 4 / mini 6 (A14)|Tile anything > 20MP. Force half-res quad demosaic.                                                   |
|iPhone                   |Half-res quad demosaic everywhere. Tile above 15MP.                                                   |
|Export, any platform     |Tile when output > 50MP. Tile size 2048×2048 with 32–64px overlap for filters with neighborhood reach.|

The tile planner lives in the Rust core and is the same machinery used by the planned panorama stitcher. Each tile carries its own rayon-parallel demosaic and its own GPU upload; tiles are processed sequentially (not concurrently) to cap peak GPU memory.

### 6.4 Threading model (Apple)

|Component                |Isolation            |Notes                                                             |
|-------------------------|---------------------|------------------------------------------------------------------|
|`EditSession`            |`@MainActor`         |State mutations on main. RAW decode offloaded via `Task.detached`.|
|`UnifiedLibraryViewModel`|`@MainActor`         |Generation counter guards async loads against stale results.      |
|`ThumbnailLoader`        |`actor`              |6 concurrent slots via checked-continuation waiters.              |
|`XMPSidecarStore`        |`actor`              |Serialized sidecar read/write.                                    |
|`ImageEditPipeline`      |`@unchecked Sendable`|`CIContext` is thread-safe; `CIImage` is immutable.               |

The rule: state the UI observes lives on `@MainActor`; work that doesn't (decoding, parsing, thumbnailing) runs on detached tasks or actors.

### 6.5 Detailed slider-tick timing

For a 25MP image on an M-series Mac, a single slider change in the fast phase:

|Step                                             |Budget   |
|-------------------------------------------------|---------|
|SwiftUI slider → binding update                  |< 1ms    |
|`EditSession.model.field = value`                |< 1ms    |
|`ImageEditPipeline.apply` — CIFilter reassembly  |< 2ms    |
|`CIContext.startTask(toRender:)` submit          |< 2ms    |
|GPU render (M3 Max, f32 scene-linear + AgX, 25MP)|~14ms    |
|`CIRenderDestination` → `MTLTexture` present     |< 3ms    |
|SwiftUI invalidate + redraw                      |< 5ms    |
|**Total**                                        |**~29ms**|

This is inside the 33ms frame budget for 60Hz. On a 120Hz iPad Pro (8ms budget), the fast path is already over budget for scene-referred f32 — viewport-clipping and half-res quad demosaic on large images carry the budget, and the refine pass handles the full-resolution step.

-----

## 7. Testing and Validation

Every change to the Rust core is gated by a multi-layer test harness. Pipeline changes that pass the gates are mergeable; changes that fail are not. Screenshot eyeballing does not count as evidence a change is correct.

### 7.1 Gate layers

1. **Byte-identical baseline.** For each RAW, the CPU-backend render of the `baseline` case at both tiers must be byte-identical to a checked-in expected PNG. Catches accidental non-determinism (random seeds, timestamp leakage, parallel reduction-order drift).
1. **Perceptual matrix.** The full 176-case ACR matrix rendered through Maple, diffed against ACR references with case-specific ΔE₀₀ budgets. Runs on every PR that touches the core.
1. **Dual-path agreement.** For a rotating subset of cases (all nightly, 10 per PR), the preview and export paths are rendered at max quality and compared to each other under the tight internal budget (ΔE₀₀ ≤ 1.0 initially, targeting exact).
1. **Backend parity.** The CPU reference render is compared against the Metal and WebGPU backend renders. Platform tolerances are documented per-platform; any tolerance wider than ΔE₀₀ ≤ 1.0 requires a written justification.
1. **EXR round-trip.** A known scene is rendered to EXR, opened in Blender's compositor (headless, scriptable), re-exported with no modifications, re-imported into Maple's pipeline. Pixel parity asserted to 1×10⁻⁴ linear. Catches encoder metadata mistakes — wrong chromaticities, wrong `displayWindow`, off-by-one channel layout — that silently produce wrong files.
1. **Richardson-Lucy calibration.** Pre-ship gate (not CI). A reference scene set covers RL's known failure modes. The pass produces the slider→mix-weight curve, the edge-mask attenuation parameters at each `sharpenMasking` value, and any per-path iter-count adjustment. Cannot ship without this calibration locked.
1. **Vibrance hue-window calibration.** Pre-ship gate followed by permanent CI gate against a 30-portrait set.

### 7.2 Metrics

`src/scripts/compare_images.py` is the authoritative perceptual metric. Per comparison it reports:

- **Mean ΔE₀₀** — primary perceptual metric. The budget is applied here.
- **P95 and max ΔE₀₀** — catches localized failures that mean would average out (clipped highlights in one corner, a tile seam).
- **Per-channel bias** — signed R/G/B mean deltas. Non-zero bias in any channel typically indicates a WB or gamma bug.

A case passes only when mean, P95, and per-channel bias are all under budget.

### 7.3 The CLI harness

The Rust core ships with a command-line binary that is the primary development tool. Its contract:

- **Deterministic.** Same RAW + same params → byte-identical PNG, across machines and across WASM/Swift-FFI/native builds.
- **Headless.** No window, no GL/Metal context owned by a UI framework. Opens its own compute device.
- **Fast feedback.** One case in seconds, the full 176-case ACR matrix in minutes.
- **Single source of truth.** The CLI is the reference renderer; web (WASM) and iOS (Swift) are thin shells around the same core.

Usage mirrors the ACR reference generation workflow: `maple-cli batch manifest.json --out-dir candidates/` consumes the same manifest that `acr_batch.jsx` consumes to render the ACR references, and `compare_images.py` diffs the two outputs. A single manifest, two renderers, directly comparable.

-----

## 8. Export Path

Export is a distinct code path from preview rendering. It never uses the rendered-preview cache (wrong resolution, wrong color treatment) and does not share intermediate textures with the interactive pipeline.

### 8.1 Format classes

Maple's export formats split into two classes:

**Display-referred formats** (JPEG, HEIC, PNG, TIFF-display). The AgX view transform is applied, followed by display-gamut conversion (to sRGB or Display P3) and the target's transfer curve. Output is in a standard display space, typically 8- or 10-bit.

**Scene-linear formats** (TIFF-scene, EXR). AgX and display encode are **skipped**. The output is linear Rec.2020 D65 at 16-bit half-float or 32-bit float, preserving the full scene-referred state for handoff to another scene-referred tool (VFX compositing, HDR grading).

The two TIFF modes are not interchangeable. A 16-bit display-referred TIFF in Display P3 is the traditional "send to Photoshop" format; a 16-bit scene-linear TIFF in Rec.2020 preserves highlight headroom and the scene-referred state for downstream view-transform application. Users who need one cannot substitute the other.

### 8.2 EXR encoder

The EXR encoder is the Rust `exr` crate, compiled to both the Apple FFI and the WASM bundle — a single source of truth gives automatic numerical parity across platforms. Defaults:

- `half` (f16) channels by default, `float` (f32) as alternate for precision-critical handoff.
- PIZ compression (lossless, wavelet, optimized for photographic content). ZIP alternate for synthetic content.
- Rec.2020 primaries + D65 chromaticities header set.
- `displayWindow` and `dataWindow` identical and equal to image bounds.
- Channels in `R, G, B` order.
- No lossy options (B44, DWAA) are exposed — anyone reaching for EXR wants full precision.

A Blender round-trip CI gate validates encoder correctness.

### 8.3 Export pipeline

```
1. Load sidecar → AdjustmentModel.
2. Decode RAW at full resolution (export-quality demosaic if compiled with the feature).
3. Apply stages 1–11 (scene-linear chain) at full resolution in Linear Rec.2020 D65, f32, tiling if > 50MP.
4. Branch on format class:
     Display-referred: apply AgX (stage 12) → target gamut (stage 13) → transfer (stage 14).
     Scene-linear:     skip stages 12–14. Write linear Rec.2020 D65 values directly.
5. Resize to longEdge target.
     Scene-linear: box-filtered in scene-linear space (preserves radiometry).
     Display-referred: after AgX, before gamut/transfer encode (avoids ringing around clipped highlights).
6. Encode (libjpeg-turbo / HEIF / CGImageDestination / OpenEXR).
7. Copy or strip metadata per config.
8. Write to user destination.
```

The scene-linear variant skips stages 12–14 at step 4. This is the architectural payoff: scene-referred export is cheap (the view transform and gamut encode don't run) and lossless in the radiometric sense.

-----

## 9. Discussion and Future Work

### 9.1 Why scene-referred over a conservative display-referred v1

The original plan was to ship a display-referred v1 "for feel-parity with Lightroom" and migrate to scene-referred in v2. That plan was re-evaluated against three considerations:

1. The scene-referred redesign was already on the v2 roadmap, so the work would be done eventually.
1. A display-referred v1 would generate sidecars and thumbnails that would all be invalidated by the v2 migration. The cached rendered-preview files and the authored curves would need a mechanical invalidation sweep.
1. The slider recalibration pass (one person-week against reference scenes) is the only "feel" cost that doesn't amortize, and it's small enough to absorb in v1.

Running the v2 plan as v1 folds the costs together and means every user's first edit is on the architecture Maple will ship with long-term.

### 9.2 Replaceable view transform

AgX is a reasonable view transform for photography in 2025–2026. It is unlikely to be the last word. OpenDRT, ACES 2.0, and in-house transforms are all active research.

Maple's view-transform stage is shaped as a clean interface (scene-linear wide-gamut in, display-linear target-gamut out) specifically so that a future migration to OpenDRT or something custom does not require rewriting the rest of the chain. The sidecar carries a `papp:ViewTransformVersion` string (e.g., `"agx-1"`) and the rendered-preview cache keys on this version, so that a view-transform swap bulk-invalidates every cached preview at once — the intended behavior.

Users do not pick the view transform. The stage is a *replaceable* architectural seam, not a *pluggable* user-facing choice.

### 9.3 Collaboration and multi-writer

v1's concurrency strategy is **last-writer-wins** with mtime monitoring. If the sidecar changes on disk while a session is open, the UI offers "Keep my changes" or "Reload from disk." Two clients editing the same sidecar simultaneously produce one winner; the loser's edits are discarded.

Proper multi-writer merge — CRDT or operational transforms over the `AdjustmentModel` — is out of scope. The XMP format has no conflict-resolution facility, and the design space for "what does it mean to merge two conflicting contrast sliders?" is not settled.

### 9.4 HDR delivery

Rec.2020 D65 linear is the canonical input for both PQ (Perceptual Quantizer, Rec.2100) and HLG (Hybrid Log-Gamma, Rec.2100) HDR transfer curves. A future HDR export path substitutes the gamma-encode stage (14) with a PQ or HLG encode and raises the display-encode bit depth to 10 or 12 bits; no other pipeline changes are required. The scene-referred working space already contains the headroom.

### 9.5 Panorama, masking, faces

Panorama stitching is designed but not implemented in v1 — the Rust tile planner is already in the core, the feature-detection algorithms (VNDetectImageAlignmentRequest on Apple, ORB/BRISK via `imageproc` as a portable fallback), the bundle adjustment, and the Burt-Adelson multi-band blending are all tractable from published papers. The work is implementation, not research.

Local adjustments (masking) are planned for Phase 4. The `passthroughNodes` bucket in the data model already preserves Lightroom's `crs:MaskGroupBasedCorrections` verbatim, so that Lightroom-authored masks survive a Maple edit cycle unchanged even before Maple interprets them.

Face detection, auto-tagging, and other DAM features are deliberate non-goals for v1.

-----

## 10. Conclusion

Maple's design is an argument that three things belong together in a modern non-destructive RAW editor:

1. **A scene-referred working space with a distinct view transform.** Because scene-linear radiometric data is what the camera actually measured, and because compressing it into display range is an opinionated operation that deserves its own stage.
1. **A shared portable core with platform-native interactive pipelines.** Because image science is too sensitive to ship twice, and platform GPU APIs are too well-tuned to abstract over.
1. **Adobe-compatible persistence.** Because the `crs:` namespace is a working standard with millions of authored files, and "non-destructive" is not non-destructive if the user's work doesn't round-trip.

Each decision has costs that are visible in the implementation — f32 texture memory, the FFI plumbing, the byte-canonical XMP serializer — and each is defensible only because the alternatives are worse. What the architecture gains in exchange is that an edit authored on an iPad over SMB is pixel-identical to the same edit authored on the web client; that a neon sign compresses naturally into display gamut rather than clipping to a two-tone bar; that a Lightroom user can open a Maple-edited folder and see the edits; that three years from today, replacing AgX with something better is a single stage swap rather than a rewrite.

The engineering that keeps this interactive on a 100MP RAW on a 2018 iPad — five-layer caching, two-phase rendering, scene-linear tiling, lazy CIFilter graph composition — is the part that doesn't make headlines but is what distinguishes a shippable product from an interesting research demo.

-----

## Appendix A: Reading Order for Implementers

The specs from which this paper is derived are organized for a second engineer to produce a functionally equivalent rewrite. The recommended reading order:

1. `00-overview.md` — philosophy and lineage.
1. `01-data-model.md` — the `AdjustmentModel`, `ImageAsset`, `EditSession`, and XMP invariants.
1. `08-io.md` — sidecar strategy, source adapters, export.
1. `02-pipeline.md` — end-to-end trace from double-click to pixels.
1. `04-color-management.md` — stage-by-stage reference state.
1. `03-algorithms.md` — the mathematics of each pipeline stage.
1. `05-performance.md` — caches, tiling, two-phase rendering.
1. `06-cross-platform.md` — FFI, parity gates, deliberate asymmetries.
1. `07-ui-architecture.md` — state ownership, interaction loops, undo/redo.
1. `10-cli.md` — the development inner loop.
1. `11-testing.md` — golden datasets and perceptual metrics.
1. `09-open-questions.md` — what is genuinely unresolved.

The sidecar format and the adjustment model are the contracts every platform observes; getting those stable is the highest-leverage starting point.

## Appendix B: Glossary

|Term                   |Definition                                                                                                                                                                      |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|**Scene-referred**     |A working space where values are proportional to scene radiance. Middle gray is 0.18, diffuse white is 1.0, values above 1.0 are physically meaningful (specular, bright sky).  |
|**Display-referred**   |A working space where values represent display output in [0, 1]. Values above 1.0 are not allowed; values below 0 are typically clamped.                                        |
|**View transform**     |A pipeline stage that maps scene-referred values to display-referred values. Performs tone compression and gamut management in one opinionated step.                            |
|**AgX**                |A view transform (Sobotka 2020, upstreamed as Blender 4.0's default) that encodes scene values per-channel in log space, normalizes, and applies a sigmoid.                     |
|**DCP**                |DNG Camera Profile. Adobe's open format for per-camera-body color calibration, containing up to two illuminant-specific color matrices, forward matrices, and HSV offset tables.|
|**Bradford adaptation**|A chromatic adaptation transform that maps XYZ values from one white point to another. Used inside DCP and display-gamut conversion.                                            |
|**Oklab**              |A perceptually uniform color space (Ottosson 2020). Euclidean distances in `(a, b)` correspond to roughly equal perceptual color differences. Used for vibrance and saturation. |
|**ΔE₀₀ (CIEDE2000)**   |A perceptual color-difference metric. Values below 1.0 are below typical discrimination threshold; values above 3.0 are visible.                                                |
|**PSF**                |Point-spread function. The 2D impulse response of an optical system. Capture sharpening approximates the inverse of the PSF.                                                    |
|**Richardson-Lucy**    |An iterative deconvolution algorithm (Richardson 1972; Lucy 1974) that recovers detail blurred by a known PSF.                                                                  |
|**XMP**                |Adobe's Extensible Metadata Platform. Sidecar files in `.xmp` format using `crs:`, `xmp:`, and custom namespaces.                                                               |
|**PV11 / PV2012**      |Lightroom Process Versions. PV2012 (Adobe's 2012 introduction) uses the `Exposure2012`, `Highlights2012`, etc. slider set. PV11 is the 2022 extension.                          |
|**CFA**                |Color Filter Array. The pattern of color filters on a Bayer sensor (RGGB, GRBG, GBRG, BGGR) or Fuji's X-Trans 6×6 pattern.                                                      |
