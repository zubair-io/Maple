# Auto Profile + Auto Setting — design spec

Status: draft
Owner: zubair
Date: 2026-05-26
Supersedes: `2026-05-26-auto-tone-and-looks-design.md` (the empirical-LUT approach hit a structural wall — see § Why this design)
Builds on: `main` HEAD `0394ecbc` (post-#L2.5 banding fix + post-#A2 Auto Setting FFI).

## Summary

Two distinct controls that together position Maple as a Lightroom alternative:

1. **Auto Profile** (`papp:Profile = "Auto"`) — the new default. A **per-image** tone curve fit by CDF-matching Maple's linear render to the **embedded JPEG preview** that every modern RAW carries. Applied in linear scene-referred space, *replacing* AgX in Auto mode. Falls back to AgX-neutral when no usable JPEG is available.
2. **Auto Setting** — a one-shot button in the Develop panel's Tone section (already shipped in PR #524). Analyses the image's histogram and writes the six tone slider values. Sliders visibly move; user can edit any of them afterward.

These compose: Auto Profile gives a finished-looking baseline that matches the camera manufacturer's intent; Auto Setting gives a sensible starting edit. Both run on the same RAW with no conflict.

The static "Maple Look" empirical LUT from the previous spec is retired entirely — see § Why this design.

## Product position

Maple-as-Lightroom-alternative. First-open RAW renders with a finished, camera-intended look that matches what photographers see on their camera's LCD and what ACR/Lightroom produce by default. User can flip to "Neutral" for scene-referred AgX output. Auto Setting gives a one-click sensible starting edit on either profile.

## Why this design

### What we tried

The previous spec proposed reviving the pre-#443 empirical 1D LUT as a static "Maple Look", refitting it via robust median-binning across all 17 reference fixtures, then layering a 3×3 matrix stage on top for cross-channel grading.

### What broke

Per-luma-band residual analysis on the median-fit LUT (residuals in `~/Desktop/maple-color-tests/L2.7-perpixel-20260526-194635/`) showed the methodology is structurally flawed:

- **The R channel drops faster than G or B at every luma band**, on every fixture. Median-across-fixtures introduces this asymmetry because warm-toned fixtures dominate the dataset.
- **Result: a systemic green cast** in midtones and highlights on every photo.
- The cast cannot be fixed by curve shape adjustment (it's a cross-channel asymmetry, not a per-channel error). A 3×3 matrix can compensate, but at that point we're adding a second model layer to fix the first.
- Aggregate ΔE numbers improved (grand mean 18.64 → 10.34) but the per-luma-band data showed every fixture had a structured per-channel bias the average hid.

### What we learned from RawTherapee

A read-only review of `rtengine/` ([report](#)) found RT's "Auto-Matched Tone Curve" (code: `histmatching.cc:232`, `getAutoMatchedToneCurve`): it reads the **embedded JPEG preview**, computes the CDF of its luma distribution, fits a spline that maps Maple's linear render's CDF to the JPEG's, and applies it as a tone curve in linear scene space. ACR almost certainly does the same — the camera-baked JPEG encodes the manufacturer's intended look, and that's what photographers know.

The pre-#443 empirical LUT was an attempt to retrofit "what ACR does on average" without using the per-image signal that drives it. The right answer is to use the JPEG that's already inside every RAW.

## What's in main (relevant context)

Wave 3 of #416 closed. Plus the L1–L5 + L2.5 + A1–A2 work from the previous spec:

- **L1 (#508, merged)** — `view/look.rs` + `view/look_lut.rs` resurrected. Will be retired again at the end of this spec's work.
- **L2 (#514, merged)** — `look::apply` re-wired into CPU/CLI render path. Will be retired.
- **L3 (#517, merged)** — `look_mode` field on `MapleAdjustmentParams` + `maple_compute_look_lut` FFI. Will be repurposed as `papp:Profile` plumbing.
- **L2.5 (#527, merged)** — Look LUT moved to f32 pre-quantize space with linear interpolation, between `srgb_gamma_encode` and `dither_and_quantize`. **This is the right architectural location for any per-image curve**, including Auto Profile.
- **A1 (#510, merged)** — `stages/auto_tone.rs` exposure-only histogram inversion.
- **A2 (#524, merged)** — `maple_compute_auto_tone` FFI + WASM + `maple-cli auto-tone` subcommand. Auto Setting is shippable.
- **KTLO #525 (#526, merged)** — `maple-cli/src/main.rs` split into per-command modules.

**Retired by this spec:**

- Static "Maple Look" empirical LUT path. `view/look.rs` + `view/look_lut.rs` will return to the no-op state they had post-#443.
- `papp:Look` XMP attribute deprecated (kept for back-compat; readers map old values to new `papp:Profile` values).
- L2.7 (PR #528) — closed superseded.
- L2.8 (#523) — closed superseded.

## Architecture

### Pipeline placement

Auto Profile **replaces AgX** when active. AgX is the Neutral mode's view transform. Both are mutually exclusive view transforms.

```
[INPUT] RAW
   ├─ decode → linearize → crop → demosaic
   ├─ wb_pre_gain → DCP colorimetry (ColorMatrix + ForwardMatrix + ProfileGainTable)
   ├─ highlight_recovery (Oklab chroma-reduce)
   ├─ auto_exposure (hybrid mid-gray + p95 — already in main)
   ├─ white_balance (CAT16)
   ├─ scene_tone_controls        ← Auto Setting writes these slider values
   │   (exposure, contrast, highlights, shadows, whites, blacks)
   ├─ tone_curves → vibrance → saturation → clarity → texture → dehaze
   ├─ local_adjustments → sharpen → nr_luminance → nr_color
   ├─ [VIEW TRANSFORM] — branches on papp:Profile
   │      ┌─ Profile::Auto    → profile::apply_auto(linear_scene, jpeg_curve)
   │      │                       per-channel monotone-spline tone curve
   │      │                       fit from embedded JPEG (see § algorithm)
   │      └─ Profile::Neutral → agx::apply (current AgX sigmoid)
   ├─ rec2020_to_srgb gamut compress (always; post-L2.5)
   ├─ srgb_gamma_encode (f32)
   ├─ dither_and_quantize (Bayer dither + u8)
[OUTPUT] 8-bit sRGB
```

### Auto Profile algorithm

`raw-core/src/view/auto_profile.rs` (new):

1. **Extract embedded JPEG** from the RAW (rawler exposes this; falls back to libraw via FFI if rawler doesn't have it for a given format).
2. **Decode JPEG** → 8-bit sRGB → linearize via inverse sRGB OETF → convert to linear Rec.2020 via the standard 3×3 matrix. Result: target distribution `J_lin_rec2020`.
3. **Compute source**: take Maple's post-develop linear Rec.2020 buffer at the same logical resolution as the JPEG (downsample with box filter if Maple's buffer is larger; the JPEG preview is usually a few MP).
4. **Build per-channel CDFs** (4096-bin) of both source and target, in linear Rec.2020 space.
5. **Fit a monotone spline** per channel mapping source-CDF-quantile → target-value. Use the same monotone-binned-median approach `fit_curves.py` uses, but applied per-image, not aggregated across fixtures.
6. **Apply the spline** to the full-resolution Maple buffer (same domain — linear Rec.2020) **in place of `agx::apply`**.

Curve representation: per-channel monotone cubic spline with ~32 anchor points. Anchors evenly distributed in linear input space. Cheap to evaluate; cheap to serialize across FFI.

Fallback: if JPEG extraction fails OR decoded JPEG is smaller than 256×256 OR JPEG histogram is degenerate (>99% of pixels in one bin) → silently fall back to `agx::apply` (the Neutral path). User sees no error; UI badge optional later.

### Component responsibilities

**`raw-core/src/view/auto_profile.rs`** (new):
- `extract_jpeg_preview(raw: &RawImage) -> Option<image::DynamicImage>`
- `fit_curve_from_jpeg(source: &Image, jpeg: &image::DynamicImage) -> ProfileCurve` — returns three per-channel monotone splines plus a fallback-needed flag
- `apply_curve(buf: &mut [f32], curve: &ProfileCurve)` — applies the spline to a linear Rec.2020 f32 buffer in place

**`raw-core/src/view/mod.rs`**:
- Adds `pub mod auto_profile;`
- View-transform dispatcher: `match model.profile { Auto => auto_profile::apply(...), Neutral => agx::apply(...) }`

**`raw-core/src/types/adjustment/mod.rs`**:
- New enum `Profile { Auto, Neutral }`, default = `Auto`
- New field `pub profile: Profile` on `AdjustmentModel`
- `pub use view::auto_profile::Profile;` re-export

**Cross-platform curve generation lives in raw-core only.** GPU paths sample the per-channel curves Apple/Web hosts receive via the FFI.

### FFI / WASM surface

```c
// Per-image profile curve — Apple/Web hosts call once per RAW open; GPU
// pipelines sample the resulting per-channel splines.
//
// Curve format: 32 monotone-spline anchors per channel, stored as
// pairs of (input, output) f32s in linear Rec.2020 space.
typedef struct {
    float anchors_r[32 * 2];   // (in, out) pairs
    float anchors_g[32 * 2];
    float anchors_b[32 * 2];
    uint8_t valid;             // 0 = fallback to Neutral; 1 = curve usable
} MapleProfileCurve;

int32_t maple_compute_auto_profile_curve(
    const RawImageHandle* raw,
    MapleProfileCurve* out
);
```

`MapleAdjustmentParams.look_mode` (added in #L3) is repurposed as `profile_mode`:
- `0 = Neutral` (renamed from `Neutral`)
- `1 = Auto` (renamed from `Default`)

The FFI byte format is unchanged — only the semantic name shifts. Existing host code that sets `look_mode = 1` (= old `Default`) continues to produce the "default look" — which is now Auto Profile, the right behavior.

`maple_compute_look_lut` from #L3 stays callable (returns identity for `look_mode = 0`, the empirical LUT bytes for `look_mode = 1`) but its consumers (Apple Metal, Web WebGL) will eventually migrate to `maple_compute_auto_profile_curve` and stop sampling the static LUT.

`maple_compute_auto_tone` (shipped in #A2) is unchanged.

### XMP changes

`papp:Look` is deprecated. Replaced by `papp:Profile`:

| XMP value | Meaning | UI label |
|---|---|---|
| `"Auto"` (or omitted) | Auto Profile = per-image JPEG-matched curve | **Auto** |
| `"Neutral"` | Scene-referred AgX | **Neutral** |

Migration: when reading a sidecar:
- `papp:Look = "Default"` → `profile = Auto`
- `papp:Look = "Neutral"` → `profile = Neutral`
- `papp:Look = "Auto"` (from the previous spec, never shipped) → `profile = Auto`
- Both attributes present: `papp:Profile` wins.

Serializer writes only `papp:Profile`. Skip the attribute when value = `Auto` (default).

## UI surface

### 1. Profile dropdown (top of Develop tab)

Position: above the Tone section.
Bound to: `model.profile` (the new `Profile` enum field).
Options: `Auto`, `Neutral`.
Default: `Auto`.
Behavior: changing it triggers a re-render but does not move sliders.

Tooltip on Auto: *"Per-image curve matched to your camera's preview JPEG."*
Tooltip on Neutral: *"Scene-referred output. No look applied."*

Accessibility identifier: `develop-profile`.

### 2. Auto button (Tone section header) — unchanged

Already shipped in #A2 / #524. Behavior unchanged.

### Two distinct "Autos" — the user mental model

| | Auto Profile (dropdown) | Auto Setting button (Tone section) |
|---|---|---|
| Surface | Item in Profile dropdown | Button in Tone section header |
| What it changes | The view transform (curve regenerated per render) | Six slider values |
| Visible to user | Image looks finished | Sliders jump to new positions |
| When it runs | Every render (curve cached per RAW open) | Once, on click |
| Persisted as | `papp:Profile="Auto"` only | `crs:Exposure2012`, `crs:Contrast2012`, etc. |
| Mental model | "Match the camera's intent" | "Suggest a good starting edit" |

### Batch (Browse mode)

- "Apply Auto Setting to selection" — per-image analysis (each photo independently).
- "Set Profile = X" — uniform across selection.

## Phasing

### Phase 1 — Auto Profile in CPU/CLI (Rust core)

| Task | Effort |
|---|---|
| `view/auto_profile.rs`: JPEG extraction + CDF + spline fit + apply | medium-large |
| `Profile` enum + `AdjustmentModel.profile` field + `papp:Profile` XMP read/write | small |
| `pipeline/render/mod.rs`: dispatch `auto_profile::apply` vs `agx::apply` | small |
| Retire `view/look.rs` + `view/look_lut.rs` apply paths (back to no-op like post-#443) | small |
| Per-fixture parity harness: render fixture with `Profile = Auto`, diff against embedded JPEG (per-luma-band, not aggregate) | medium |

### Phase 2 — Apple Metal

| Task | Effort |
|---|---|
| FFI: `maple_compute_auto_profile_curve` writes `MapleProfileCurve` | small |
| Metal shader: sample per-channel 32-anchor monotone spline | medium |
| Apple host: call curve FFI once per RAW open, upload to GPU | small |

### Phase 3 — Web WebGL

| Task | Effort |
|---|---|
| WASM wrapper for `compute_auto_profile_curve` | small |
| WebGL2 fragment shader: sample per-channel spline | medium |
| Web host: call WASM once per RAW open, upload to GPU | small |

### Phase 4 — Profile dropdown UI

| Task | Effort |
|---|---|
| Web: `develop-profile` dropdown in `develop-tab.component` | small |
| Apple: `develop-profile` Picker at top of DetailPanel | small |
| XMP read/write `papp:Profile` in Swift + TS | small |

### Phase 5 — Auto Profile expansion (post-v1)

| Task | Notes |
|---|---|
| Embedded camera profiles | Adobe-style Camera Standard / Faithful / Portrait sourced from bundled DCPs |
| Designed Maple Look v2 | A hand-tuned curve as a third Profile option |

## Testing strategy

### Parity gates (CI)

- **Rust unit tests**: synthetic histograms (flat, bimodal, clipped); monotone-spline endpoint invariants; identity-when-source-equals-target.
- **Rust integration test**: render each fixture's embedded JPEG side-by-side with Maple's `Profile = Auto` output. Per-channel **per-luma-band bias** (not aggregate ΔE) must be within ±0.05 across the 0.10–0.90 luma range. Aggregate ΔE is a forbidden metric for this gate.
- **Cross-platform**: Rust ↔ FFI byte-equality on the `MapleProfileCurve` returned by `maple_compute_auto_profile_curve`.
- **Maple-CLI golden**: `maple-cli render <RAW>` with `Profile = Auto` reproduces a pinned per-channel curve hash for each fixture.

### What NOT to gate on

- **No aggregate ΔE / RMSE / MAE means.** Those metrics mask the structural per-channel and per-luma-band errors that broke the previous LUT approach. All harness reports must include per-luma-band bias tables.
- **No ACR-as-target.** The target is the embedded JPEG (the camera's intent). ACR is one downstream consumer; we don't tune to it.

### Unit tests

- `extract_jpeg_preview` against the 17 reference RAWs (16 success + 1 fallback for the Foveon stub).
- `fit_curve_from_jpeg` against synthetic source+target pairs with known answers.
- `apply_curve` monotonicity + endpoint preservation.

### Visual review gate

- Render every fixture with `Profile = Auto`. Save next to its embedded JPEG and the ACR reference. Manual side-by-side review (the user gate, not CI).
- Particular attention on the fixtures the median-LUT broke: test_0002 (Sigma calibration), test_0014 (Nikon foliage), test_0015 (dark scene). They should all match their embedded JPEG.

## Out of scope (v1)

- ML / Sensei-style learned profiles.
- Local / CLAHE adaptive contrast inside Auto Profile (global per-channel curve only).
- Custom / user-imported LUTs.
- Multiple bundled camera profiles (Camera Standard / Faithful / Portrait) — Phase 5.
- A designed "Maple Look" curve as a third Profile option — Phase 5.
- Auto WB (still separable, still its own ticket).

## Open questions

1. **JPEG extraction reliability** — rawler exposes embedded previews for most formats; need to audit which of our 17 fixtures actually carry a usable JPEG. Action: dispatch an exploration agent to run `rawler::get_thumbnail` (or equivalent) on each fixture and report pass/fail/size.
2. **Curve evaluation cost on GPU** — 32-anchor monotone splines can be evaluated as a small 1D texture lookup with linear interp + slope correction. Same cost as a 256-entry LUT. Defer optimization until profiled.
3. **Curve persistence across slider edits** — when the user moves a slider, the curve stays fixed (fit once on RAW open). Re-fit only on RAW reload or after a meaningful develop-stage change. Decision: fit once per `(raw_url, primary_mtime)` cache key; invalidate when the cache key changes. Aligned with the existing five-cache model in `docs/caching.md`.

## Issue breakdown (epic → tickets)

Phase 1 — Auto Profile in CPU/CLI:

- `core: view/auto_profile.rs JPEG extract + CDF + spline fit + apply`
- `core: Profile enum + AdjustmentModel.profile field + dispatch in pipeline/render`
- `xmp: papp:Profile read/write/round-trip (Rust)`
- `core: retire view/look.rs + view/look_lut.rs apply paths (back to no-op)`
- `harness: per-fixture Auto Profile vs embedded JPEG, per-luma-band gate`

Phase 2 — Apple Metal:

- `ffi: maple_compute_auto_profile_curve + MapleProfileCurve C struct`
- `apple: Metal shader sample monotone-spline curve`
- `apple: host plumbing to call FFI once per RAW open`

Phase 3 — Web WebGL:

- `wasm: compute_auto_profile_curve binding`
- `web: WebGL fragment shader sample spline`
- `web: host plumbing`

Phase 4 — Profile dropdown UI:

- `xmp: papp:Profile in Swift + TS serializers`
- `web: develop-profile dropdown component`
- `apple: develop-profile Picker in DetailPanel`

Phase 5 (deferred): designed Maple Look, multiple camera profiles, Auto WB.

Each PR closes its ticket. Each harness case lands with its per-luma-band budget in the same commit.
