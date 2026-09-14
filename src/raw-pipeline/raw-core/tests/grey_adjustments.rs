//! Closed-form + relational adjustment-validation tests on the synthetic
//! grey DNG. See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

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
///
/// Per ticket #429 the model starts with `auto_exposure = Off` so
/// stage-level closed-form predictors (`predict_shadows`,
/// `predict_blacks`, `predict_highlights`, etc.) see
/// the raw `linear_value` and not the post-anchor `0.18`. Tests that
/// validate the anchored behaviour (the two `exposure_*_predicts`)
/// re-enable it explicitly via `configure`.
fn assert_predicted_scene_linear(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
    predict: impl Fn(f32) -> f32,
) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    // Pin WB to the 6500K/0 identity baseline so that non-WB tests are
    // unaffected by the as-shot CCT resolution introduced in #1729.
    // Tests that exercise explicit temperature/tint set the seen-flags
    // themselves inside `configure`.
    model.temperature_seen = true;
    model.tint_seen = true;
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    let expected = predict(linear_value);
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
///
/// Same `auto_exposure = Off` starting point as
/// [`assert_predicted_scene_linear`]: the neutrality assertion is an
/// invariant of the pipeline (R == G == B for a neutral input), so the
/// anchor gain — a uniform scalar across all three channels — never
/// affects it. Keeping the helpers aligned on the same starting model
/// avoids subtle divergence between the two predicates.
fn assert_neutral_display(linear_value: f32, configure: impl FnOnce(&mut AdjustmentModel)) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    // Pin WB to the 6500K/0 identity baseline — same rationale as
    // `assert_predicted_scene_linear`. WB-specific tests set the flags
    // themselves via `configure`.
    model.temperature_seen = true;
    model.tint_seen = true;
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

/// Render a synthetic grey DNG through the full pipeline (Neutral profile,
/// auto-exposure off) and return the display-encoded green channel of the
/// center pixel. Used to measure whites' DISPLAY-domain effect now that the
/// slider moved to the AgX view transform (#2441) — it has no scene-linear
/// effect for `assert_predicted_scene_linear` to check.
fn render_grey_code(linear_value: f32, configure: impl FnOnce(&mut AdjustmentModel)) -> u8 {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let raw = raw_core::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("decode");
    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    model.profile = raw_core::xmp::Profile::Neutral;
    configure(&mut model);
    let (w, h, rgb) = render_from_raw(&raw, &model).expect("render");
    rgb[((h / 2) * w + w / 2) as usize * 3 + 1]
}

// Per #429 (and updated under #494), auto-exposure is on by default and
// implements a HYBRID anchor: it picks the larger of two candidate gains,
//   midtone_gain   = 0.18 / midgrey   (geometric mean of the trimmed band)
//   highlight_gain = 0.85 / p95       (the 95th percentile of luma)
// each clamped to MAX_ANCHOR_GAIN = 8.0. For a uniform synthetic scene at
// `L`, midgrey == p95 == L, so:
//   midtone_gain   = min(0.18 / L, 8.0)
//   highlight_gain = min(0.85 / L, 8.0)
//   anchor         = max(midtone_gain, highlight_gain) = highlight_gain
// (because 0.85 / L > 0.18 / L for any positive L). The user exposure
// then stacks additively on top: `final = L * anchor * 2^ev`. The
// uniform-patch case isn't representative of real scenes — see
// `auto_exposure::tests::hybrid_anchor_preserves_highlights_on_bright_scene`
// for the case where the highlight branch is a no-op.

/// Predict the scene-linear output for a uniform synthetic scene under
/// `auto_exposure = On` (default). The hybrid anchor reduces to the
/// highlight branch on uniform inputs; the user exposure adds `2^ev`
/// on top.
fn predict_anchored_exposure(linear_value: f32, ev: f32) -> f32 {
    // Matches HYBRID anchor in stages::auto_exposure (#494):
    let midtone = (0.18_f32 / linear_value).min(8.0);
    let highlight = (0.85_f32 / linear_value).min(8.0);
    let anchor = midtone.max(highlight); // = highlight for positive L
    linear_value * anchor * ev.exp2()
}

