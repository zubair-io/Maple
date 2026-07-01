# Local Inpainting — Phase 0: Inverse View-Transform + Grade Round-Trip Spike


**Goal:** Build, in raw-core with zero ML/Swift/UI, the inverse of the live grade + AgX view tail and prove via a headless round-trip harness that a synthetic patch composited at the pre-user-grade seam re-grades coherently under exposure/WB pushes (ΔE2000 stratified by tonal zone). This is the go/no-go gate for the whole feature (design doc §6).

**Architecture:** A new `view::agx_inverse` module reverses the display chain — `srgb_gamma⁻¹ → M_SRGB_TO_REC2020 → AgX⁻¹ (OUTSET·…inverse-sigmoid-LUT…INSET) → tone⁻¹ → exposure⁻¹ → WB-delta⁻¹` — landing display-referred pixels back in *pre-user-grade* scene-linear Rec.2020 (the cached-buffer color state, before `white_balance` at `scene_linear_chain.rs:146`). The inverse is exact for in-gamut midtones, clamped/bounded-error at the AgX toe/shoulder, and assumes in-gamut chroma (never reconstructs from the gamut wall). A `maple-cli` harness forward-renders a synthetic patch through the bake-preview path (`WB → exposure → tone → AgX`, creative/spatial stages off), quantizes to 8-bit, inverts, composites at the seam, re-renders under ±EV/±temp, and diffs the patch region by tonal zone.

**Tech Stack:** Rust (raw-core crate), existing `view::agx` / `view::encode` / `color::matrices` / `math::Matrix3`, `maple-cli` harness binary, `src/scripts/compare_images.py` (CIEDE2000), `cargo test`.

---

## Scope notes

- This plan covers **Phase 0 only** (the de-risk spike). Phase 1+ (raster-mask carrier, `.maple/inpaint` cache, FFI, model, UX) are separate plans per design doc §7.
- **Tasks 0.1 and 0.2 are fully specified** (forward source read: `view/agx.rs`, `view/agx_coeffs.rs`, `view/agx_hue_restoration.rs`, `view/encode.rs`, `color/matrices.rs`, `math.rs`, `image.rs`).
- **Tasks 0.3–0.5 are specified with interfaces, inversion approach, and test gates**, and are marked **EXPAND-BEFORE-EXECUTE**: read the named forward source for each and break its implementation into bite-sized steps before coding. This is deliberate staging, not a hidden placeholder — each forward stage (`color/profile_tone_curve.rs`, `stages/white_balance.rs`, `stages/scene_tone_controls.rs`, `stages/tone_curves.rs`) must be read so the inverse is exact.
- **Decision baked into this plan (design conversation):** the model's bake-preview is rendered with creative/spatial stages OFF (vibrance/saturation/HSL/clarity/texture/dehaze/vignette). They are excluded from the bake and ride the live chain. The inverse therefore only undoes `AgX + tone + exposure + WB-delta`. DCP and AE are baked upstream of the seam and are NOT inverted.

## File structure

- Create: `src/raw-pipeline/raw-core/src/view/agx_inverse.rs` — the inverse view tail (AgX⁻¹ + display-encode⁻¹). One responsibility: display-referred → scene-linear Rec.2020. Sibling to `view/agx.rs`.
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` — add `pub mod agx_inverse;`.
- Create: `src/raw-pipeline/raw-core/src/view/grade_inverse.rs` — the inverse live grade (WB-delta⁻¹, exposure⁻¹, tone⁻¹, #550-curve⁻¹). Sibling; keeps `agx_inverse.rs` under the 600-LOC budget.
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` — add `pub mod grade_inverse;`.
- Create: `src/raw-pipeline/maple-cli/src/commands/inpaint_roundtrip.rs` — the headless round-trip harness command.
- Modify: `src/raw-pipeline/maple-cli/src/commands/mod.rs` + `src/raw-pipeline/maple-cli/src/main.rs` — register the subcommand.
- Create: `src/scripts/test_inpaint_roundtrip.sh` — wraps the harness + `compare_images.py`, ΔE-by-zone gate (mirrors `test_color_pipeline.sh` skip-pass-on-no-fixtures convention).

---

## Task 0.1: Inverse AgX core (display-linear Rec.2020 → scene-linear Rec.2020)

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/agx_inverse.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` (add `pub mod agx_inverse;`)
- Test: inline `#[cfg(test)] mod tests` in `agx_inverse.rs`

