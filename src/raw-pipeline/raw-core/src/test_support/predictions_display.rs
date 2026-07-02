//! Closed-form predictors for the position-aware / display-tail stages
//! (vignette #1109, grain #1110, split toning #1111 — tone/zoom design
//! § 10.1–10.3). Split out of the sibling `predictions.rs` when those
//! landings pushed it over the 600-LOC hard cap (#1170) — pure relocation,
//! math unchanged. Re-exported from `predictions` so existing
//! `predictions::*` glob consumers keep resolving every predictor.

/// stages::vignette::apply (#1109, tone/zoom design § 10.1) — POSITION-AWARE
/// closed form: the gain at absolute pixel `(x, y)` of a `w × h` frame.
///
/// This stage deliberately breaks the flat-field assumption every other
/// predictor leans on, so the synthetic-grey FLATNESS invariant is waived
/// for it (spec § 10.1) and replaced by center-identity + corner-formula
/// assertions built on this predictor (see
/// `tests/grey_adjustments_display.rs`).
///
/// Mirrors `vignette_mask_params` + `vignette_gain` exactly:
///   nx = (x + 0.5)·2/w − 1, ny = (y + 0.5)·2/h − 1, r = √(nx² + ny²)
///   m  = smoothstep(0.7 − fw/2, 0.7 + fw/2, r), fw = 0.05 + f/100·0.85
///   out = scene · exp2(1.5 · amount/100 · m)
pub fn predict_vignette(
    scene: f32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    amount: f32,
    feather: f32,
) -> f32 {
    if amount.abs() < 1e-3 {
        return scene;
    }
    let (e0, e1, ev) = crate::stages::vignette::vignette_mask_params(amount, feather);
    scene * crate::stages::vignette::vignette_gain(x, y, (w, h), e0, e1, ev)
}

/// stages::grain::apply (#1110, tone/zoom design § 10.2) — POSITION-AWARE
/// closed form on a neutral display-linear pixel `Yd = display_value`:
///
///   out = Yd + K·amount/100 · clamp(4·Yd·(1−Yd), 0, 1) · n(x, y)
///
/// `n` is the DETERMINISTIC hash-noise field (`stages::grain::grain_noise`
/// — fixed seed, no RNG), so this predictor is exact per pixel, not
/// statistical. Like vignette, the synthetic-grey FLATNESS invariant is
/// waived (spec § 10.2); the gates are mean preservation + the predicted
/// (deterministic) deviation — see `stages::grain::tests` and
/// `tests/grey_adjustments_display.rs`. The cross-RESOLUTION contract stays
/// statistical: the field re-samples per render size.
pub fn predict_grain(
    display_value: f32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    amount: f32,
    size: f32,
    roughness: f32,
) -> f32 {
    if amount.abs() < 1e-3 {
        return display_value;
    }
    let (k, inv_pitch, rho) = crate::stages::grain::grain_params(amount, size, roughness, w.max(h));
    let n = crate::stages::grain::grain_noise(x, y, inv_pitch, rho);
    let wl = (4.0 * display_value * (1.0 - display_value)).clamp(0.0, 1.0);
    display_value + k * wl * n
}

