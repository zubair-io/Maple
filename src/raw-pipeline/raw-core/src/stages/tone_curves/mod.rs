//! User-authored tone curves — parametric region sliders + per-channel
//! point curves (luma / R / G / B).
//!
//! Position in the pipeline: post-`scene_tone_controls`, pre-`vibrance`.
//! The scene-linear working space is Rec.2020 D65 at f32; the curve's
//! authoring `[0, 1]` domain maps to scene `[0, REF_MAX]` with
//! `REF_MAX = 4.0` (two stops above diffuse white, per
//! `docs/maple-paper.md` § 4.6 — covers AgX-friendly headroom without
//! truncating specular detail).
//!
//! Identity guarantee: this stage is a strict no-op when every
//! parametric region slider is zero AND every per-channel curve is
//! identity. The default `AdjustmentModel` satisfies both, so adding this
//! stage does not perturb the parity harness against the pre-#273
//! baseline.
//!
//! Curve evaluation: per-channel `tone_curve_*` fields use a
//! **Fritsch–Carlson monotonic cubic Hermite** interpolant. Monotonic in,
//! monotonic out: the standard catmull-rom / natural-cubic methods can
//! introduce overshoot between control points, which on a tone curve
//! manifests as a non-monotonic mapping (a brighter input pixel ends up
//! darker than its neighbour). That fails the user-mental-model
//! invariant for a tone curve and is fixed at the interpolant level in
//! [`evaluator::eval_monotonic_cubic`].
//!
//! Parametric curve: synthesises a piecewise-cubic over the four
//! canonical PV2012 region split points (0.25 / 0.5 / 0.75 in the
//! authoring domain). The luma-coupled application path mirrors
//! `scene_tone_controls`'s `highlights` step 2 — scale all three channels
//! by `Y_new / Y_old` — so hue is preserved by construction. The
//! per-channel `tone_curve_{red,green,blue}` paths intentionally do NOT
//! preserve hue: cross-channel cast control is their purpose (ticket #273).

mod evaluator;

use evaluator::{eval_curve_scene_linear, prepare_curve, prepare_curve_from_slice};

use crate::{
    image::{ColorSpace, Image},
    types::adjustment::{ToneCurve, ToneCurvePoint},
    xmp::AdjustmentModel,
};

/// Rec.2020 luma weights — same coefficients used by `scene_tone_controls`
/// for hue-preserving luminance coupling.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Smallest parametric slider magnitude considered non-identity. Same
/// threshold as the existing `scene_tone_controls` short-circuits — keeps
/// "round-trip a sidecar without changes" bit-identical to the pre-stage
/// pipeline output.
const PARAMETRIC_EPSILON: f32 = 1e-3;

// ---------------------------------------------------------------------
// Public stage entry point
// ---------------------------------------------------------------------

/// Apply parametric region sliders + per-channel point curves.
///
/// Order within the stage:
/// 1. Parametric curve (luma-coupled — hue-preserving)
/// 2. `tone_curve_luma` point curve (luma-coupled — hue-preserving)
/// 3. `tone_curve_red`, `tone_curve_green`, `tone_curve_blue` point
///    curves (per-channel — hue NOT preserved, intentionally)
///
/// Each sub-step short-circuits independently when its inputs are
/// identity. The overall stage is a no-op when every region slider is
/// zero (within `PARAMETRIC_EPSILON`) AND every curve is identity.
pub fn apply(img: &mut Image, model: &AdjustmentModel) {
    img.assert_space(ColorSpace::SceneLinearRec2020);

    let parametric_active = model.parametric_highlights.abs() >= PARAMETRIC_EPSILON
        || model.parametric_lights.abs() >= PARAMETRIC_EPSILON
        || model.parametric_darks.abs() >= PARAMETRIC_EPSILON
        || model.parametric_shadows.abs() >= PARAMETRIC_EPSILON;

    if parametric_active {
        apply_parametric_luma_coupled(img, model);
    }

    if !model.tone_curve_luma.is_identity() {
        apply_point_curve_luma_coupled(img, &model.tone_curve_luma);
    }

    // Per-channel curves apply independently per RGB lane (intentional —
    // see module doc). Each sub-call short-circuits on identity.
    apply_point_curve_per_channel(img, &model.tone_curve_red, 0);
    apply_point_curve_per_channel(img, &model.tone_curve_green, 1);
    apply_point_curve_per_channel(img, &model.tone_curve_blue, 2);
}

// ---------------------------------------------------------------------
// Parametric region sliders → synthesised curve, luma-coupled apply
// ---------------------------------------------------------------------