**Forward reference (do not modify):** `view/agx.rs::agx_pixel` — `inset = INSET·scene` → `n = max(inset)` → `sn = sample_lut(MID_NORM + (log_encode(n) - MID_NORM)*slope)` → `sig = inset * (sn/n)` → `out = OUTSET·sig` → `oklab_gamut_compress(out)`. `OUTSET = inv(INSET)` (asserted at `agx.rs:242`). `MID_NORM = -AGX_MIN_EV/(AGX_MAX_EV-AGX_MIN_EV)`.

**Inverse math (in-gamut assumption — forward gamut-compress was identity):**
1. `sig = INSET · display` (because `inv(OUTSET) = INSET`).
2. `sn = max(sig)` (ratio-preserving forward makes the max channel of `sig` equal `sn`).
3. `modulated = inv_lut(sn)` — reverse the monotone LUT (binary search over the 512 entries, linear-interpolate, clamp to `[lut[0], lut[last]]`).
4. `norm = (modulated - MID_NORM)/slope + MID_NORM`.
5. `n = AGX_MID_GRAY * 2^(norm*(AGX_MAX_EV-AGX_MIN_EV) + AGX_MIN_EV)` (inverse of `log_encode`).
6. `inset = sig * (n / sn)` (undo the ratio scale; guard `sn > RATIO_FLOOR`).
7. `scene = OUTSET · inset` (because `inv(INSET) = OUTSET`).

- [ ] **Step 1: Add the module declaration.**

In `src/raw-pipeline/raw-core/src/view/mod.rs`, add after `pub mod agx;`:

```rust
pub mod agx_inverse;
```

- [ ] **Step 2: Write the failing round-trip test.**

Create `src/raw-pipeline/raw-core/src/view/agx_inverse.rs` with only the test module + a stub signature so it compiles-and-fails:

```rust
//! Inverse AgX view transform: display-linear Rec.2020 → scene-linear Rec.2020.
//! Exact for in-gamut midtones; bounded-error (clamped) at the AgX toe/shoulder.
//! Assumes in-gamut chroma — the forward Oklab gamut-compress is many-to-one at
//! the wall and is treated as identity here (design doc §3b).

use crate::view::agx;

/// Invert AgX for a single display-linear Rec.2020 pixel back to scene-linear
/// Rec.2020, given the same `slope` the forward pass used
/// (`slope = 1 + (contrast/100)*0.5`).
pub fn inverse_agx_pixel(_display: [f32; 3], _slope: f32) -> [f32; 3] {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};

    /// Forward AgX one pixel via the public stage, return display-linear RGB.
    fn forward(scene: [f32; 3], contrast: f32) -> [f32; 3] {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = scene;
        agx::apply(&mut img, contrast);
        img.pixels[0]
    }

    #[test]
    fn roundtrip_neutral_axis_midtones() {
        // Neutral mid-tones must round-trip to a few-percent relative error.
        for &v in &[0.05f32, 0.10, 0.18, 0.35, 0.6] {
            let scene = [v, v, v];
            let disp = forward(scene, 0.0);
            let slope = 1.0 + (0.0 / 100.0) * 0.5;
            let back = inverse_agx_pixel(disp, slope);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c];
                assert!(rel < 0.02, "neutral {} ch{} rel err {} (back={:?})", v, c, rel, back);
            }
        }
    }

    #[test]
    fn roundtrip_midtone_color_preserves_hue_and_value() {
        // In-gamut colored mid-tones round-trip within a few percent.
        let cases = [[0.22f32, 0.14, 0.09], [0.10, 0.18, 0.12], [0.12, 0.13, 0.25]];
        for scene in cases {
            let disp = forward(scene, 0.0);
            let back = inverse_agx_pixel(disp, 1.0);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c].max(1e-3);
                assert!(rel < 0.05, "color {:?} ch{} rel err {} (back={:?})", scene, c, rel, back);
            }
        }
    }

    #[test]
    fn roundtrip_under_contrast_slope() {
        // The inverse must use the same slope the forward used.
        let scene = [0.18f32, 0.12, 0.20];
        for &contrast in &[-50.0f32, 0.0, 50.0] {
            let disp = forward(scene, contrast);
            let slope = 1.0 + (contrast / 100.0) * 0.5;
            let back = inverse_agx_pixel(disp, slope);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c];
                assert!(rel < 0.05, "contrast {} ch{} rel err {}", contrast, c, rel);
            }
        }
    }
}
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view::agx_inverse 2>&1 | tail -20`
Expected: FAIL / panic `not implemented` in all three tests.

