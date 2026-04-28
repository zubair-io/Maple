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

#[test]
fn exposure_minus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.exposure = -1.0, |s| predict_exposure(s, -1.0));
        assert_neutral_display(L, |m| m.exposure = -1.0);
    }
}

#[test]
fn shadows_plus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.shadows = 50.0, |s| predict_shadows(s, 50.0));
        assert_neutral_display(L, |m| m.shadows = 50.0);
    }
}

#[test]
fn shadows_minus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.shadows = -50.0, |s| predict_shadows(s, -50.0));
        assert_neutral_display(L, |m| m.shadows = -50.0);
    }
}

#[test]
fn whites_plus50_predicts() {
    for L in [0.18, 0.50, 0.80] {
        assert_predicted_scene_linear(L, |m| m.whites = 50.0, |s| predict_whites(s, 50.0));
        assert_neutral_display(L, |m| m.whites = 50.0);
    }
}

#[test]
fn whites_minus50_predicts() {
    for L in [0.18, 0.50, 0.80] {
        assert_predicted_scene_linear(L, |m| m.whites = -50.0, |s| predict_whites(s, -50.0));
        assert_neutral_display(L, |m| m.whites = -50.0);
    }
}

#[test]
fn blacks_plus50_predicts() {
    for L in [0.05, 0.18, 0.30] {
        assert_predicted_scene_linear(L, |m| m.blacks = 50.0, |s| predict_blacks(s, 50.0));
        assert_neutral_display(L, |m| m.blacks = 50.0);
    }
}

#[test]
fn blacks_minus50_predicts() {
    for L in [0.05, 0.18, 0.30] {
        assert_predicted_scene_linear(L, |m| m.blacks = -50.0, |s| predict_blacks(s, -50.0));
        assert_neutral_display(L, |m| m.blacks = -50.0);
    }
}

#[test]
fn saturation_no_op_on_neutral() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.saturation = 50.0, |s| predict_saturation(s, 50.0));
        assert_predicted_scene_linear(L, |m| m.saturation = -50.0, |s| predict_saturation(s, -50.0));
        assert_neutral_display(L, |m| m.saturation = 50.0);
    }
}

#[test]
fn vibrance_no_op_on_neutral() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.vibrance = 50.0, |s| predict_vibrance(s, 50.0));
        assert_predicted_scene_linear(L, |m| m.vibrance = -50.0, |s| predict_vibrance(s, -50.0));
        assert_neutral_display(L, |m| m.vibrance = 50.0);
    }
}

/// Develop the synthetic L=0.18 grey to scene-linear with the given
/// adjustments and return a representative pixel (everything is uniform
/// for a flat synthetic input, so any pixel works — we read pixel 32×32).
fn scene_linear_pixel(configure: impl FnOnce(&mut AdjustmentModel)) -> [f32; 3] {
    let dng = SyntheticGreyDng::default();
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full).unwrap();
    img.pixels[32 * 64 + 32]
}

#[test]
fn temp_warmer_makes_r_gt_b() {
    let p = scene_linear_pixel(|m| m.temperature = 7500.0);
    assert!(p[0] > p[2], "temp+1000K should warm: R={} should exceed B={}", p[0], p[2]);
    assert!(p[0] > p[1], "temp+1000K should warm: R={} should exceed G={}", p[0], p[1]);
}

#[test]
fn temp_cooler_makes_b_gt_r() {
    let p = scene_linear_pixel(|m| m.temperature = 5500.0);
    assert!(p[2] > p[0], "temp-1000K should cool: B={} should exceed R={}", p[2], p[0]);
    assert!(p[2] > p[1], "temp-1000K should cool: B={} should exceed G={}", p[2], p[1]);
}

#[test]
fn temp_symmetric() {
    // |R-B| at +1000K vs -1000K: same order of magnitude. The WB curve
    // is not perfectly linear in K (the cool side produces a larger
    // magnitude shift than the warm side at ±1000K), so we just lock
    // down "no sign flip and no 5x asymmetry" as a regression net.
    let warm = scene_linear_pixel(|m| m.temperature = 7500.0);
    let cool = scene_linear_pixel(|m| m.temperature = 5500.0);
    let warm_delta = (warm[0] - warm[2]).abs();
    let cool_delta = (cool[0] - cool[2]).abs();
    let ratio = warm_delta / cool_delta;
    assert!(ratio > 0.3 && ratio < 3.0,
        "WB +/-1000K asymmetry: warm |R-B|={}, cool |R-B|={}, ratio={}",
        warm_delta, cool_delta, ratio);
}