/// Build a 5-knot parametric curve from the four region sliders. Knots
/// live in `[0, 1]` authoring space at `(0.0, 0.25, 0.5, 0.75, 1.0)`.
///
/// Each region slider lives on a `[-100, 100]` scale; we normalise to
/// `[-1, 1]` and scale the knot displacement by `0.25` so the maximum
/// vertical excursion at any knot is ¼ of the authoring range — picked
/// to match the perceptual feel of the reference renderer's PV2012
/// parametric sliders on the calibration scenes (shadows lift up to
/// `+0.25` at the 0.25 knot under shadows=+100).
///
/// The shadows / darks pair operates symmetrically around the 0.25 knot:
/// shadows shifts the (0.25, 0.25) knot vertically; darks shifts the
/// (0.5, 0.5) knot. Lights / highlights mirror this around the upper end.
/// Endpoints stay pinned at (0, 0) and (1, 1) — the parametric curve does
/// not extend the dynamic range.
///
/// **Monotonicity clamp.** Fritsch–Carlson interpolation requires the
/// input knots to be monotonic in `y`. Conflicting slider combinations
/// can synthesise non-monotonic knots — e.g. `shadows = +100` lifts the
/// (0.25, _) knot toward 0.5 while `darks = -100, lights = -100` pulls
/// the (0.5, _) knot down toward 0.25. We resolve by clamping each knot
/// to the cumulative max so far: a later knot can never sit lower than
/// the previous one. This preserves user intent within monotonic bounds —
/// the earlier slider "wins" against the conflicting later one, which is
/// the same behavior PV2012's reference parametric curve exhibits when
/// pushed past its smooth region.
fn build_parametric_knots(model: &AdjustmentModel) -> [ToneCurvePoint; 5] {
    let s = model.parametric_shadows / 100.0;
    let d = model.parametric_darks / 100.0;
    let l = model.parametric_lights / 100.0;
    let h = model.parametric_highlights / 100.0;

    // Scale chosen to keep the curve smooth — at full +100 / -100 the
    // knot moves by 0.25 in authoring space, which on the upper region
    // corresponds to scene `1.0 → 2.0` and on the lower region to scene
    // `1.0 → 0.0`. Beyond this the monotonic cubic begins to over-pull.
    let knot_amplitude = 0.25;

    let mut knots: [ToneCurvePoint; 5] = [
        (0.0, 0.0),
        (0.25, 0.25 + s * knot_amplitude),
        (0.5, 0.5 + (d + l) * 0.5 * knot_amplitude),
        (0.75, 0.75 + h * knot_amplitude),
        (1.0, 1.0),
    ];

    // Monotonicity guard. Left-to-right cumulative-max pass: ensures
    // each `y_i` is at least the previous `y_{i-1}`. Endpoints stay
    // pinned at 0 and 1 by construction; only interior knots can move.
    // Also clamps each knot into `[0, 1]` so the evaluator's authoring
    // domain stays valid.
    for i in 1..knots.len() {
        let lo = knots[i - 1].1;
        if knots[i].1 < lo {
            knots[i].1 = lo;
        }
        knots[i].1 = knots[i].1.clamp(0.0, 1.0);
    }

    knots
}

/// Apply the synthesised parametric curve in scene-linear with luma
/// coupling. Mirrors the per-pixel pattern from
/// `scene_tone_controls::apply`'s `highlights` step 2 — scale all three
/// channels by `Y_new / Y_old` — so hue is preserved by construction.
fn apply_parametric_luma_coupled(img: &mut Image, model: &AdjustmentModel) {
    let knots = build_parametric_knots(model);
    // Prepare once — Fritsch–Carlson slopes + tangents are computed here,
    // not per-pixel.
    let prepared = prepare_curve_from_slice(&knots);

    for p in &mut img.pixels {
        let y_old = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if y_old <= 0.0 {
            // Zero / negative luma — leave the pixel alone. The curve
            // evaluator's authoring domain starts at 0; mapping a
            // negative scene value through the curve would extrapolate
            // outside the authored knots.
            continue;
        }
        let y_new = eval_curve_scene_linear(&prepared, y_old);
        let scale = y_new / y_old;
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    }
}

// ---------------------------------------------------------------------
// Point curves — luma-coupled apply (for `tone_curve_luma`)
// ---------------------------------------------------------------------

/// Apply a user-authored point curve in scene-linear, channels-uniformly
/// via the Rec.2020 luma scale factor. Identical hue-preservation pattern
/// as `apply_parametric_luma_coupled` and `scene_tone_controls`'s
/// highlights step 2.
fn apply_point_curve_luma_coupled(img: &mut Image, curve: &ToneCurve) {
    // Prepare once — the evaluator requires x-monotonic input and the
    // Fritsch–Carlson slopes / tangents are computed at prepare time,
    // not per-pixel. The per-pixel inner loop reads from the
    // `PreparedCurve` without allocating.
    let prepared = prepare_curve(curve);

    for p in &mut img.pixels {
        let y_old = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if y_old <= 0.0 {
            continue;
        }
        let y_new = eval_curve_scene_linear(&prepared, y_old);
        let scale = y_new / y_old;
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    }
}