- [ ] **Step 4: Implement `inverse_agx_pixel` + the inverse-LUT helper.**

Replace the stub. Reuse the forward LUT by exposing it; to avoid touching `agx.rs` visibility, re-parse the same embedded bytes here (single source: `include_bytes!("agx_lut.bin")`), OR add `pub(crate) fn lut()` + `pub(crate) const MID_NORM` to `agx.rs` and import. Prefer the latter (no duplicate parse). Implementation:

```rust
use crate::view::agx::{lut, MID_NORM}; // add pub(crate) to both in agx.rs
use crate::view::agx::{AGX_INSET_MATRIX, AGX_OUTSET_MATRIX, AGX_MAX_EV, AGX_MIN_EV, AGX_MID_GRAY, AGX_LUT_SIZE};

const RATIO_FLOOR: f32 = 1e-6;

#[inline]
fn matrix_mul(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
        m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
        m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
    ]
}

/// Reverse the monotone forward sigmoid LUT: given display value `y`, find
/// normalized-log `x ∈ [0,1]` with `sample_lut(x) ≈ y`. Clamps `y` to the LUT
/// range (toe/shoulder are flat → ill-conditioned; clamp is the bounded-error
/// guard from design doc §3b).
fn inv_lut(y: f32) -> f32 {
    let l = lut();
    let y = y.clamp(l[0], l[AGX_LUT_SIZE - 1]);
    // Binary search for the bracketing indices (monotone nondecreasing).
    let (mut lo, mut hi) = (0usize, AGX_LUT_SIZE - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if l[mid] <= y { lo = mid; } else { hi = mid; }
    }
    let denom = l[hi] - l[lo];
    let frac = if denom > 1e-12 { (y - l[lo]) / denom } else { 0.0 };
    ((lo as f32) + frac) / ((AGX_LUT_SIZE - 1) as f32)
}

pub fn inverse_agx_pixel(display: [f32; 3], slope: f32) -> [f32; 3] {
    // 1) Undo outset (inv(OUTSET) == INSET).
    let sig = matrix_mul(&AGX_INSET_MATRIX, display);
    // 2) Ratio-preserving forward => max(sig) == sigmoid(norm).
    let sn = sig[0].max(sig[1]).max(sig[2]);
    if sn <= RATIO_FLOOR {
        return [0.0, 0.0, 0.0];
    }
    // 3-5) Invert sigmoid LUT, undo contrast slope, undo log encode → n.
    let modulated = inv_lut(sn);
    let norm = (modulated - MID_NORM) / slope + MID_NORM;
    let log_v = norm * (AGX_MAX_EV - AGX_MIN_EV) + AGX_MIN_EV;
    let n = AGX_MID_GRAY * log_v.exp2();
    // 6) Undo ratio scale: inset = sig * (n / sn).
    let scale = n / sn;
    let inset = [sig[0]*scale, sig[1]*scale, sig[2]*scale];
    // 7) Undo inset (inv(INSET) == OUTSET).
    matrix_mul(&AGX_OUTSET_MATRIX, inset)
}
```

In `agx.rs`, change `fn lut()` → `pub(crate) fn lut()`, `const MID_NORM` → `pub(crate) const MID_NORM`, and ensure the coeff re-exports (`AGX_INSET_MATRIX`, etc.) are reachable as `crate::view::agx::*` (they already are via `pub use coeffs::…`).

- [ ] **Step 5: Run the test to verify it passes.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view::agx_inverse 2>&1 | tail -20`
Expected: PASS (3 tests). Do NOT pipe long builds through `tail` mid-compile — only the final result line.

- [ ] **Step 6: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/view/agx_inverse.rs src/raw-pipeline/raw-core/src/view/mod.rs src/raw-pipeline/raw-core/src/view/agx.rs
git commit -m "feat(raw-core): inverse AgX view transform (in-gamut midtone round-trip)"
```

---

