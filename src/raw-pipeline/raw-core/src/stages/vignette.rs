//! Vignette — scene-linear radial gain (#1109, tone/zoom design § 10.1).
//!
//! Applies an elliptical, smoothstep-feathered EV gain anchored to the
//! render rect: negative `amount` darkens corners, positive lightens them.
//! Runs LATE in the scene chain (after `local_adjustments`, before the
//! output `sharpen`) so AgX's shoulder rolls the darkened / lightened
//! corners off filmically — the "highlight priority" look falls out of the
//! architecture instead of being a style option.
//!
//! ```text
//! nx   = (px + 0.5) · 2/fullW − 1          // [-1, 1] at the frame edges
//! ny   = (py + 0.5) · 2/fullH − 1
//! r    = √(nx² + ny²)                      // elliptical (aspect-matched)
//! m(r) = smoothstep(m0 − w/2, m0 + w/2, r) // m0 = 0.7 fixed midpoint
//! gain = exp2(K · amount/100 · m(r))       // K = 1.5 EV at ±100
//! ```
//!
//! `feather` (0–100) maps linearly onto the transition width `w` ∈
//! [0.05, 0.9]. Constants are the spec § 10.1 initial calibrated values.
//!
//! ## Anchoring (#1113 dependency)
//!
//! The spec anchors the ellipse to the USER crop rect. User crop does not
//! exist yet (§ 10.5, ticket #1113) — until it lands, the stage anchors to
//! the full render extent, which post-`crop_to_default` IS the DNG
//! DefaultCrop render rect. When #1113 lands, the geometry stage must hand
//! this stage the crop rect as the `(origin, full)` window below.
//!
//! ## Tile safety
//!
//! [`apply_windowed`] takes the buffer's origin within the full image plus
//! the full-image dimensions, so a tile render produces the exact pixels
//! of the corresponding full-frame render (a pure point op given the
//! window — no overlap needed). The WGSL port carries the same window as a
//! uniform. The gated tile entry (`pipeline::tile`, #11) currently refuses
//! engaged vignette because it does not thread the window yet — see the
//! guard in `pipeline/tile/mod.rs`.
//!
//! ## Grey-card gates (flatness waiver)
//!
//! Vignette is deliberately position-dependent, so the synthetic-grey
//! FLATNESS invariant is waived for this stage and replaced by
//! center-identity + corner-attenuation-formula assertions (see
//! `tests/grey_adjustments_display.rs` and
//! `test_support::predictions::predict_vignette`). At the frame center `m(r) = 0` exactly (smoothstep
//! clamps), so `gain = exp2(0) = 1.0` and the multiply is bit-exact
//! identity.

use crate::image::{ColorSpace, Image};

/// Fixed mask midpoint: the radius where the transition is centred.
pub const VIGNETTE_M0: f32 = 0.7;
/// Gain strength in EV at `amount = ±100` (spec § 10.1 initial value).
pub const VIGNETTE_K_EV: f32 = 1.5;
/// Transition width at `feather = 0` (near-hard edge).
pub const VIGNETTE_W_MIN: f32 = 0.05;
/// Transition width at `feather = 100` (soft over most of the frame).
pub const VIGNETTE_W_MAX: f32 = 0.9;

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Hoisted per-render parameters, shared by the stage, the predictor and
/// (transcribed) the WGSL kernel so all three derive the same floats in
/// the same order: `(e0, e1, ev)` — the smoothstep edges and the EV scale.
#[inline]
pub fn vignette_mask_params(amount: f32, feather: f32) -> (f32, f32, f32) {
    let width = VIGNETTE_W_MIN + (feather / 100.0) * (VIGNETTE_W_MAX - VIGNETTE_W_MIN);
    let e0 = VIGNETTE_M0 - width * 0.5;
    let e1 = VIGNETTE_M0 + width * 0.5;
    let ev = VIGNETTE_K_EV * amount / 100.0;
    (e0, e1, ev)
}