// ---------------------------------------------------------------------
// Point curves — per-channel apply (for tone_curve_{red,green,blue})
// ---------------------------------------------------------------------

/// Apply a user-authored point curve to a single channel lane. Per-channel
/// curves intentionally shift hue — that is their purpose (cross-channel
/// cast control per the ticket).
///
/// `channel` is `0` for R, `1` for G, `2` for B.
fn apply_point_curve_per_channel(img: &mut Image, curve: &ToneCurve, channel: usize) {
    if curve.is_identity() {
        return;
    }
    debug_assert!(channel < 3, "channel must be 0/1/2");
    let prepared = prepare_curve(curve);

    for p in &mut img.pixels {
        let v = p[channel];
        if v <= 0.0 {
            continue;
        }
        p[channel] = eval_curve_scene_linear(&prepared, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_img(value: [f32; 3]) -> Image {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = value;
        }
        img
    }

    fn model_default() -> AdjustmentModel {
        AdjustmentModel::default()
    }

    // -----------------------------------------------------------------
    // Identity guarantees — the single most important invariant for this
    // stage. A default model must round-trip every pixel unchanged.
    // -----------------------------------------------------------------

    #[test]
    fn default_model_is_identity_on_midgray() {
        let mut img = fresh_img([0.18, 0.18, 0.18]);
        apply(&mut img, &model_default());
        for &c in &img.pixels[0] {
            assert!((c - 0.18).abs() < 1e-6, "midgray drifted to {}", c);
        }
    }

    #[test]
    fn default_model_is_identity_on_specular() {
        // 2.0 (one stop above diffuse white) must pass through unchanged.
        let mut img = fresh_img([2.0, 1.5, 0.5]);
        apply(&mut img, &model_default());
        let p = img.pixels[0];
        assert!((p[0] - 2.0).abs() < 1e-6);
        assert!((p[1] - 1.5).abs() < 1e-6);
        assert!((p[2] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn default_model_is_identity_on_zero() {
        let mut img = fresh_img([0.0, 0.0, 0.0]);
        apply(&mut img, &model_default());
        for &c in &img.pixels[0] {
            assert_eq!(c, 0.0);
        }
    }

    #[test]
    fn empty_curve_is_identity() {
        // The per-channel skip path is the hot one for the default
        // model — explicit smoke test that `is_identity()` short-circuits
        // before any allocation happens.
        let mut img = fresh_img([0.3, 0.4, 0.5]);
        let curve = ToneCurve::default();
        apply_point_curve_per_channel(&mut img, &curve, 0);
        apply_point_curve_per_channel(&mut img, &curve, 1);
        apply_point_curve_per_channel(&mut img, &curve, 2);
        assert_eq!(img.pixels[0], [0.3, 0.4, 0.5]);
    }

    // -----------------------------------------------------------------
    // Per-channel curve — hue NOT preserved (intentional)
    // -----------------------------------------------------------------

    #[test]
    fn per_channel_red_curve_lifts_only_red() {
        // Red curve that lifts 0.25 → 0.5 in authoring domain. Use a
        // brighter input (scene 1.0 → authoring 0.25) to make the effect
        // visible.
        let lift = ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.5), (1.0, 1.0)]);
        let mut img = fresh_img([1.0, 1.0, 1.0]); // authoring x = 0.25
        let mut m = model_default();
        m.tone_curve_red = lift;
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!(p[0] > 1.4, "red should lift substantially: {}", p[0]);
        assert!((p[1] - 1.0).abs() < 1e-5, "green unchanged");
        assert!((p[2] - 1.0).abs() < 1e-5, "blue unchanged");
    }

    // -----------------------------------------------------------------
    // Parametric curve — region-specific behavior
    // -----------------------------------------------------------------

    #[test]
    fn parametric_shadows_lifts_dark_pixels() {
        let mut img = fresh_img([0.05, 0.05, 0.05]);
        let mut m = model_default();
        m.parametric_shadows = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // Shadows lift expected; exact value depends on the synthesised
        // curve's monotonic-cubic interpolation through the moved knot.
        assert!(p[0] > 0.05, "shadows lift expected at scene 0.05: {}", p[0]);
        assert!((p[0] - p[1]).abs() < 1e-5);
        assert!((p[1] - p[2]).abs() < 1e-5);
    }

    #[test]
    fn parametric_highlights_pulls_bright_pixels_down() {
        let mut img = fresh_img([2.5, 2.5, 2.5]);
        let mut m = model_default();
        m.parametric_highlights = -100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!(p[0] < 2.5, "highlights pull expected at scene 2.5: {}", p[0]);
        assert!((p[0] - p[1]).abs() < 1e-5);
        assert!((p[1] - p[2]).abs() < 1e-5);
    }

    #[test]
    fn parametric_conflicting_sliders_produce_monotonic_curve() {
        // Shadows = +100 lifts knot (0.25, y) toward 0.5; darks = -100
        // (combined with lights = -100) pulls knot (0.5, y) toward 0.25.
        // Pre-fix, the synthesised knots were non-monotonic: y_at_0.5
        // landed below y_at_0.25 and Fritsch–Carlson's monotonicity
        // contract was violated. Post-fix, the cumulative-max clamp
        // pins knot (0.5, _) to at least y_at_0.25 — earlier slider
        // wins, output is monotonic. Verify by sampling the synthesised
        // knots directly and by checking a monotonic input → monotonic
        // output across a sweep of pixel values.
        let mut m = model_default();
        m.parametric_shadows = 100.0;
        m.parametric_darks = -100.0;
        m.parametric_lights = -100.0;
        let knots = build_parametric_knots(&m);
        for w in knots.windows(2) {
            assert!(
                w[1].1 >= w[0].1 - 1e-6,
                "non-monotonic knots: {:?} → {:?}",
                w[0],
                w[1]
            );
        }
        // End-to-end: monotonically increasing scene values must stay
        // monotonic after the parametric stage.
        let mut prev = f32::NEG_INFINITY;
        for i in 0..40 {
            let v = i as f32 * 0.1;
            let mut img = fresh_img([v, v, v]);
            apply(&mut img, &m);
            let out = img.pixels[0][0];
            assert!(out >= prev - 1e-5, "output regression at v={}: out={}, prev={}", v, out, prev);
            prev = out;
        }
    }

    #[test]
    fn parametric_preserves_hue_on_colorful_input() {
        // Parametric application is luma-coupled — RGB ratios must be
        // preserved across any parametric setting.
        let mut img = fresh_img([0.8, 0.4, 0.2]);
        let mut m = model_default();
        m.parametric_shadows = 50.0;
        m.parametric_lights = -25.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let r_g = p[0] / p[1];
        let r_b = p[0] / p[2];
        assert!(
            (r_g - 2.0).abs() / 2.0 < 0.01,
            "R/G ratio drifted from 2.0 to {}",
            r_g
        );
        assert!(
            (r_b - 4.0).abs() / 4.0 < 0.01,
            "R/B ratio drifted from 4.0 to {}",
            r_b
        );
    }

    #[test]
    fn parametric_all_zero_is_strict_identity() {
        // Even when an unrelated field on the model is non-default,
        // all-zero region sliders must skip the loop entirely. Important
        // for the harness — every non-curve-using fixture must pass
        // through unchanged.
        let mut img = fresh_img([0.7, 0.5, 0.3]);
        let mut m = model_default();
        m.exposure = 0.5; // unrelated; doesn't trigger this stage
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert_eq!(p, [0.7, 0.5, 0.3]);
    }

    // -----------------------------------------------------------------
    // Luma curve — same hue-preservation contract as parametric
    // -----------------------------------------------------------------

    #[test]
    fn luma_curve_preserves_hue() {
        let curve = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.7), (1.0, 1.0)]);
        let mut img = fresh_img([0.8, 0.4, 0.2]);
        let mut m = model_default();
        m.tone_curve_luma = curve;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let r_g = p[0] / p[1];
        let r_b = p[0] / p[2];
        assert!((r_g - 2.0).abs() / 2.0 < 0.01, "R/G drifted: {}", r_g);
        assert!((r_b - 4.0).abs() / 4.0 < 0.01, "R/B drifted: {}", r_b);
    }

    // -----------------------------------------------------------------
    // Edge cases — non-negative outputs, zero / negative inputs
    // -----------------------------------------------------------------

    #[test]
    fn negative_scene_input_skips_luma_path() {
        // The luma-coupled path early-returns on Y <= 0 (the curve's
        // authoring domain starts at 0). Negative scene values pass
        // through untouched — they can't go more negative.
        let mut img = fresh_img([-0.1, -0.1, -0.1]);
        let mut m = model_default();
        m.parametric_shadows = 100.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [-0.1, -0.1, -0.1]);
    }

    #[test]
    fn per_channel_negative_input_passes_through() {
        // Per-channel path mirrors the same guard — negative scene
        // values can't be mapped through the [0, 1] authoring curve, so
        // we pass them through untouched.
        let curve = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.9), (1.0, 1.0)]);
        let mut img = fresh_img([-0.1, 0.5, -0.05]);
        let mut m = model_default();
        m.tone_curve_red = curve.clone();
        m.tone_curve_blue = curve;
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert_eq!(p[0], -0.1, "negative R untouched");
        assert!((p[1] - 0.5).abs() < 1e-5, "G unchanged (no green curve)");
        assert_eq!(p[2], -0.05, "negative B untouched");
    }
}