## Task 0.2: Inverse display encode (8-bit sRGB → display-linear Rec.2020)

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/view/agx_inverse.rs` (add `inverse_display_encode_pixel` + `display_u8_to_scene_linear`)
- Test: extend the inline test module

**Forward reference:** `view/encode.rs` — `rec2020_to_srgb` (`M_REC2020_TO_SRGB·p` then Oklab compress in sRGB), `srgb_gamma` (IEC 61966-2-1), `dither_and_quantize` (`round(v*255 + bayer)`).

**Inverse math (in-gamut):** `x = u8/255` → `srgb_lin = srgb_gamma_inv(x)` → `display_rec2020 = M_SRGB_TO_REC2020 · srgb_lin`, where `M_SRGB_TO_REC2020 = M_REC2020_TO_SRGB.inverse().unwrap()` (a `Matrix3`, `math.rs:33`). Dither is zero-mean sub-LSB — ignored on inverse.

- [ ] **Step 1: Write the failing test.**

Add to the test module:

```rust
#[test]
fn srgb_gamma_inverse_roundtrips() {
    use crate::view::encode::srgb_gamma;
    for i in 0..=255u32 {
        let lin = (i as f32) / 255.0;
        let enc = srgb_gamma(lin);
        let back = super::srgb_gamma_inv(enc);
        assert!((back - lin).abs() < 1e-3, "x={} back={}", lin, back);
    }
}

#[test]
fn full_view_tail_roundtrips_midtone() {
    // scene -> AgX -> rec2020->srgb -> gamma -> u8 -> (inverse) -> scene.
    use crate::view::encode::{rec2020_to_srgb, srgb_gamma_encode, dither_and_quantize};
    use crate::image::{ColorSpace, Image};
    let scene = [0.18f32, 0.13, 0.20];
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = scene;
    agx::apply(&mut img, 0.0);
    rec2020_to_srgb(&mut img);
    srgb_gamma_encode(&mut img);
    let u8s = dither_and_quantize(&mut img); // [r,g,b]
    let back = super::display_u8_to_scene_linear([u8s[0], u8s[1], u8s[2]], 1.0);
    for c in 0..3 {
        let rel = (back[c] - scene[c]).abs() / scene[c];
        assert!(rel < 0.06, "ch{} rel {} back={:?}", c, rel, back);
    }
}
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view::agx_inverse 2>&1 | tail -20`
Expected: FAIL (`srgb_gamma_inv` / `display_u8_to_scene_linear` not found).

- [ ] **Step 3: Implement.**

```rust
use crate::color::matrices::M_REC2020_TO_SRGB;

/// Inverse IEC 61966-2-1 sRGB OETF.
pub fn srgb_gamma_inv(y: f32) -> f32 {
    let y = y.clamp(0.0, 1.0);
    if y <= 0.040_449_936 { y / 12.92 } else { ((y + 0.055) / 1.055).powf(2.4) }
}

/// 8-bit sRGB-encoded RGB → scene-linear Rec.2020 (in-gamut assumption).
pub fn display_u8_to_scene_linear(rgb: [u8; 3], slope: f32) -> [f32; 3] {
    let srgb_lin = [
        srgb_gamma_inv(rgb[0] as f32 / 255.0),
        srgb_gamma_inv(rgb[1] as f32 / 255.0),
        srgb_gamma_inv(rgb[2] as f32 / 255.0),
    ];
    let m_inv = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB is invertible");
    let display_rec2020 = m_inv.mul_vec(srgb_lin);
    inverse_agx_pixel(display_rec2020, slope)
}
```

(`Matrix3::mul_vec` takes/returns the crate `Vec3` = `[f32;3]`; confirm the alias when wiring — `math.rs:12`.)

- [ ] **Step 4: Run to verify it passes.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib view::agx_inverse 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/view/agx_inverse.rs
git commit -m "feat(raw-core): inverse display encode (u8 sRGB -> scene-linear Rec.2020)"
```

---

## Task 0.3: Inverse #550 Auto Profile curve  — EXPAND-BEFORE-EXECUTE

**Read first:** `color/profile_tone_curve.rs`, `view/auto_profile/mod.rs`, `view/auto_profile/apply_pipeline.rs`, `view/auto_profile/bake.rs`, `view/auto_profile/solve.rs`. Confirm: (a) the #550 per-channel display curve is monotone (forced non-decreasing at fit) and exposed as a samplable 1D function/LUT per channel; (b) the residual 3D `ColorLut` can be disabled (`MAPLE_DISABLE_AUTO_LUT` / strength 0) and the legacy `apply.rs` Oklab path kept out of play.

**Inverse approach:** build a per-image, per-channel inverse LUT by sampling the forward curve at N points (e.g. 1024) over `[0,1]` and reverse-interpolating (same `inv_lut` pattern as Task 0.1). Snapshot the curve identity so the inverse re-applies the *exact* per-image artifact (design doc §3b).

**Test gate:** forward-curve → inverse-curve round-trips to < 1e-3 across `[0,1]` per channel, with the 3D LUT disabled. Add to `grade_inverse.rs` tests.