/// Per-pixel vignette gain at absolute full-image pixel `(px, py)` for a
/// `full = (w, h)` frame. `(e0, e1, ev)` from [`vignette_mask_params`].
/// Exposed for the closed-form predictor; the stage inlines the same math.
#[inline]
pub fn vignette_gain(px: u32, py: u32, full: (u32, u32), e0: f32, e1: f32, ev: f32) -> f32 {
    let inv_half_w = 2.0 / full.0 as f32;
    let inv_half_h = 2.0 / full.1 as f32;
    let nx = (px as f32 + 0.5) * inv_half_w - 1.0;
    let ny = (py as f32 + 0.5) * inv_half_h - 1.0;
    let r = (nx * nx + ny * ny).sqrt();
    let m = smoothstep(e0, e1, r);
    (ev * m).exp2()
}

/// Apply the vignette to a buffer that is a WINDOW of the full image:
/// `origin` is the buffer's top-left in full-image pixel coordinates and
/// `full` the full image dimensions. The whole-image entry [`apply`] is
/// `origin = (0, 0)`, `full = (img.width, img.height)`; a tile render
/// passes its rect so the gain field is identical to the full-frame one.
pub fn apply_windowed(
    img: &mut Image,
    amount: f32,
    feather: f32,
    origin: (u32, u32),
    full: (u32, u32),
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return; // identity short-circuit — bit-identical baseline
    }
    debug_assert!(full.0 > 0 && full.1 > 0, "vignette: zero full dims");

    let (e0, e1, ev) = vignette_mask_params(amount, feather);
    let inv_half_w = 2.0 / full.0 as f32;
    let inv_half_h = 2.0 / full.1 as f32;

    let w = img.width as usize;
    for (row_idx, row) in img.pixels.chunks_exact_mut(w).enumerate() {
        let py = origin.1 + row_idx as u32;
        let ny = (py as f32 + 0.5) * inv_half_h - 1.0;
        let ny2 = ny * ny;
        for (col_idx, p) in row.iter_mut().enumerate() {
            let px = origin.0 + col_idx as u32;
            let nx = (px as f32 + 0.5) * inv_half_w - 1.0;
            let r = (nx * nx + ny2).sqrt();
            let m = smoothstep(e0, e1, r);
            // m = 0 (inside the e0 radius) ⇒ gain = exp2(±0) = 1.0 exactly;
            // ×1.0 is bit-exact identity in IEEE f32, so the centre region
            // is untouched without needing a branch (the WGSL port relies
            // on the same property).
            let gain = (ev * m).exp2();
            p[0] *= gain;
            p[1] *= gain;
            p[2] *= gain;
        }
    }
}

