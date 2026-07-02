//! HSL 8-band neutral pass-through tests (#1112) on the synthetic grey DNG.
//! Split out of `grey_adjustments.rs` when the file exceeded the 600-LOC hard
//! budget (#1181) — pure relocation, assertions unchanged.
//!
//! A neutral grey scene has zero chroma in Oklab (a=b=0). The HSL stage
//! gates on `C < CHROMA_GATE_C0` (0.05) and returns early — any combination
//! of hue/sat/lum adjustments must leave a neutral input unchanged.
//! Tests cover max-deflection on every band to confirm no numeric leakage.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, render_from_raw, RenderQuality,
};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Float tolerance for closed-form scene-linear assertions. Same budget
/// as `grey_invariants.rs` SCENE_LINEAR_EPS — demosaic + matrix-mul drift.
const EPS_SCENE_LINEAR: f32 = 5e-4;

/// 8-bit LSB tolerance for display-encoded neutrality (R=G=B preservation).
const EPS_DISPLAY_LSB: i32 = 2;

/// Synthesise a grey DNG at scene-linear `linear_value`, apply the
/// requested adjustments via `configure`, develop scene-linear, and
/// assert per-pixel R=G=B=identity(linear_value) within EPS_SCENE_LINEAR.
///
/// Duplicated from `grey_adjustments` — integration test targets are
/// separate crates, so sharing helpers requires a common module or
/// duplication. The helper is tiny and the precedent (`grey_adjustments_display.rs`)
/// chose duplication to avoid a shared include module.
fn assert_predicted_scene_linear_identity(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    let expected = linear_value;
    for (i, p) in img.pixels.iter().enumerate() {
        for c in 0..3 {
            assert!(
                (p[c] - expected).abs() <= EPS_SCENE_LINEAR,
                "pixel {} chan {} = {} (predicted {}, |Δ| > {}) at L = {}",
                i,
                c,
                p[c],
                expected,
                EPS_SCENE_LINEAR,
                linear_value
            );
        }
    }
}

/// Synthesise + render through the full production pipeline (incl. AgX),
/// assert per-pixel R=G=B in u8 within EPS_DISPLAY_LSB.
fn assert_neutral_display(linear_value: f32, configure: impl FnOnce(&mut AdjustmentModel)) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    configure(&mut model);
    let (w, h, rgb) = render_from_raw(&raw, &model).expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    for i in 0..n {
        let r = rgb[i * 3] as i32;
        let g = rgb[i * 3 + 1] as i32;
        let b = rgb[i * 3 + 2] as i32;
        assert!(
            (r - g).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-G|={} > {} (R={} G={} B={}) at L={}",
            i,
            (r - g).abs(),
            EPS_DISPLAY_LSB,
            r,
            g,
            b,
            linear_value
        );
        assert!(
            (r - b).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-B|={} > {} (R={} G={} B={}) at L={}",
            i,
            (r - b).abs(),
            EPS_DISPLAY_LSB,
            r,
            g,
            b,
            linear_value
        );
    }
}

#[test]
fn hsl_all_hue_max_is_identity_on_neutral() {
    // ±100 on every hue band — neutral must stay neutral.
    for L in [0.05_f32, 0.18, 0.50, 0.80] {
        assert_predicted_scene_linear_identity(L, |m| {
            m.hue_adjustment_red = 100.0;
            m.hue_adjustment_orange = -100.0;
            m.hue_adjustment_yellow = 100.0;
            m.hue_adjustment_green = -100.0;
            m.hue_adjustment_aqua = 100.0;
            m.hue_adjustment_blue = -100.0;
            m.hue_adjustment_purple = 100.0;
            m.hue_adjustment_magenta = -100.0;
        });
        assert_neutral_display(L, |m| {
            m.hue_adjustment_red = 100.0;
            m.hue_adjustment_orange = -100.0;
            m.hue_adjustment_yellow = 100.0;
            m.hue_adjustment_green = -100.0;
            m.hue_adjustment_aqua = 100.0;
            m.hue_adjustment_blue = -100.0;
            m.hue_adjustment_purple = 100.0;
            m.hue_adjustment_magenta = -100.0;
        });
    }
}

#[test]
fn hsl_all_sat_max_is_identity_on_neutral() {
    // +100 saturation on every band — neutral must stay neutral.
    for L in [0.05_f32, 0.18, 0.50, 0.80] {
        assert_predicted_scene_linear_identity(L, |m| {
            m.saturation_adjustment_red = 100.0;
            m.saturation_adjustment_orange = 100.0;
            m.saturation_adjustment_yellow = 100.0;
            m.saturation_adjustment_green = 100.0;
            m.saturation_adjustment_aqua = 100.0;
            m.saturation_adjustment_blue = 100.0;
            m.saturation_adjustment_purple = 100.0;
            m.saturation_adjustment_magenta = 100.0;
        });
        assert_neutral_display(L, |m| {
            m.saturation_adjustment_red = 100.0;
            m.saturation_adjustment_orange = 100.0;
            m.saturation_adjustment_yellow = 100.0;
            m.saturation_adjustment_green = 100.0;
            m.saturation_adjustment_aqua = 100.0;
            m.saturation_adjustment_blue = 100.0;
            m.saturation_adjustment_purple = 100.0;
            m.saturation_adjustment_magenta = 100.0;
        });
    }
}

#[test]
fn hsl_all_lum_max_is_identity_on_neutral() {
    // ±100 luminance on every band — neutral must stay neutral.
    for L in [0.05_f32, 0.18, 0.50, 0.80] {
        assert_predicted_scene_linear_identity(L, |m| {
            m.luminance_adjustment_red = 100.0;
            m.luminance_adjustment_orange = -100.0;
            m.luminance_adjustment_yellow = 100.0;
            m.luminance_adjustment_green = -100.0;
            m.luminance_adjustment_aqua = 100.0;
            m.luminance_adjustment_blue = -100.0;
            m.luminance_adjustment_purple = 100.0;
            m.luminance_adjustment_magenta = -100.0;
        });
        assert_neutral_display(L, |m| {
            m.luminance_adjustment_red = 100.0;
            m.luminance_adjustment_orange = -100.0;
            m.luminance_adjustment_yellow = 100.0;
            m.luminance_adjustment_green = -100.0;
            m.luminance_adjustment_aqua = 100.0;
            m.luminance_adjustment_blue = -100.0;
            m.luminance_adjustment_purple = 100.0;
            m.luminance_adjustment_magenta = -100.0;
        });
    }
}