**File:** create `src/raw-pipeline/raw-core/src/view/grade_inverse.rs` (+ `pub mod grade_inverse;` in `view/mod.rs`).

---

## Task 0.4: Inverse live grade — WB-delta, exposure, tone curves  — EXPAND-BEFORE-EXECUTE

**Read first:** `stages/white_balance.rs` (esp. `apply_delta` + `wb_gains`), `stages/scene_tone_controls.rs` (user exposure EV stacking), `stages/tone_curves.rs` (parametric + per-channel). Confirm each is per-pixel and monotone/linear enough to invert.

**Inverse approach (apply in reverse pipeline order):** `tone_curves⁻¹` (monotone LUT inverse) → `scene_tone_controls⁻¹` (exposure is `*2^EV` → `*2^-EV`; confirm any non-exposure controls in this stage and whether they belong to the bake-preview path) → `white_balance::apply_delta⁻¹` (swap source/target: `wb_gains(decoded)/wb_gains(bake)`). Produces pre-user-grade scene-linear = the cached-buffer state.

**Test gate:** for a synthetic AdjustmentModel (exposure ±2 EV, temp ±1000K, a non-identity tone curve), `grade_forward(scene) → grade_inverse → scene` round-trips < a few percent on midtones. Reuse the real forward stages for the forward direction (no reimplementation).

---

## Task 0.5: End-to-end harness + ΔE-by-zone gate  — EXPAND-BEFORE-EXECUTE

**Read first:** `maple-cli/src/main.rs`, `maple-cli/src/commands/mod.rs` (subcommand registration pattern), `src/scripts/test_color_pipeline.sh` + `src/scripts/compare_images.py` (invocation + skip-pass convention).

**Build:** `maple-cli inpaint-roundtrip` that, for a synthetic scene-linear patch fixture (procedurally generated — gradients + color swatches across tonal zones; no RAW needed):
1. forward-render through the **bake-preview path** (`WB → exposure → tone → AgX → encode`, creative/spatial OFF) → 8-bit sRGB PNG (the "model input").
2. invert (Tasks 0.1–0.4) back to pre-user-grade scene-linear.
3. composite at the seam into a copy of the original pre-grade patch (here: identity composite — same region — so the diff measures pure inverse fidelity).
4. re-render the composited buffer through the **full live chain** under a matrix of `exposure ∈ {-2,0,+2} EV` × `temp ∈ {-1000,0,+1000} K`.
5. for each cell, also render the *original* scene-linear patch through the same live chain (ground truth), and write both PNGs.

**Gate (`src/scripts/test_inpaint_roundtrip.sh`):** run `compare_images.py` per cell, **stratified by tonal zone** (shadow / midtone / highlight masks derived from the ground-truth luma). PASS if **midtone mean ΔE2000 < 3** and **midtone p95 < 6** across all cells, and shadow/highlight are **finite + monotone (no banding, no NaN/Inf, no channel > ground-truth-max + margin)**. Skip-pass with a message if run in an environment without Python/numpy (mirror `test_color_pipeline.sh`). Write candidate + ground-truth PNGs under `~/Desktop/maple-color-tests/inpaint-phase0/` for visual review (per user convention).

**Go/no-go:** if the midtone gate holds and shadows/highlights degrade gracefully, the synthetic-raw architecture is validated and Phase 1 proceeds. If midtone ΔE blows past budget, the inverse is too lossy and the design must change (e.g. inpaint in a more-linear input encoding) before any model/UX work.

---

## Self-review

- **Spec coverage:** §6 spike (inverse AgX accuracy + grade re-grade + ΔE-by-zone) → Tasks 0.1–0.5. §4 placement (pre-grade seam, invert AgX+tone+EV+WB, not DCP/AE) → Tasks 0.2/0.4/0.5. §3b constraints (#550 curve only, 3D LUT off, in-gamut, clamp toe/shoulder) → Tasks 0.1/0.3.
- **Type consistency:** `inverse_agx_pixel(display, slope)` and `display_u8_to_scene_linear(rgb, slope)` use the same `slope = 1+(contrast/100)*0.5` convention as `agx::apply`. `inv_lut` mirrors forward `sample_lut` indexing (`AGX_LUT_SIZE-1` scale).
- **No placeholders in 0.1/0.2** — complete code + tests. 0.3–0.5 are explicitly EXPAND-BEFORE-EXECUTE with named forward sources and concrete test gates, per the staging note.