/// Apply the vignette anchored to the buffer's own extent — the develop /
/// per-tick entry, where the buffer IS the (DefaultCrop) render rect.
pub fn apply(img: &mut Image, amount: f32, feather: f32) {
    let full = (img.width, img.height);
    apply_windowed(img, amount, feather, (0, 0), full);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};

    fn grey_image(w: u32, h: u32, v: f32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [v, v, v];
        }
        img
    }

    /// amount = 0 is a bit-identical no-op (the baseline guarantee).
    #[test]
    fn zero_amount_is_bit_identical() {
        let mut img = grey_image(16, 12, 0.18);
        let before = img.pixels.clone();
        apply(&mut img, 0.0, 50.0);
        assert_eq!(img.pixels, before);
    }

    /// The frame centre is bit-exact identity at ANY amount/feather: the
    /// centre radius is far inside e0 (≥ 0.25 at feather 100), so m = 0
    /// and the gain is exactly 1.0.
    #[test]
    fn center_is_bit_exact_identity() {
        for &(amount, feather) in &[
            (-100.0_f32, 0.0_f32),
            (100.0, 0.0),
            (-50.0, 100.0),
            (73.0, 100.0),
        ] {
            let mut img = grey_image(17, 13, 0.42);
            apply(&mut img, amount, feather);
            // centre pixel of a 17×13 buffer is (8, 6): nx = ny = 0 ⇒ r = 0.
            let c = img.pixels[6 * 17 + 8];
            assert_eq!(
                c,
                [0.42, 0.42, 0.42],
                "centre must be bit-exact identity at amount={amount} feather={feather}"
            );
        }
    }

    /// Corner attenuation matches the closed form exactly: the corner pixel
    /// sits at r ≈ √2 > e1 for default feather, so m = 1 and the gain is
    /// exp2(K·amount/100).
    #[test]
    fn corner_matches_formula() {
        let (w, h) = (64u32, 48u32);
        let mut img = grey_image(w, h, 0.5);
        apply(&mut img, -100.0, 50.0);
        let (e0, e1, ev) = vignette_mask_params(-100.0, 50.0);
        let expected_gain = vignette_gain(0, 0, (w, h), e0, e1, ev);
        let got = img.pixels[0][0] / 0.5;
        assert!(
            (got - expected_gain).abs() < 1e-6,
            "corner gain {got} != formula {expected_gain}"
        );
        // The corner of a 64×48 frame is beyond e1 = 0.9375 (r ≈ 1.39), so
        // the mask saturates: gain = exp2(−1.5) = 0.35355.
        assert!(
            (expected_gain - (-VIGNETTE_K_EV).exp2()).abs() < 1e-6,
            "corner must see the full −1.5 EV at amount −100, got {expected_gain}"
        );
    }

    /// Positive amount LIGHTENS corners (gain > 1), negative darkens.
    #[test]
    fn sign_convention() {
        let mut dark = grey_image(32, 32, 0.3);
        let mut light = grey_image(32, 32, 0.3);
        apply(&mut dark, -60.0, 50.0);
        apply(&mut light, 60.0, 50.0);
        assert!(
            dark.pixels[0][0] < 0.3,
            "negative amount must darken corners"
        );
        assert!(
            light.pixels[0][0] > 0.3,
            "positive amount must lighten corners"
        );
    }

    /// Wider feather pulls the transition INWARD: at a mid radius the
    /// mask engages earlier, so a darkening vignette darkens more there.
    #[test]
    fn feather_widens_transition() {
        let (w, h) = (100u32, 100u32);
        // Pixel at r ≈ 0.62 — inside the hard edge (e0 = 0.675 at feather
        // 0) but inside the soft band at feather 100 (e0 = 0.25).
        let (px, py) = (72u32, 72u32);
        let mut hard = grey_image(w, h, 0.4);
        let mut soft = grey_image(w, h, 0.4);
        apply(&mut hard, -100.0, 0.0);
        apply(&mut soft, -100.0, 100.0);
        let i = (py * w + px) as usize;
        assert_eq!(
            hard.pixels[i][0], 0.4,
            "feather 0 must leave r≈0.62 untouched (inside the hard edge)"
        );
        assert!(
            soft.pixels[i][0] < 0.4,
            "feather 100 must engage at r≈0.62 (soft band reaches inward)"
        );
    }

    /// The windowed entry is exact: rendering a sub-rect with the window
    /// produces byte-identical pixels to the same rect of the full render
    /// (the tile-safety contract).
    #[test]
    fn windowed_matches_full_render() {
        let (w, h) = (40u32, 30u32);
        let mut full = grey_image(w, h, 0.25);
        apply(&mut full, -80.0, 35.0);

        // A 10×8 tile at (24, 18).
        let (tx, ty, tw, th) = (24u32, 18u32, 10u32, 8u32);
        let mut tile = grey_image(tw, th, 0.25);
        apply_windowed(&mut tile, -80.0, 35.0, (tx, ty), (w, h));

        for y in 0..th {
            for x in 0..tw {
                let t = tile.pixels[(y * tw + x) as usize];
                let f = full.pixels[((ty + y) * w + (tx + x)) as usize];
                assert_eq!(t, f, "tile pixel ({x},{y}) diverges from full render");
            }
        }
    }

    /// Uniform per-pixel scalar ⇒ hue-preserving by construction: a
    /// non-neutral pixel keeps its channel ratios.
    #[test]
    fn hue_preserving_uniform_scale() {
        let mut img = Image::new(8, 8, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.6, 0.3, 0.1];
        }
        apply(&mut img, -100.0, 50.0);
        let corner = img.pixels[0];
        let ratio_rg = corner[0] / corner[1];
        let ratio_rb = corner[0] / corner[2];
        assert!(
            (ratio_rg - 2.0).abs() < 1e-5,
            "R/G ratio drifted: {ratio_rg}"
        );
        assert!(
            (ratio_rb - 6.0).abs() < 1e-5,
            "R/B ratio drifted: {ratio_rb}"
        );
    }
}
