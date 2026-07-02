//! Split toning — display-linear Oklab a/b tint (#1111, tone/zoom design
//! § 10.3).
//!
//! Runs POST-AgX, before grain and the target-gamut conversion. ACR-
//! compatible mental model: a shadow hue/saturation pair, a highlight
//! pair, and a balance that shifts the crossover. With `Yd` = display
//! luminance and `bal ∈ [-100, +100]`:
//!
//! ```text
//! γ      = exp2(bal/100)                      // balance shifts the crossover
//! wS     = (1 − Yd)^γ · sS/100
//! wH     = Yd^(1/γ)   · sH/100
//! (a,b) += K · [wS·(cos hS, sin hS) + wH·(cos hH, sin hH)]   // Oklab; L unchanged
//! ```
//!
//! Hues are in degrees (the `crs:SplitToning*Hue` Lightroom convention).
//! L is untouched, so tone is invariant; at zero saturations the stage is
//! gated off entirely — neutral-preserving by construction. The shifted
//! pixel can leave the sRGB hull; the downstream `rec2020_to_srgb` Oklab
//! gamut compression owns bringing it back (nothing clips here).
//!
//! A pure point op — tile-safe with no window data at all.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::image::{ColorSpace, Image};

/// Oklab a/b shift at full saturation (spec § 10.3 initial calibrated
/// value): 0.06 Oklab chroma units at slider 100, weight 1.
pub const SPLIT_TONE_K: f32 = 0.06;
/// Rec.2020 luma weights (the pipeline-wide constant).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Hoisted per-render parameters, shared by the stage, the predictor, and
/// (transcribed) the WGSL host code: the two weight exponents and the two
/// pre-scaled hue vectors.
/// Returns `(gamma, inv_gamma, sa·(cos, sin), ha·(cos, sin))` where the
/// vectors are already scaled by `K · s/100`.
#[inline]
#[allow(clippy::type_complexity)]
pub fn split_tone_params(
    shadow_hue: f32,
    shadow_sat: f32,
    highlight_hue: f32,
    highlight_sat: f32,
    balance: f32,
) -> (f32, f32, [f32; 2], [f32; 2]) {
    let gamma = (balance / 100.0).exp2();
    let inv_gamma = 1.0 / gamma;
    let hs = shadow_hue.to_radians();
    let hh = highlight_hue.to_radians();
    let s_vec = [
        SPLIT_TONE_K * (shadow_sat / 100.0) * hs.cos(),
        SPLIT_TONE_K * (shadow_sat / 100.0) * hs.sin(),
    ];
    let h_vec = [
        SPLIT_TONE_K * (highlight_sat / 100.0) * hh.cos(),
        SPLIT_TONE_K * (highlight_sat / 100.0) * hh.sin(),
    ];
    (gamma, inv_gamma, s_vec, h_vec)
}

/// The (Δa, Δb) Oklab shift at display luminance `yd` — the closed form
/// the predictor uses; the stage applies the same shift per pixel.
#[inline]
pub fn split_tone_shift(
    yd: f32,
    gamma: f32,
    inv_gamma: f32,
    s_vec: [f32; 2],
    h_vec: [f32; 2],
) -> [f32; 2] {
    let y = yd.clamp(0.0, 1.0);
    let ws = (1.0 - y).powf(gamma);
    let wh = y.powf(inv_gamma);
    [ws * s_vec[0] + wh * h_vec[0], ws * s_vec[1] + wh * h_vec[1]]
}