#[test]
fn exposure_plus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(
            L,
            |m| {
                m.auto_exposure = raw_core::xmp::AutoExposureMode::On;
                m.exposure = 1.0;
            },
            |_| predict_anchored_exposure(L, 1.0),
        );
        assert_neutral_display(L, |m| {
            m.auto_exposure = raw_core::xmp::AutoExposureMode::On;
            m.exposure = 1.0;
        });
    }
}

#[test]
fn exposure_minus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(
            L,
            |m| {
                m.auto_exposure = raw_core::xmp::AutoExposureMode::On;
                m.exposure = -1.0;
            },
            |_| predict_anchored_exposure(L, -1.0),
        );
        assert_neutral_display(L, |m| {
            m.auto_exposure = raw_core::xmp::AutoExposureMode::On;
            m.exposure = -1.0;
        });
    }
}

/// Brightness midtone-band gain (#1102, tone/zoom design spec § 4.1).
/// L sweep covers the pinned low end (0.05 → weight 0 → identity), the
/// mid-band (0.18, 0.50 → non-trivial gain), and both signs.
#[test]
fn brightness_plus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.brightness = 50.0, |s| predict_brightness(s, 50.0));
        assert_neutral_display(L, |m| m.brightness = 50.0);
    }
}

#[test]
fn brightness_minus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(
            L,
            |m| m.brightness = -50.0,
            |s| predict_brightness(s, -50.0),
        );
        assert_neutral_display(L, |m| m.brightness = -50.0);
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
fn whites_leaves_scene_linear_alone_and_moves_the_display() {
    for w in [50.0f32, -50.0] {
        assert_predicted_scene_linear(0.18, |m| m.whites = w, |s| s);
        assert_neutral_display(0.18, |m| m.whites = w);
    }
    // The calibrated remap reaches mid-grey in both directions, while
    // negative Whites preserves the deep shadow below its ramp onset.
    let code = |w: f32| render_grey_code(0.18, |m| m.whites = w);
    assert!(
        code(100.0) as i32 - code(0.0) as i32 >= 30,
        "+100: {} vs {}",
        code(100.0),
        code(0.0)
    );
    assert!(
        code(0.0) as i32 - code(-100.0) as i32 >= 3,
        "-100 must darken mid-grey"
    );
    let shadow = |w| render_grey_code(0.01, |m| m.whites = w) as i32;
    assert!((shadow(-100.0) - shadow(0.0)).abs() <= 1);
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
        assert_predicted_scene_linear(
            L,
            |m| m.saturation = -50.0,
            |s| predict_saturation(s, -50.0),
        );
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

/// Decode-time chroma pre-filter (#1104, tone/zoom design spec § 3.1).
/// On a uniform grey card every tap sees equal luma AND equal chroma, so
/// the delta-form filter is exactly identity at ANY strength — the
/// closed-form predictor is the identity function. Covers the engaged
/// settings the default-0 baseline never exercises.
#[test]
fn chroma_prefilter_engaged_is_identity_on_grey() {
    for strength in [25.0_f32, 50.0, 100.0] {
        for L in [0.05, 0.18, 0.50] {
            assert_predicted_scene_linear(L, |m| m.chroma_prefilter = strength, |s| s);
            assert_neutral_display(L, |m| m.chroma_prefilter = strength);
        }
    }
}

/// Hot/dead-pixel suppression (#1106, tone/zoom design spec § 10.6).
/// On the synthetic grey card every same-color neighborhood is uniform,
/// so neither outlier predicate (`v > 2·max + 0.02`, `v < 0.25·min`) can
/// fire and the stage is exactly identity even when engaged — the
/// closed-form predictor is the identity function.
/// BM3D deep denoise (#1105, tone/zoom design spec § 3.2). On the
/// noiseless synthetic grey card every mean-relative spectrum is exactly
/// zero, hard-thresholding removes nothing, the Wiener gains multiply
/// exact zeros, and the HF re-injection term is an exact zero — the
/// stage is bit-exact identity at any strength (the spec's "on noiseless
/// synthetic grey, hard-thresholding removes nothing → identity" gate).
#[test]
fn deep_denoise_engaged_is_identity_on_grey() {
    for strength in [30.0_f32, 70.0] {
        for L in [0.05, 0.18, 0.50] {
            assert_predicted_scene_linear(L, |m| m.deep_denoise = strength, |s| s);
            assert_neutral_display(L, |m| m.deep_denoise = strength);
        }
    }
}

#[test]
fn hot_pixel_suppression_engaged_is_identity_on_grey() {
    use raw_core::xmp::HotPixelSuppressionMode;
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(
            L,
            |m| m.hot_pixel_suppression = HotPixelSuppressionMode::On,
            |s| s,
        );
        assert_neutral_display(L, |m| m.hot_pixel_suppression = HotPixelSuppressionMode::On);
    }
}