/// Tint follows ACR convention: tint>0 = magenta (R+B grows vs 2G),
/// tint<0 = green (R+B shrinks vs 2G).
///
/// **Known failure:** Maple currently inverts this — these two tests
/// fail today because the production tint sign is wrong. The test
/// failure is the alert. See spawned investigation task; do not flip
/// the assertion to make this pass.
#[test]
fn tint_plus_pushes_magenta() {
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| m.tint = 50.0);
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff  = (p[0]         + p[2])         - 2.0 * p[1];
    assert!(tinted_diff > default_diff,
        "tint+50 should grow R+B vs 2G (ACR convention: magenta): \
         default {} → tinted {}. If this fails, Maple's tint sign is \
         inverted vs ACR — investigate, do not flip the assertion.",
        default_diff, tinted_diff);
}

#[test]
fn tint_minus_pushes_green() {
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| m.tint = -50.0);
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff  = (p[0]         + p[2])         - 2.0 * p[1];
    assert!(tinted_diff < default_diff,
        "tint-50 should shrink R+B vs 2G (ACR convention: green): \
         default {} → tinted {}. If this fails, Maple's tint sign is \
         inverted vs ACR — investigate, do not flip the assertion.",
        default_diff, tinted_diff);
}

#[test]
fn contrast_plus_creates_s_curve() {
    // Contrast is AgX-internal — assert direction in display-encoded u8.
    // Above-midtone values should brighten; below-midtone should darken.
    fn render_mean(L: f32, configure: impl FnOnce(&mut AdjustmentModel)) -> u8 {
        let dng = SyntheticGreyDng { linear_value: L, ..Default::default() };
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let s: u32 = (0..n).map(|i| rgb[i*3] as u32).sum();
        ((s + n as u32 / 2) / n as u32) as u8
    }
    let above_default  = render_mean(0.50, |_| {});
    let above_contrast = render_mean(0.50, |m| m.contrast = 50.0);
    let below_default  = render_mean(0.05, |_| {});
    let below_contrast = render_mean(0.05, |m| m.contrast = 50.0);
    assert!(above_contrast > above_default,
        "contrast+50 at L=0.50 should brighten: {} → {}", above_default, above_contrast);
    assert!(below_contrast < below_default,
        "contrast+50 at L=0.05 should darken: {} → {}", below_default, below_contrast);
}

/// Print the per-channel u8 mean for every adjustment case the Apple
/// UITest covers. Run with `--ignored --nocapture` to dump; the integers
/// it prints get hard-coded into SyntheticGreyUITests.swift's `cases[]`.
///
/// Run:
///   cargo test -p raw-core --features test-support --test grey_adjustments \
///       dump_display_means -- --ignored --nocapture
#[test]
#[ignore]
fn dump_display_means() {
    fn mean(label: &str, configure: impl FnOnce(&mut AdjustmentModel)) {
        let dng = SyntheticGreyDng::default(); // L = 0.18, 64×64 RGGB
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let mr: u32 = (0..n).map(|i| rgb[i*3]     as u32).sum();
        let mg: u32 = (0..n).map(|i| rgb[i*3 + 1] as u32).sum();
        let mb: u32 = (0..n).map(|i| rgb[i*3 + 2] as u32).sum();
        let nu = n as u32;
        let avg = |s: u32| (s + nu / 2) / nu;
        println!("{:24} R={} G={} B={}", label, avg(mr), avg(mg), avg(mb));
    }
    mean("default",          |_| {});
    mean("exposure +1",      |m| m.exposure = 1.0);
    mean("exposure -1",      |m| m.exposure = -1.0);
    mean("shadows +50",      |m| m.shadows = 50.0);
    mean("whites -50",       |m| m.whites = -50.0);
    mean("contrast +50",     |m| m.contrast = 50.0);
}

/// Highlights compresses values above 1.0. Drive scene past the knee via
/// exposure(+EV=1) on L=0.95 → scene 1.9, then highlights(+50) → 1.45.
/// L kept off saturation because at L=1.0 the synthetic's G-channel raw
/// values land at exactly white_level and demosaic edge effects produce
/// ~0.5% drift that exceeds the EPS_SCENE_LINEAR budget.
#[test]
fn highlights_compresses_above_knee() {
    let configure = |m: &mut AdjustmentModel| {
        m.exposure = 1.0;
        m.highlights = 50.0;
    };
    let predict = |s: f32| predict_highlights(predict_exposure(s, 1.0), 50.0);
    assert_predicted_scene_linear(0.95, configure, predict);
    assert_neutral_display(0.95, configure);
}
