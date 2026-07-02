//! 8-band HSL hue/saturation/luminance stage (#1112, tone/zoom design § 10.4).
//!
//! Scene-linear stage computed in Oklab, positioned adjacent to the
//! existing vibrance/saturation block. Uses a **raised-cosine partition of
//! unity** over 8 ACR-aligned hue centers (Red, Orange, Yellow, Green,
//! Aqua, Blue, Purple, Magenta) — circular in hue, so bands wrap across
//! the ±180° boundary. The 8 Oklab hue centers are non-uniformly spaced,
//! so a fixed 67.5° half-width (see `BAND_HALF_WIDTH_DEG`) is used and
//! partition-of-unity is achieved via per-pixel weight normalization
//! (each band weight divided by the sum across all 8 bands). Each band
//! weight is chroma-gated: hard early-return for C < C0, then
//! `smoothstep(C0, 2·C0, C)` for a smooth onset. The neutral axis is
//! **exactly stable** — near-neutrals pass through bit-for-bit. The three
//! channels (Hue, Saturation, Luminance) act independently on the armed
//! band's contribution:
//!
//! - **Hue:** rotates the Oklab hue angle by `slider/100 · HSL_HUE_MAX_RAD`
//!   radians.
//! - **Saturation:** scales the Oklab chroma `C` by `1 + slider/100`.
//! - **Luminance:** scales the Oklab `L` component by `1 + slider/100 · w`
//!   (an Oklab-L scale, not a uniform RGB multiply — hue and chroma are
//!   preserved in Oklab space).
//!
//! All-defaults = bit-identical no-op (the whole-stage short-circuit at the
//! top of `apply` guards this). A pure point op — tile-safe with register
//! radius 0.
//!
//! ## Band centers (Oklab hue angle, degrees)
//!
//! ACR's 8 bands mapped to approximate Oklab hue angles. The mapping is
//! deliberately a well-defined constant (not fit against any dataset at
//! this stage — see `HSL_HUE_MAX_DEG` comment for pending calibration):
//!
//! | Band    | ACR center | Oklab center |
//! |---------|-----------|--------------|
//! | Red     |   0° (±30°)| see `HUE_CENTERS_DEG` |
//! | Orange  |  30°       |              |
//! | Yellow  |  60°       |              |
//! | Green   |  120°      |              |
//! | Aqua    |  180°      |              |
//! | Blue    |  240°      |              |
//! | Purple  |  270°      |              |
//! | Magenta |  300°      |              |
//!
//! The 8 centers in Oklab hue space are approximated from CIE Oklab
//! primary hue angles (red ≈ 29°, orange ≈ 55°, yellow ≈ 110°,
//! green ≈ 145°, aqua ≈ 195°, blue ≈ 250°, purple ≈ 285°,
//! magenta ≈ 328°) — see `HUE_CENTERS_DEG`. These produce visually
//! correct band targets for typical camera gamut; ACR-calibrated
//! refinement is tracked as a follow-up.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};

// ── Band centers ─────────────────────────────────────────────────────────────

/// Number of HSL bands (ACR: Red, Orange, Yellow, Green, Aqua, Blue,
/// Purple, Magenta — indexed 0..7 in that order).
pub const NUM_BANDS: usize = 8;

/// Oklab hue centers for the 8 ACR-aligned bands, in degrees [0, 360).
/// These are initial approximations from primary hue geometry; a full
/// ACR-calibrated fit (slider-matrix reference renders) is deferred to
/// the post-ACR-render milestone. The constants are `pub` so the WGSL
/// host transcription can use the same values.
///
/// Order: Red(0), Orange(1), Yellow(2), Green(3),
///        Aqua(4), Blue(5), Purple(6), Magenta(7).
pub const HUE_CENTERS_DEG: [f32; NUM_BANDS] = [
    29.0,  // Red
    55.0,  // Orange
    110.0, // Yellow
    145.0, // Green
    195.0, // Aqua
    250.0, // Blue
    285.0, // Purple
    328.0, // Magenta
];

/// Raised-cosine half-width per band (degrees). Because the 8 ACR-aligned
/// Oklab hue centers are **not** uniformly spaced, a fixed half-width alone
/// cannot give exact partition of unity — the band weights are normalized at
/// the per-pixel level (each weight divided by the total across all 8 bands).
/// Half-width = 67.5° (1.5× the uniform spacing of 45°) keeps each band's
/// influence local (typically ≤ 2–3 contributing bands per pixel) while
/// guaranteeing coverage at every hue with the non-uniform centers.
pub const BAND_HALF_WIDTH_DEG: f32 = 67.5;

