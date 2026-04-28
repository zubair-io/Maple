//! Closed-form + relational adjustment-validation tests on the synthetic
//! grey DNG. See spec
//! `docs/superpowers/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, render_from_raw, RenderQuality,
};
use raw_core::test_support::predictions::*;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Float tolerance for closed-form scene-linear assertions. Same budget
/// as `grey_invariants.rs` SCENE_LINEAR_EPS — demosaic + matrix-mul drift.
const EPS_SCENE_LINEAR: f32 = 5e-4;

/// 8-bit LSB tolerance for display-encoded neutrality (R=G=B preservation).
const EPS_DISPLAY_LSB: i32 = 2;

/// Synthesise a grey DNG at scene-linear `linear_value`, apply the
/// requested adjustments via `configure`, develop scene-linear, and
/// assert per-pixel R=G=B=predict(linear_value) within EPS_SCENE_LINEAR.
fn assert_predicted_scene_linear(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
    predict: impl Fn(f32) -> f32,
) {
    let dng = SyntheticGreyDng { linear_value, ..Default::default() };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    let expected = predict(linear_value);
    for (i, p) in img.pixels.iter().enumerate() {
        for c in 0..3 {
            assert!((p[c] - expected).abs() <= EPS_SCENE_LINEAR,
                "pixel {} chan {} = {} (predicted {}, |Δ| > {}) at L = {}",
                i, c, p[c], expected, EPS_SCENE_LINEAR, linear_value);
        }
    }
}

/// Synthesise + render through the full production pipeline (incl. AgX),
/// assert per-pixel R=G=B in u8 within EPS_DISPLAY_LSB.
fn assert_neutral_display(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
) {
    let dng = SyntheticGreyDng { linear_value, ..Default::default() };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let (w, h, rgb) = render_from_raw(&raw, &model)
        .expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    for i in 0..n {
        let r = rgb[i*3]     as i32;
        let g = rgb[i*3 + 1] as i32;
        let b = rgb[i*3 + 2] as i32;
        assert!((r - g).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-G|={} > {} (R={} G={} B={}) at L={}",
            i, (r-g).abs(), EPS_DISPLAY_LSB, r, g, b, linear_value);
        assert!((r - b).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-B|={} > {} (R={} G={} B={}) at L={}",
            i, (r-b).abs(), EPS_DISPLAY_LSB, r, g, b, linear_value);
    }
}

#[test]
fn exposure_plus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.exposure = 1.0, |s| predict_exposure(s, 1.0));
        assert_neutral_display(L, |m| m.exposure = 1.0);
    }
}
