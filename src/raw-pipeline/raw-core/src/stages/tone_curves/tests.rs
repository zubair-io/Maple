//! Tests for the tone-curve stage. Split out of `mod.rs` to keep both
//! files under the 600-LOC hard cap (per CONTRIBUTING.md). Visibility:
//! private functions on `mod.rs` are exposed to this file via the
//! `pub(super)` marker (or, where unchanged, via `super::*`); no
//! production code needs to be touched to make the tests compile.

#![cfg(test)]

use super::*;

/// The shared curve-editor parity anchor (#367).
///
/// The SwiftUI and Angular curve widgets each carry a port of
/// `eval_monotonic_cubic` so the plot draws the shape the pipeline
/// actually renders. This table is the contract between the three: the
/// same four knots, the same eleven samples, asserted here, in
/// `ToneCurveMathTests.swift` and in `tone-curve.spec.ts`. Any platform
/// that drifts fails its own copy of this test.
pub(crate) const PARITY_KNOTS: [(f32, f32); 4] =
    [(0.0, 0.0), (0.25, 0.15), (0.6, 0.72), (1.0, 1.0)];
pub(crate) const PARITY_SAMPLES: [f32; 11] = [
    0.000000, 0.047657, 0.103543, 0.215379, 0.386152, 0.570335, 0.720000, 0.816116, 0.883214,
    0.938705, 1.000000,
];

#[test]
fn monotonic_cubic_matches_the_cross_platform_parity_anchor() {
    let c = evaluator::prepare_curve(&ToneCurve::new(PARITY_KNOTS.to_vec()));
    for (i, expected) in PARITY_SAMPLES.iter().enumerate() {
        let x = i as f32 / 10.0;
        let got = evaluator::eval_monotonic_cubic(&c, x);
        assert!(
            (got - expected).abs() < 1e-5,
            "x={x}: expected {expected}, got {got}"
        );
    }
}

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
    assert!(
        p[0] < 2.5,
        "highlights pull expected at scene 2.5: {}",
        p[0]
    );
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
        assert!(
            out >= prev - 1e-5,
            "output regression at v={}: out={}, prev={}",
            v,
            out,
            prev
        );
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

// -----------------------------------------------------------------
// Ratio-preserving mode (ticket #436).
// -----------------------------------------------------------------

#[test]
fn ratio_preserving_default_model_is_identity() {
    // Default model: every per-channel curve is identity AND mode is
    // PerChannel (the default). Flipping mode alone must not change
    // anything when curves are identity.
    let mut img = fresh_img([0.7, 0.5, 0.3]);
    let mut m = model_default();
    m.tone_curve_mode = ToneCurveMode::RatioPreserving;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert_eq!(p, [0.7, 0.5, 0.3]);
}

#[test]
fn ratio_preserving_matches_per_channel_on_neutral_input() {
    // Neutral input (R = G = B): with the same curve applied to all
    // three lanes, both modes produce identical output.
    //
    // Under `PerChannel`: each lane lands on `curve(v)`, so RGB =
    // (curve(v), curve(v), curve(v)).
    //
    // Under `RatioPreserving`: Y_in = v (since R=G=B and luma weights
    // sum to 1); each curve_X(Y_in) = curve(v); Y_out = curve(v);
    // scale = curve(v)/v; RGB = (v·scale, v·scale, v·scale) =
    // (curve(v), curve(v), curve(v)).
    //
    // Identical by construction — verify empirically across several
    // curve shapes and scene values.
    for &v in &[0.1_f32, 0.3, 1.0, 2.0, 3.5] {
        let curve = ToneCurve::new(vec![
            (0.0, 0.0),
            (0.25, 0.5),
            (0.5, 0.6),
            (0.75, 0.8),
            (1.0, 1.0),
        ]);
        let mut img_pc = fresh_img([v, v, v]);
        let mut img_rp = fresh_img([v, v, v]);
        let mut m_pc = model_default();
        m_pc.tone_curve_red = curve.clone();
        m_pc.tone_curve_green = curve.clone();
        m_pc.tone_curve_blue = curve.clone();
        m_pc.tone_curve_mode = ToneCurveMode::PerChannel;
        let mut m_rp = m_pc.clone();
        m_rp.tone_curve_mode = ToneCurveMode::RatioPreserving;
        apply(&mut img_pc, &m_pc);
        apply(&mut img_rp, &m_rp);
        for ch in 0..3 {
            let a = img_pc.pixels[0][ch];
            let b = img_rp.pixels[0][ch];
            assert!(
                (a - b).abs() < 1e-4,
                "modes disagree on neutral v={} ch={}: per_channel={} ratio_preserving={}",
                v,
                ch,
                a,
                b
            );
        }
    }
}