/// Chroma threshold below which the band weight fades to zero
/// (smoothstep 0→C0). Below this threshold hue is undefined and all
/// band weights return zero — the neutral-axis stability guarantee.
/// In Oklab chroma units (typical in-gamut range 0..0.4).
pub const CHROMA_GATE_C0: f32 = 0.05;

/// Maximum hue rotation at slider ±100 (in degrees). This is the
/// calibrated target value; ACR uses ±30° at ±100. Pending the full
/// slider-matrix ACR-reference fit, this constant is deliberately marked
/// as provisional.
///
/// **Pending ACR calibration** (tracked in #1112 follow-up): the exact
/// rotation-vs-slider mapping against Adobe ACR reference renders has not
/// yet been measured. ±30° is the class-level ACR design target; refine
/// once per-band reference renders are available.
pub const HSL_HUE_MAX_DEG: f32 = 30.0; // pending ACR calibration

/// `HSL_HUE_MAX_DEG` in radians, the constant the Oklab rotation uses.
pub const HSL_HUE_MAX_RAD: f32 = HSL_HUE_MAX_DEG * std::f32::consts::PI / 180.0;

// ── Raised-cosine band weight ─────────────────────────────────────────────────

/// Raised-cosine weight for angular distance `delta_deg` (circular,
/// already in [0, 180]). Returns `(1 + cos(π·delta/halfwidth)) / 2`
/// for `delta ≤ halfwidth`, else 0.
#[inline]
pub fn raised_cosine_weight(delta_deg: f32, half_width_deg: f32) -> f32 {
    if delta_deg >= half_width_deg {
        return 0.0;
    }
    let t = delta_deg / half_width_deg; // [0, 1]
    0.5 * (1.0 + (std::f32::consts::PI * t).cos())
}

/// Circular angular distance (degrees) in [0, 180], wrapped correctly.
#[inline]
pub fn circular_delta_deg(h: f32, center: f32) -> f32 {
    let mut d = (h - center).abs() % 360.0;
    if d > 180.0 {
        d = 360.0 - d;
    }
    d
}

/// Per-pixel Oklab hue angle in degrees, mapped to [0, 360).
///
/// Returns 0° for exactly neutral (a=0, b=0) — callers must early-return
/// on low-chroma inputs before calling this.
#[inline]
fn oklab_hue_deg(a: f32, b: f32) -> f32 {
    let h = b.atan2(a).to_degrees();
    if h < 0.0 {
        h + 360.0
    } else {
        h
    }
}

// ── Params struct (shared with GPU oracle) ────────────────────────────────────

/// Hoisted per-render parameters for the HSL stage. Computing these once
/// per render (rather than per pixel) is important for performance; the
/// GPU WGSL host transcribes the same values to its uniform buffer.
#[derive(Clone, Copy, Debug)]
pub struct HslParams {
    /// Per-band hue-rotation amount in radians (`slider/100 · HSL_HUE_MAX_RAD`).
    pub hue_rad: [f32; NUM_BANDS],
    /// Per-band saturation scale factor (`1 + slider/100`).
    pub sat_scale: [f32; NUM_BANDS],
    /// Per-band luminance shift (`slider/100`; see note in `apply_pixel`).
    pub lum_shift: [f32; NUM_BANDS],
    /// True when ALL sliders are at default (0) — whole-stage short-circuit.
    pub is_identity: bool,
}

/// Hoist per-render HSL params from the 24 raw slider values.
/// Accepts three contiguous slices `[Red..Magenta]` for hue, sat, lum.
pub fn hsl_params(
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) -> HslParams {
    let mut hue_rad = [0.0f32; NUM_BANDS];
    let mut sat_scale = [1.0f32; NUM_BANDS];
    let mut lum_shift = [0.0f32; NUM_BANDS];
    let mut is_identity = true;
    for i in 0..NUM_BANDS {
        if hue[i].abs() >= 1e-3 {
            hue_rad[i] = hue[i] / 100.0 * HSL_HUE_MAX_RAD;
            is_identity = false;
        }
        if sat[i].abs() >= 1e-3 {
            sat_scale[i] = 1.0 + sat[i] / 100.0;
            is_identity = false;
        }
        if lum[i].abs() >= 1e-3 {
            lum_shift[i] = lum[i] / 100.0;
            is_identity = false;
        }
    }
    HslParams {
        hue_rad,
        sat_scale,
        lum_shift,
        is_identity,
    }
}