// The display-domain gates (AgX-internal contrast direction + the vignette /
// grain / split-tone / HSL stages, #1109–#1112) live in the sibling targets
// `grey_adjustments_display.rs` and `grey_hsl.rs` — split out to stay under
// the 600-LOC file budget (#1181). The two `#[ignore]` diagnostic dumps
// (`dump_scene_linear_deltas`, `dump_display_means`) live in the sibling
// `grey_adjustments_dump.rs` for the same reason. The white-balance
// (temperature/tint) tests live in the sibling `grey_adjustments_wb.rs`,
// split out under #2441 when the `whites` display-domain test pushed this
// file back over budget.

/// Adobe direction — highlights compresses above 1.0: exposure(+EV=1) on
/// L=0.95 → scene 1.9, then highlights(-50) → 1.45. L off saturation: at
/// L=1.0 the G-channel raw lands at white_level and demosaic drift exceeds EPS_SCENE_LINEAR.
#[test]
fn highlights_minus50_compresses_above_knee() {
    let configure = |m: &mut AdjustmentModel| {
        m.exposure = 1.0;
        m.highlights = -50.0;
    };
    let predict = |s: f32| predict_highlights(predict_exposure(s, 1.0), -50.0);
    assert_predicted_scene_linear(0.95, configure, predict);
    assert_neutral_display(0.95, configure);
}

/// Adobe direction — #1081 / #1103 — positive highlights at the OLD pole
/// (h = +50, legacy 1 + 2h denominator hit zero, stage silently skipped):
/// exposure(+1) on L=0.95 → scene 1.9, highlights(+50) expands per the pole-free #1103 response.
#[test]
fn highlights_plus50_expands_above_knee() {
    let configure = |m: &mut AdjustmentModel| {
        m.exposure = 1.0;
        m.highlights = 50.0;
    };
    let predict = |s: f32| predict_highlights(predict_exposure(s, 1.0), 50.0);
    assert_predicted_scene_linear(0.95, configure, predict);
    assert_neutral_display(0.95, configure);
}

/// Adobe direction — #1081 / #1103 — full-range positive highlights (the
/// legacy form produced negative RGB here for any pixel above Y = 2).
#[test]
fn highlights_plus100_expands_above_knee() {
    let configure = |m: &mut AdjustmentModel| {
        m.exposure = 1.0;
        m.highlights = 100.0;
    };
    let predict = |s: f32| predict_highlights(predict_exposure(s, 1.0), 100.0);
    assert_predicted_scene_linear(0.95, configure, predict);
    assert_neutral_display(0.95, configure);
}

/// #1103 — highlights now engages BELOW the clip point: L=0.7 sits inside
/// the (0.4, 1.0) engagement band, where the pre-#1103 stage was a no-op.
#[test]
fn highlights_engages_below_knee_grey() {
    for h in [60.0_f32, -60.0] {
        assert_predicted_scene_linear(0.7, |m| m.highlights = h, move |s| predict_highlights(s, h));
        assert_neutral_display(0.7, |m| m.highlights = h);
    }
}

/// #1103 — shadows engagement widened to Y < 0.25: L=0.18 responds now
/// (pre-#1103 the mask zeroed out above Y = 0.1).
#[test]
fn shadows_engages_at_mid_grey() {
    for s in [60.0_f32, -60.0] {
        assert_predicted_scene_linear(0.18, |m| m.shadows = s, move |sc| predict_shadows(sc, s));
        assert_neutral_display(0.18, |m| m.shadows = s);
    }
}