/// stages::split_tone::apply (#1111, tone/zoom design § 10.3) — the exact
/// Oklab (Δa, Δb) shift on a grey pixel at display luminance `yd`:
///
///   γ = exp2(bal/100); wS = (1−Yd)^γ·sS/100; wH = Yd^(1/γ)·sH/100
///   (Δa, Δb) = K·[wS·(cos hS, sin hS) + wH·(cos hH, sin hH)]
///
/// L is untouched by the stage, so the predictor returns only the chroma
/// shift. Hues in degrees. Used by the grey gates: a neutral pixel's
/// post-stage Oklab (a, b) must equal exactly this shift (its pre-stage
/// chroma is ~0), and L must be invariant.
pub fn predict_split_tone_ab(
    yd: f32,
    shadow_hue: f32,
    shadow_sat: f32,
    highlight_hue: f32,
    highlight_sat: f32,
    balance: f32,
) -> [f32; 2] {
    if shadow_sat.abs() < 1e-3 && highlight_sat.abs() < 1e-3 {
        return [0.0, 0.0];
    }
    let (gamma, inv_gamma, s_vec, h_vec) = crate::stages::split_tone::split_tone_params(
        shadow_hue,
        shadow_sat,
        highlight_hue,
        highlight_sat,
        balance,
    );
    crate::stages::split_tone::split_tone_shift(yd, gamma, inv_gamma, s_vec, h_vec)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `predict_vignette` round-trips against the real stage at sampled
    /// coordinates: a uniform grey image through `vignette::apply` must
    /// land every sampled pixel on the position-aware closed form. (The
    /// flat-field round-trip the other predictors use is waived — vignette
    /// is position-dependent by design, spec § 10.1.)
    #[test]
    fn vignette_predictor_matches_stage_at_sampled_coords() {
        use crate::image::{ColorSpace, Image};
        use crate::stages::vignette;

        let (w, h) = (48u32, 36u32);
        for &(amount, feather) in &[(-100.0_f32, 0.0_f32), (-50.0, 50.0), (75.0, 100.0)] {
            let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for p in &mut img.pixels {
                *p = [0.18, 0.18, 0.18];
            }
            vignette::apply(&mut img, amount, feather);
            // Centre, corner, edge midpoints, and an in-band sample.
            for &(x, y) in &[(24u32, 18u32), (0, 0), (47, 35), (24, 0), (0, 18), (40, 30)] {
                let predicted = predict_vignette(0.18, x, y, w, h, amount, feather);
                let got = img.pixels[(y * w + x) as usize];
                for c in 0..3 {
                    assert!(
                        (got[c] - predicted).abs() < 1e-6,
                        "predict_vignette(0.18, {x}, {y}, {w}, {h}, {amount}, {feather}) = \
                         {predicted}, stage produced {} (chan {c})",
                        got[c]
                    );
                }
            }
        }
    }

    /// Centre identity is exact (m = 0 ⇒ gain = exp2(0) = 1.0): the
    /// predictor must return the input bit-for-bit at the frame centre.
    #[test]
    fn vignette_predictor_center_identity() {
        let v = predict_vignette(0.42, 50, 50, 101, 101, -100.0, 100.0);
        assert_eq!(v, 0.42, "centre pixel must be exact identity");
    }

    /// `predict_grain` round-trips against the real stage at sampled
    /// coordinates on a uniform display-linear card (exact — the field is
    /// deterministic).
    #[test]
    fn grain_predictor_matches_stage_at_sampled_coords() {
        use crate::image::{ColorSpace, Image};
        use crate::stages::grain;

        let (w, h) = (48u32, 36u32);
        let v = 0.4f32;
        let mut img = Image::new(w, h, ColorSpace::DisplayLinearRec2020);
        for p in &mut img.pixels {
            *p = [v, v, v];
        }
        grain::apply(&mut img, 80.0, 40.0, 60.0);
        for &(x, y) in &[(0u32, 0u32), (24, 18), (47, 35), (13, 7)] {
            let predicted = predict_grain(v, x, y, w, h, 80.0, 40.0, 60.0);
            let got = img.pixels[(y * w + x) as usize];
            for c in 0..3 {
                assert!(
                    (got[c] - predicted).abs() < 1e-6,
                    "predict_grain at ({x},{y}) chan {c}: got {}, predicted {predicted}",
                    got[c]
                );
            }
        }
    }

    /// `predict_split_tone_ab` round-trips against the real stage on grey
    /// display-linear pixels at several luminances and balances.
    #[test]
    fn split_tone_predictor_matches_stage_on_grey() {
        use crate::color::oklab::rec2020_to_oklab;
        use crate::image::{ColorSpace, Image};
        use crate::stages::split_tone;

        for &(v, hs, ss, hh, sh, bal) in &[
            (0.05_f32, 30.0_f32, 80.0_f32, 210.0_f32, 60.0_f32, 0.0_f32),
            (0.18, 30.0, 80.0, 210.0, 60.0, 50.0),
            (0.80, 300.0, 40.0, 120.0, 90.0, -100.0),
        ] {
            let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
            img.pixels[0] = [v, v, v];
            let lab_before = rec2020_to_oklab(img.pixels[0]);
            split_tone::apply(&mut img, hs, ss, hh, sh, bal);
            let lab_after = rec2020_to_oklab(img.pixels[0]);

            let yd = 0.2627 * v + 0.6780 * v + 0.0593 * v;
            let predicted = predict_split_tone_ab(yd, hs, ss, hh, sh, bal);
            assert!(
                (lab_after[1] - lab_before[1] - predicted[0]).abs() < 1e-5,
                "Δa at v={v}: got {}, predicted {}",
                lab_after[1] - lab_before[1],
                predicted[0]
            );
            assert!(
                (lab_after[2] - lab_before[2] - predicted[1]).abs() < 1e-5,
                "Δb at v={v}: got {}, predicted {}",
                lab_after[2] - lab_before[2],
                predicted[1]
            );
            assert!(
                (lab_after[0] - lab_before[0]).abs() < 1e-5,
                "L must be invariant"
            );
        }
    }
}