/// Per-pixel HSL transform in Oklab. Returns the modified RGB pixel.
///
/// 1. Early-return exact identity when C < CHROMA_GATE_C0 (near-neutral axis).
/// 2. Compute raw raised-cosine weight `w_shape[b]` for each of the 8 bands.
/// 3. Normalize: `w[b] = w_shape[b] / sum(w_shape)` — this gives exact
///    partition of unity regardless of (non-uniform) band center spacing.
/// 4. Chroma gate: `w[b] *= smoothstep(C0, 2·C0, C)` — smooth onset above C0.
/// 5. For each band, accumulate: hue rotation, saturation delta, luminance delta.
/// 6. Apply luminance (scale L — hue-preserving).
/// 7. Apply saturation (scale chroma C).
/// 8. Apply hue rotation (rotate Oklab (a, b)).
///
/// The hard cutoff at step 1 ensures the neutral-axis stability guarantee:
/// any color with C < CHROMA_GATE_C0 passes through bit-exactly.
#[inline]
pub fn apply_pixel(rgb: [f32; 3], p: &HslParams) -> [f32; 3] {
    if p.is_identity {
        return rgb;
    }
    let lab = rec2020_to_oklab(rgb);
    let (mut l, a, b) = (lab[0], lab[1], lab[2]);

    let c = (a * a + b * b).sqrt();
    // Hard cutoff: below the smoothstep ramp (C < CHROMA_GATE_C0) the pixel
    // is returned exactly unchanged. This covers the neutral axis (C = 0) and
    // any near-neutral color below the transition threshold.
    if c < CHROMA_GATE_C0 {
        return rgb; // exact identity on near-neutral pixels
    }
    // Chroma-gate scalar: smooth ramp from 0 at C0 to 1 at 2·C0.
    let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c);

    let hue = oklab_hue_deg(a, b);
    let a_hat = a / c;
    let b_hat = b / c;

    // Compute raw raised-cosine weights for all 8 bands, then normalize
    // so they sum to 1 (partition of unity, regardless of center spacing).
    let mut w_shape = [0.0f32; NUM_BANDS];
    let mut w_sum = 0.0f32;
    for band in 0..NUM_BANDS {
        let delta_deg = circular_delta_deg(hue, HUE_CENTERS_DEG[band]);
        w_shape[band] = raised_cosine_weight(delta_deg, BAND_HALF_WIDTH_DEG);
        w_sum += w_shape[band];
    }
    // If no band contributes (w_sum ≈ 0), this hue is in a coverage gap —
    // return identity. Should not happen with hw=67.5° and any set of centers,
    // but guard defensively.
    if w_sum < 1e-6 {
        return rgb;
    }
    let w_norm_scale = chroma_gate / w_sum; // chroma_gate · (1/w_sum)

    let mut delta_hue_rad = 0.0f32;
    let mut delta_sat_scale = 0.0f32; // additive component of sat_scale − 1
    let mut delta_lum_shift = 0.0f32;

    for band in 0..NUM_BANDS {
        if w_shape[band] < 1e-6 {
            continue;
        }
        let w = w_shape[band] * w_norm_scale;

        delta_hue_rad += p.hue_rad[band] * w;
        delta_sat_scale += (p.sat_scale[band] - 1.0) * w;
        delta_lum_shift += p.lum_shift[band] * w;
    }

    // Apply luminance (scale L — hue-preserving)
    if delta_lum_shift.abs() > 1e-6 {
        l *= 1.0 + delta_lum_shift;
    }

    // Apply saturation (scale chroma)
    let c_new = (c * (1.0 + delta_sat_scale)).max(0.0);

    // Apply hue rotation (rotate (a, b) by delta_hue_rad)
    let (sin_dh, cos_dh) = delta_hue_rad.sin_cos();
    let a_new = c_new * (a_hat * cos_dh - b_hat * sin_dh);
    let b_new = c_new * (a_hat * sin_dh + b_hat * cos_dh);

    oklab_to_rec2020([l, a_new, b_new])
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply the HSL stage to `img`. Identity short-circuit when all 24
/// sliders are at default (the baseline guarantee).
pub fn apply(
    img: &mut Image,
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let p = hsl_params(hue, sat, lum);
    if p.is_identity {
        return;
    }
    for px in &mut img.pixels {
        *px = apply_pixel(*px, &p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};

    const BANDS: usize = NUM_BANDS;

    fn zero_bands() -> [f32; NUM_BANDS] {
        [0.0; NUM_BANDS]
    }

    fn grey_scene(w: u32, h: u32, v: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [v, v, v];
        }
        img
    }

    // ── Neutral-axis identity ──────────────────────────────────────────────

    /// All-default model is a bit-identical no-op (whole-stage gate).
    #[test]
    fn all_defaults_is_bit_identical() {
        let mut img = grey_scene(8, 8, 0.18);
        let before = img.pixels.clone();
        apply(&mut img, &zero_bands(), &zero_bands(), &zero_bands());
        assert_eq!(
            img.pixels, before,
            "all-default model must be bit-identical no-op"
        );
    }

    /// Any slider set with a neutral (grey) input is a no-op because
    /// chroma C = 0 and the gate is exactly zero.
    #[test]
    fn any_slider_on_neutral_is_identity() {
        // Test all eight SAT sliders at +100 and -100 — most aggressive
        // combination; neutral input must still be unchanged.
        for band in 0..BANDS {
            for &sv in &[-100.0_f32, 100.0] {
                let mut sat = zero_bands();
                sat[band] = sv;
                let mut img = grey_scene(4, 4, 0.18);
                let before = img.pixels.clone();
                apply(&mut img, &zero_bands(), &sat, &zero_bands());
                for (i, (a, b)) in img.pixels.iter().zip(before.iter()).enumerate() {
                    assert!(
                        (a[0] - b[0]).abs() < 1e-5
                            && (a[1] - b[1]).abs() < 1e-5
                            && (a[2] - b[2]).abs() < 1e-5,
                        "sat[{band}]={sv}: neutral pixel {i} changed: {a:?} != {b:?}"
                    );
                }
            }
        }

        // Hue sliders — same invariant
        for band in 0..BANDS {
            let mut hue = zero_bands();
            hue[band] = 100.0;
            let mut img = grey_scene(4, 4, 0.18);
            let before = img.pixels.clone();
            apply(&mut img, &hue, &zero_bands(), &zero_bands());
            for (i, (a, b)) in img.pixels.iter().zip(before.iter()).enumerate() {
                assert!(
                    (a[0] - b[0]).abs() < 1e-5
                        && (a[1] - b[1]).abs() < 1e-5
                        && (a[2] - b[2]).abs() < 1e-5,
                    "hue[{band}]=100: neutral pixel {i} changed: {a:?} != {b:?}"
                );
            }
        }
    }

    // ── Partition-of-unity ────────────────────────────────────────────────

    /// The normalized raised-cosine band weights sum to exactly 1 at every
    /// Oklab hue angle with non-zero raw weight. This is the invariant
    /// (enforced by the per-pixel normalization in `apply_pixel`) that
    /// makes SAT +100 on all bands exactly 2× global saturation, and keeps
    /// the stage consistent across hue regardless of non-uniform band spacing.
    ///
    /// Also verifies that no coverage gap exists at any sampled hue
    /// (raw weight sum > 0 everywhere with BAND_HALF_WIDTH_DEG = 67.5°).
    #[test]
    fn partition_of_unity_holds_at_sample_hues() {
        // Sample 72 hue angles evenly
        for i in 0..72u32 {
            let h = (i as f32) * 5.0;
            // Compute raw weights (same as apply_pixel does)
            let mut raw_sum = 0.0f32;
            let mut w = [0.0f32; BANDS];
            for band in 0..BANDS {
                let delta = circular_delta_deg(h, HUE_CENTERS_DEG[band]);
                w[band] = raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
                raw_sum += w[band];
            }
            assert!(
                raw_sum > 1e-6,
                "coverage gap at hue {h}°: raw_sum = {raw_sum} (increase BAND_HALF_WIDTH_DEG)"
            );
            // Normalized weights sum to exactly 1
            let norm_sum: f32 = w.iter().map(|wi| wi / raw_sum).sum();
            assert!(
                (norm_sum - 1.0).abs() < 1e-5,
                "normalized partition-of-unity violated at hue {h}°: sum = {norm_sum}"
            );
        }
    }

    // ── Closed-form predictor (known-chroma color per band) ───────────────

    /// For a color whose Oklab hue angle is at a band center, the SAT
    /// slider for that band must scale the Oklab chroma by the expected
    /// factor. The predictor accounts for normalization: the weight at
    /// band center `w_b = rc(0) / sum_all_rc = 1 / sum_all_rc`. With
    /// neighboring bands also contributing, the effective chroma scale is
    /// `1 + (sat_scale[b] - 1) · w_b`. Other bands are at their default
    /// sat_scale=1 → their contribution to delta_sat_scale is 0.
    #[test]
    fn saturation_scales_chroma_at_band_center() {
        for band in 0..BANDS {
            let center_rad = HUE_CENTERS_DEG[band].to_radians();
            // Construct a Rec.2020 color at the band's Oklab hue center
            // with a known chroma (well above CHROMA_GATE_C0 so gate ≈ 1).
            let c_in = 0.10_f32; // > 2 * CHROMA_GATE_C0 = 0.10, so gate ≈ 1.0
            let a0 = c_in * center_rad.cos();
            let b0 = c_in * center_rad.sin();
            let l0 = 0.5_f32;
            let rgb = crate::color::oklab::oklab_to_rec2020([l0, a0, b0]);

            // Compute the normalized weight for this band at its own center.
            let mut raw_sum = 0.0f32;
            for b in 0..BANDS {
                let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
                raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
            }
            let w_band = 1.0_f32 / raw_sum; // rc(0)/raw_sum = 1/raw_sum

            for &sv in &[-50.0_f32, 50.0, 100.0] {
                let mut sat = zero_bands();
                sat[band] = sv;
                let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
                img.pixels[0] = rgb;
                apply(&mut img, &zero_bands(), &sat, &zero_bands());

                let lab_out = rec2020_to_oklab(img.pixels[0]);
                let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();

                // Only the target band has non-zero delta: (sat_scale[b]-1) * w_band
                let delta_scale = (sv / 100.0) * w_band;
                // chroma_gate at c_in=0.10 vs 2*C0=0.10: exactly 1.0
                let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);
                let effective_delta = delta_scale * chroma_gate;
                let expected_c = (c_in * (1.0 + effective_delta)).max(0.0);
                assert!((c_out - expected_c).abs() < 0.005,
                    "band {band} SAT {sv}: c_out={c_out:.4} expected≈{expected_c:.4} (w_band={w_band:.3})");
                // L must not change (luminance slider = 0)
                assert!(
                    (lab_out[0] - l0).abs() < 1e-3,
                    "band {band} SAT {sv}: L changed from {l0} to {}",
                    lab_out[0]
                );
            }
        }
    }

    /// For a color at a band center, the HUE slider rotates the Oklab
    /// hue by `w_band · slider/100 · HSL_HUE_MAX_DEG` degrees, where
    /// `w_band = rc(0) / sum_all_rc` is the normalized weight for that band
    /// at its own center.
    #[test]
    fn hue_rotates_at_band_center() {
        for band in 0..BANDS {
            let center_rad = HUE_CENTERS_DEG[band].to_radians();
            let c_in = 0.10_f32; // > 2 * C0 so chroma_gate ≈ 1
            let a0 = c_in * center_rad.cos();
            let b0 = c_in * center_rad.sin();
            let rgb = crate::color::oklab::oklab_to_rec2020([0.5, a0, b0]);

            // Normalized band weight at this band's own center
            let mut raw_sum = 0.0f32;
            for b in 0..BANDS {
                let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
                raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
            }
            let w_band = 1.0_f32 / raw_sum;
            let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);

            for &hv in &[-100.0_f32, -50.0, 50.0, 100.0] {
                let mut hue = zero_bands();
                hue[band] = hv;
                let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
                img.pixels[0] = rgb;
                apply(&mut img, &hue, &zero_bands(), &zero_bands());

                let lab_out = rec2020_to_oklab(img.pixels[0]);
                let h_out = oklab_hue_deg(lab_out[1], lab_out[2]);
                let h_in_deg = HUE_CENTERS_DEG[band];
                // Effective rotation = hue_rad[band] * w_band * chroma_gate (in degrees)
                let expected_rot = hv / 100.0 * HSL_HUE_MAX_DEG * w_band * chroma_gate;
                let actual_rot = {
                    let mut d = h_out - h_in_deg;
                    while d > 180.0 {
                        d -= 360.0;
                    }
                    while d <= -180.0 {
                        d += 360.0;
                    }
                    d
                };
                assert!((actual_rot - expected_rot).abs() < 3.0,
                    "band {band} HUE {hv}: rot={actual_rot:.1}° expected≈{expected_rot:.1}° (w_band={w_band:.3})");
                // Chroma should be unchanged (hue-only rotation)
                let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();
                assert!(
                    (c_out - c_in).abs() < 0.005,
                    "band {band} HUE {hv}: chroma changed {c_in} → {c_out}"
                );
            }
        }
    }

    /// For a color at a band center, the LUM slider scales Oklab L by
    /// `1 + (slider/100) · w_band · chroma_gate`, where `w_band` is the
    /// normalized weight for that band at its own center. Hue and chroma
    /// are unchanged.
    #[test]
    fn luminance_scales_l_at_band_center() {
        for band in 0..BANDS {
            let center_rad = HUE_CENTERS_DEG[band].to_radians();
            let c_in = 0.10_f32; // > 2 * C0 → chroma_gate ≈ 1
            let a0 = c_in * center_rad.cos();
            let b0 = c_in * center_rad.sin();
            let l0 = 0.5_f32;
            let rgb = crate::color::oklab::oklab_to_rec2020([l0, a0, b0]);

            // Normalized band weight at this band's own center
            let mut raw_sum = 0.0f32;
            for b in 0..BANDS {
                let delta = circular_delta_deg(HUE_CENTERS_DEG[band], HUE_CENTERS_DEG[b]);
                raw_sum += raised_cosine_weight(delta, BAND_HALF_WIDTH_DEG);
            }
            let w_band = 1.0_f32 / raw_sum;
            let chroma_gate = smoothstep(CHROMA_GATE_C0, 2.0 * CHROMA_GATE_C0, c_in);

            for &lv in &[-50.0_f32, 50.0] {
                let mut lum = zero_bands();
                lum[band] = lv;
                let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
                img.pixels[0] = rgb;
                apply(&mut img, &zero_bands(), &zero_bands(), &lum);

                let lab_out = rec2020_to_oklab(img.pixels[0]);
                // Effective lum_shift = (lv/100) * w_band * chroma_gate
                let effective_shift = (lv / 100.0) * w_band * chroma_gate;
                let expected_l = l0 * (1.0 + effective_shift);
                assert!(
                    (lab_out[0] - expected_l).abs() < 0.01,
                    "band {band} LUM {lv}: L={} expected≈{expected_l} (w_band={w_band:.3})",
                    lab_out[0]
                );
                // Chroma unchanged (only L modified)
                let c_out = (lab_out[1] * lab_out[1] + lab_out[2] * lab_out[2]).sqrt();
                assert!(
                    (c_out - c_in).abs() < 0.01,
                    "band {band} LUM {lv}: chroma changed {c_in} → {c_out}"
                );
            }
        }
    }

    // ── Chroma-gate isolation ──────────────────────────────────────────────

    /// Colors whose chroma is below CHROMA_GATE_C0 have zero gate weight
    /// and are returned exactly unchanged even with non-zero sliders.
    #[test]
    fn very_low_chroma_is_unchanged() {
        // Construct a near-neutral with C ≪ CHROMA_GATE_C0
        let tiny_c = CHROMA_GATE_C0 * 0.1;
        let rgb = crate::color::oklab::oklab_to_rec2020([0.5, tiny_c, 0.0]);
        let mut hue = zero_bands();
        hue[0] = 100.0;
        let mut sat = zero_bands();
        for i in 0..BANDS {
            sat[i] = 100.0;
        }
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = rgb;
        let before = img.pixels[0];
        apply(&mut img, &hue, &sat, &zero_bands());
        let after = img.pixels[0];
        for c in 0..3 {
            assert!(
                (after[c] - before[c]).abs() < 1e-4,
                "low-chroma pixel channel {c} changed: {before:?} → {after:?}"
            );
        }
    }

    // ── Raised-cosine isolation test ──────────────────────────────────────

    /// `raised_cosine_weight(0, hw) == 1.0` and `raised_cosine_weight(hw, hw) == 0.0`
    #[test]
    fn raised_cosine_boundary_values() {
        let hw = BAND_HALF_WIDTH_DEG;
        assert!((raised_cosine_weight(0.0, hw) - 1.0).abs() < 1e-6);
        assert!(raised_cosine_weight(hw, hw).abs() < 1e-6);
        assert!(raised_cosine_weight(hw + 1.0, hw).abs() < 1e-6);
    }
}