/// Apply split toning per spec § 10.3. Identity short-circuit when both
/// saturations are below the slider epsilon — the baseline guarantee.
pub fn apply(
    img: &mut Image,
    shadow_hue: f32,
    shadow_sat: f32,
    highlight_hue: f32,
    highlight_sat: f32,
    balance: f32,
) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    if shadow_sat.abs() < 1e-3 && highlight_sat.abs() < 1e-3 {
        return;
    }
    let (gamma, inv_gamma, s_vec, h_vec) = split_tone_params(
        shadow_hue,
        shadow_sat,
        highlight_hue,
        highlight_sat,
        balance,
    );

    for p in &mut img.pixels {
        let yd = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let shift = split_tone_shift(yd, gamma, inv_gamma, s_vec, h_vec);
        let lab = rec2020_to_oklab(*p);
        *p = oklab_to_rec2020([lab[0], lab[1] + shift[0], lab[2] + shift[1]]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::rec2020_to_oklab;
    use crate::image::{ColorSpace, Image};

    fn grey_display(w: u32, h: u32, v: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
        for p in &mut img.pixels {
            *p = [v, v, v];
        }
        img
    }

    /// Zero saturations are a bit-identical no-op regardless of hues and
    /// balance (the baseline guarantee — neutral-preserving by gating).
    #[test]
    fn zero_saturations_are_bit_identical() {
        let mut img = grey_display(8, 8, 0.4);
        let before = img.pixels.clone();
        apply(&mut img, 220.0, 0.0, 40.0, 0.0, 60.0);
        assert_eq!(img.pixels, before);
    }

    /// The Oklab (a, b) shift on a grey pixel matches the closed form
    /// exactly, and L is unchanged: the whole-stage contract in one test.
    #[test]
    fn grey_shift_matches_closed_form_and_l_invariant() {
        for &(v, hs, ss, hh, sh, bal) in &[
            (0.18_f32, 30.0_f32, 60.0_f32, 210.0_f32, 40.0_f32, 0.0_f32),
            (0.05, 30.0, 100.0, 210.0, 0.0, -50.0),
            (0.80, 0.0, 0.0, 45.0, 80.0, 50.0),
            (0.50, 300.0, 35.0, 120.0, 35.0, 100.0),
        ] {
            let mut img = grey_display(2, 2, v);
            let lab_before = rec2020_to_oklab(img.pixels[0]);
            apply(&mut img, hs, ss, hh, sh, bal);
            let lab_after = rec2020_to_oklab(img.pixels[0]);

            let (gamma, inv_gamma, s_vec, h_vec) = split_tone_params(hs, ss, hh, sh, bal);
            // Yd on an exact grey is the luma dot — one ulp of v.
            let yd = 0.2627 * v + 0.6780 * v + 0.0593 * v;
            let expected = split_tone_shift(yd, gamma, inv_gamma, s_vec, h_vec);

            assert!(
                (lab_after[1] - lab_before[1] - expected[0]).abs() < 1e-5,
                "Δa mismatch at v={v}: got {}, predicted {}",
                lab_after[1] - lab_before[1],
                expected[0]
            );
            assert!(
                (lab_after[2] - lab_before[2] - expected[1]).abs() < 1e-5,
                "Δb mismatch at v={v}: got {}, predicted {}",
                lab_after[2] - lab_before[2],
                expected[1]
            );
            assert!(
                (lab_after[0] - lab_before[0]).abs() < 1e-5,
                "L must be unchanged at v={v}: {} vs {}",
                lab_after[0],
                lab_before[0]
            );
        }
    }

    /// Balance shifts the crossover: positive balance pushes the shadow
    /// weight DOWN at a given midtone (γ > 1 ⇒ (1−Yd)^γ smaller) and the
    /// highlight weight UP — the ACR mental model.
    #[test]
    fn balance_shifts_crossover() {
        let (g_pos, ig_pos, _, _) = split_tone_params(0.0, 100.0, 0.0, 100.0, 100.0);
        let (g_neg, ig_neg, _, _) = split_tone_params(0.0, 100.0, 0.0, 100.0, -100.0);
        let yd = 0.5f32;
        let ws_pos = (1.0 - yd).powf(g_pos);
        let ws_neg = (1.0 - yd).powf(g_neg);
        let wh_pos = yd.powf(ig_pos);
        let wh_neg = yd.powf(ig_neg);
        assert!(
            ws_pos < ws_neg,
            "positive balance must shrink the shadow weight"
        );
        assert!(
            wh_pos > wh_neg,
            "positive balance must grow the highlight weight"
        );
    }

    /// Shadow tint dominates dark pixels; highlight tint dominates bright
    /// ones (warm shadows / cool highlights split correctly by Yd).
    #[test]
    fn split_separates_by_luminance() {
        // Warm shadows (hue 30° ⇒ +a), cool highlights (hue 250° ⇒ −a-ish, −b).
        let tint_ab = |v: f32| {
            let mut img = grey_display(1, 1, v);
            apply(&mut img, 30.0, 80.0, 250.0, 80.0, 0.0);
            let lab = rec2020_to_oklab(img.pixels[0]);
            (lab[1], lab[2])
        };
        let (a_dark, _b_dark) = tint_ab(0.03);
        let (a_bright, b_bright) = tint_ab(0.95);
        assert!(
            a_dark > 0.01,
            "dark pixels must carry the warm shadow tint (a = {a_dark})"
        );
        assert!(
            b_bright < 0.0,
            "bright pixels must carry the cool highlight tint (b = {b_bright})"
        );
        assert!(
            a_bright < a_dark,
            "warm shadow tint must fade with luminance"
        );
    }

    /// Tone invariance on a ramp: L is untouched for every pixel, so the
    /// stage cannot retune brightness/contrast (only a/b move).
    #[test]
    fn l_invariant_across_ramp() {
        let mut img = Image::new(16, 1, ColorSpace::DisplayLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            let v = (i as f32 + 0.5) / 16.0;
            *p = [v, v, v];
        }
        let l_before: Vec<f32> = img.pixels.iter().map(|p| rec2020_to_oklab(*p)[0]).collect();
        apply(&mut img, 40.0, 70.0, 200.0, 70.0, 30.0);
        for (i, p) in img.pixels.iter().enumerate() {
            let l = rec2020_to_oklab(*p)[0];
            assert!(
                (l - l_before[i]).abs() < 1e-5,
                "L drifted at ramp step {i}: {} vs {}",
                l,
                l_before[i]
            );
        }
    }

    /// Non-neutral pixels shift by the same (a, b) vector as a grey of the
    /// same luminance — the stage reads Yd, not chroma, so existing color
    /// is offset, not rescaled.
    #[test]
    fn colored_pixel_shifts_like_grey_of_same_luma() {
        let rgb = [0.30f32, 0.42, 0.18];
        let yd = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = rgb;
        let lab_before = rec2020_to_oklab(rgb);
        apply(&mut img, 30.0, 60.0, 210.0, 40.0, 0.0);
        let lab_after = rec2020_to_oklab(img.pixels[0]);

        let (gamma, inv_gamma, s_vec, h_vec) = split_tone_params(30.0, 60.0, 210.0, 40.0, 0.0);
        let expected = split_tone_shift(yd, gamma, inv_gamma, s_vec, h_vec);
        assert!((lab_after[1] - lab_before[1] - expected[0]).abs() < 1e-5);
        assert!((lab_after[2] - lab_before[2] - expected[1]).abs() < 1e-5);
    }
}