#[test]
fn ratio_preserving_preserves_hue_on_saturated_input() {
    // Saturated input with only red curve lifted. The PerChannel
    // path drives R up while leaving G and B untouched — RGB ratios
    // shift, hue moves. The RatioPreserving path must keep R:G:B
    // ratios pinned to the input.
    let lift = ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.5), (1.0, 1.0)]);
    let input = [1.0_f32, 0.4, 0.2];
    let r_g_in = input[0] / input[1];
    let r_b_in = input[0] / input[2];
    let g_b_in = input[1] / input[2];

    // RatioPreserving: hue must hold.
    let mut img_rp = fresh_img(input);
    let mut m_rp = model_default();
    m_rp.tone_curve_red = lift.clone();
    m_rp.tone_curve_mode = ToneCurveMode::RatioPreserving;
    apply(&mut img_rp, &m_rp);
    let p_rp = img_rp.pixels[0];
    let r_g_rp = p_rp[0] / p_rp[1];
    let r_b_rp = p_rp[0] / p_rp[2];
    let g_b_rp = p_rp[1] / p_rp[2];
    assert!(
        (r_g_rp - r_g_in).abs() / r_g_in < 1e-4,
        "R/G drift in RatioPreserving: in={}, out={}",
        r_g_in,
        r_g_rp
    );
    assert!(
        (r_b_rp - r_b_in).abs() / r_b_in < 1e-4,
        "R/B drift in RatioPreserving: in={}, out={}",
        r_b_in,
        r_b_rp
    );
    assert!(
        (g_b_rp - g_b_in).abs() / g_b_in < 1e-4,
        "G/B drift in RatioPreserving: in={}, out={}",
        g_b_in,
        g_b_rp
    );

    // PerChannel: hue must NOT hold (negative-space check — the new
    // mode is only useful if the old one is empirically different
    // here).
    let mut img_pc = fresh_img(input);
    let mut m_pc = model_default();
    m_pc.tone_curve_red = lift;
    m_pc.tone_curve_mode = ToneCurveMode::PerChannel;
    apply(&mut img_pc, &m_pc);
    let p_pc = img_pc.pixels[0];
    let r_g_pc = p_pc[0] / p_pc[1];
    // The red lift pushes R up while G is unchanged — R/G must rise
    // measurably. Use a loose threshold (5%) so any monotonic-cubic
    // tweak that changes the exact lift amount doesn't break the test.
    assert!(
        (r_g_pc - r_g_in) / r_g_in > 0.05,
        "PerChannel did not shift hue (R/G in={} out={}) — the test setup is wrong",
        r_g_in,
        r_g_pc
    );
}

#[test]
fn ratio_preserving_negative_luma_passes_through() {
    // Negative luma pixels must pass through untouched in the new
    // mode — same contract as the existing luma-coupled paths.
    let curve = ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.5), (1.0, 1.0)]);
    let mut img = fresh_img([-0.5, -0.5, -0.5]);
    let mut m = model_default();
    m.tone_curve_red = curve.clone();
    m.tone_curve_green = curve.clone();
    m.tone_curve_blue = curve;
    m.tone_curve_mode = ToneCurveMode::RatioPreserving;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert_eq!(p, [-0.5, -0.5, -0.5]);
}

#[test]
fn ratio_preserving_all_identity_curves_is_noop() {
    // Mode flipped to RatioPreserving but every per-channel curve is
    // identity — the per-channel block short-circuits before the mode
    // check, so the pixel must be untouched.
    let mut img = fresh_img([0.8, 0.4, 0.2]);
    let mut m = model_default();
    m.tone_curve_mode = ToneCurveMode::RatioPreserving;
    apply(&mut img, &m);
    assert_eq!(img.pixels[0], [0.8, 0.4, 0.2]);
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
