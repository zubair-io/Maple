//! Unit tests for [`super`] (closed-form slider predictors). Split out of
//! `predictions.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;

/// 1×1 image at the predicted scene-linear value, run through
/// `scene_tone_controls::apply` with the matching slider, must produce
/// the predictor's output to within 1e-6.
fn round_trip_exposure(scene: f32, ev: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;

    let predicted = predict_exposure(scene, ev);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.exposure = ev;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_exposure({},{}) = {}, scene_tone_controls produced {} (chan {})",
            scene,
            ev,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

#[test]
fn exposure_plus1_doubles() {
    round_trip_exposure(0.18, 1.0);
    round_trip_exposure(0.05, 1.0);
    round_trip_exposure(0.50, 1.0);
}

#[test]
fn exposure_minus1_halves() {
    round_trip_exposure(0.18, -1.0);
    round_trip_exposure(0.05, -1.0);
    round_trip_exposure(0.50, -1.0);
}

#[test]
fn exposure_zero_is_identity() {
    round_trip_exposure(0.18, 0.0);
}

fn round_trip_highlights(scene: f32, h: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    let predicted = predict_highlights(scene, h);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.highlights = h;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_highlights({},{}) = {}, got {} (chan {})",
            scene,
            h,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

fn round_trip_shadows(scene: f32, s: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    let predicted = predict_shadows(scene, s);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.shadows = s;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_shadows({},{}) = {}, got {} (chan {})",
            scene,
            s,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

fn round_trip_whites(scene: f32, w: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    let predicted = predict_whites(scene, w);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.whites = w;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_whites({},{}) = {}, got {} (chan {})",
            scene,
            w,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

fn round_trip_blacks(scene: f32, b: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    let predicted = predict_blacks(scene, b);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.blacks = b;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_blacks({},{}) = {}, got {} (chan {})",
            scene,
            b,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

fn round_trip_brightness(scene: f32, b: f32) {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    let predicted = predict_brightness(scene, b);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    let mut model = AdjustmentModel::default();
    model.brightness = b;
    scene_tone_controls::apply(&mut img, &model);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_brightness({},{}) = {}, got {} (chan {})",
            scene,
            b,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

#[test]
fn brightness_plus50_lifts_midtone() {
    round_trip_brightness(0.18, 50.0);
}
#[test]
fn brightness_minus50_darkens_midtone() {
    round_trip_brightness(0.18, -50.0);
}
#[test]
fn brightness_pins_deep_shadow() {
    round_trip_brightness(0.03, 100.0);
}
#[test]
fn brightness_pins_highlight_end() {
    round_trip_brightness(5.0, 100.0);
}
#[test]
fn brightness_zero_is_identity() {
    round_trip_brightness(0.18, 0.0);
}

/// Brightness at the band ends is EXACT identity (w = 0 → gain = 1.0
/// → bit-identical multiply), not merely within tolerance.
#[test]
fn brightness_band_ends_bit_exact() {
    use crate::image::{ColorSpace, Image};
    use crate::stages::scene_tone_controls;
    use crate::xmp::AdjustmentModel;
    for &scene in &[0.01_f32, 0.05, 4.0, 8.0] {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.brightness = 100.0;
        scene_tone_controls::apply(&mut img, &model);
        assert_eq!(
            img.pixels[0],
            [scene, scene, scene],
            "brightness must be bit-exact identity at Y={}",
            scene
        );
    }
}

/// Monotone in the slider: at a midtone, larger b ⇒ larger output.
#[test]
fn brightness_monotone_in_slider() {
    let mut prev = f32::NEG_INFINITY;
    for b in [-100.0_f32, -50.0, -10.0, 0.0, 10.0, 50.0, 100.0] {
        let out = predict_brightness(0.18, b);
        assert!(
            out > prev,
            "brightness not monotone at b={}: {} <= {}",
            b,
            out,
            prev
        );
        prev = out;
    }
}

// #1103: the engagement floor is Y = 0.25 (exact identity below — w_h
// clamps to 0); the band acts below the clip point; above-knee keeps
// compression for h ≥ 0 and the #1081 pole-free expansion for h < 0.
#[test]
fn highlights_below_engagement_is_identity() {
    round_trip_highlights(0.20, 50.0);
}
#[test]
fn highlights_below_knee_engages() {
    round_trip_highlights(0.70, 50.0);
}
#[test]
fn highlights_above_knee_compresses() {
    round_trip_highlights(2.0, 50.0);
}
#[test]
fn highlights_zero_is_identity() {
    round_trip_highlights(2.0, 0.0);
}
// #1081 / #1103 — negative half (pole-free expansion branch), incl. the
// old h = -50 pole and the full-range endpoint.
#[test]
fn highlights_minus25_expands() {
    round_trip_highlights(2.0, -25.0);
}
#[test]
fn highlights_minus50_expands_no_pole() {
    round_trip_highlights(2.0, -50.0);
}
#[test]
fn highlights_minus100_expands() {
    round_trip_highlights(2.0, -100.0);
}
#[test]
fn highlights_negative_below_engagement_is_identity() {
    round_trip_highlights(0.20, -50.0);
}

#[test]
fn shadows_plus50_lifts_dark() {
    round_trip_shadows(0.05, 50.0);
}
#[test]
fn shadows_minus50_crushes_dark() {
    round_trip_shadows(0.05, -50.0);
}
// #1103: engagement ceiling widened 0.1 → 0.25; 0.18 now engages,
// 0.50 stays exactly outside.
#[test]
fn shadows_mid_engages() {
    round_trip_shadows(0.18, 50.0);
}
#[test]
fn shadows_above_mask_no_op() {
    round_trip_shadows(0.50, 50.0);
}
#[test]
fn shadows_zero_is_identity() {
    round_trip_shadows(0.05, 0.0);
}

/// #1103 — closed-form pins for the reworked responses (guards against
/// silently re-deriving different constants on either side):
/// shadows: Y→0 ⇒ w→1 ⇒ mult → exp2(±1.5) = 2.8284 / 0.3536.
/// highlights above knee at h=−50, Y=2: shape = (1+1·2)/2, g = 2^0.35.
#[test]
fn sh_rework_closed_form_pins() {
    assert!((predict_shadows(0.0, 100.0) - 0.0).abs() < 1e-9); // 0·mult = 0
    let m_plus = predict_shadows(0.001, 100.0) / 0.001;
    assert!(
        (m_plus - 1.5_f32.exp2()).abs() < 0.01,
        "shadows +100 deep mult {} != 2.83",
        m_plus
    );
    let m_minus = predict_shadows(0.001, -100.0) / 0.001;
    assert!(
        (m_minus - (-1.5_f32).exp2()).abs() < 0.01,
        "shadows -100 deep mult {} != 0.354",
        m_minus
    );
    let h = predict_highlights(2.0, -50.0);
    let expect = 3.0 * (0.35_f32).exp2(); // (1+(2−1)·2) · 2^(0.7·0.5·1)
    assert!(
        (h - expect).abs() < 1e-4,
        "highlights -50 @Y=2: {} != {}",
        h,
        expect
    );
    let hp = predict_highlights(2.0, 100.0);
    let expect_p = (4.0 / 3.0) * (-0.7_f32).exp2(); // (1+1/3) · 2^−0.7
    assert!(
        (hp - expect_p).abs() < 1e-4,
        "highlights +100 @Y=2: {} != {}",
        hp,
        expect_p
    );
}

/// #1103 — the reworked per-pixel responses are MONOTONE in Y at the
/// slider rails (the property that bounded S_GAIN_EV/H_GAIN_EV; an
/// inverted tone curve solarizes smooth gradients). Dense Y sweep
/// through both bands and across the knee.
#[test]
fn sh_rework_monotone_in_y_at_rails() {
    for &(name, f) in &[
        (
            "shadows+100",
            (|y: f32| predict_shadows(y, 100.0)) as fn(f32) -> f32,
        ),
        ("shadows-100", |y: f32| predict_shadows(y, -100.0)),
        ("highlights+100", |y: f32| predict_highlights(y, 100.0)),
        ("highlights-100", |y: f32| predict_highlights(y, -100.0)),
    ] {
        let mut prev = f(0.0);
        for i in 1..=600 {
            let y = i as f32 * 0.005; // 0 → 3.0
            let out = f(y);
            assert!(
                out >= prev - 1e-6,
                "{} non-monotone at Y={}: {} < {}",
                name,
                y,
                out,
                prev
            );
            prev = out;
        }
    }
}

// Post-#267: whites is smoothstep-weighted with pivot at Y=0.5.
// The lift / pull-down behaviour tests now sample a brighter input
// (0.9) where the smoothstep weight is non-zero; the pivot test
// covers a luma below the smoothstep e0.
#[test]
fn whites_plus50_lifts_bright() {
    round_trip_whites(0.90, 50.0);
}
#[test]
fn whites_minus50_pulls_bright() {
    round_trip_whites(0.90, -50.0);
}
#[test]
fn whites_below_pivot_no_op() {
    round_trip_whites(0.10, 50.0);
}
#[test]
fn whites_at_pivot_no_op() {
    round_trip_whites(0.50, 50.0);
}
#[test]
fn whites_zero_is_identity() {
    round_trip_whites(0.50, 0.0);
}

#[test]
fn blacks_plus50_lifts_floor() {
    round_trip_blacks(0.05, 50.0);
}
#[test]
fn blacks_minus50_crushes_floor() {
    round_trip_blacks(0.05, -50.0);
}
#[test]
fn blacks_above_mid_no_op() {
    round_trip_blacks(0.30, 50.0);
}
#[test]
fn blacks_zero_is_identity() {
    round_trip_blacks(0.05, 0.0);
}

/// Saturation and vibrance decompose the pixel into chroma + luma and
/// reassemble; on a true neutral the chroma is zero so the output
/// matches the input, but float roundoff can introduce ~4e-6 drift.
/// 1e-5 is enough to lock down "no significant chroma shift" while
/// allowing the inherent floating-point noise.
const SAT_VIB_EPS: f32 = 1e-5;

#[test]
fn saturation_no_op_on_neutral() {
    use crate::image::{ColorSpace, Image};
    use crate::stages::saturation as sat;
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.18, 0.18, 0.18];
    sat::apply(&mut img, 50.0);
    let predicted = predict_saturation(0.18, 50.0);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < SAT_VIB_EPS,
            "saturation should not move a neutral; got {}, predicted {}",
            img.pixels[0][c],
            predicted
        );
    }
}

#[test]
fn vibrance_no_op_on_neutral() {
    use crate::image::{ColorSpace, Image};
    use crate::stages::vibrance;
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.18, 0.18, 0.18];
    vibrance::apply(&mut img, 50.0);
    let predicted = predict_vibrance(0.18, 50.0);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < SAT_VIB_EPS,
            "vibrance should not move a neutral; got {}, predicted {}",
            img.pixels[0][c],
            predicted
        );
    }
}

fn round_trip_ptc(scene: f32, points: &[(f32, f32)]) {
    use crate::color::profile_tone_curve::ProfileToneCurve;
    use crate::image::{ColorSpace, Image};
    let curve =
        ProfileToneCurve::from_floats(points.iter().flat_map(|(x, y)| vec![*x, *y]).collect())
            .expect("valid PTC");
    let predicted = predict_tone_curve(scene, points);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [scene, scene, scene];
    crate::color::profile_tone_curve::apply(&mut img, &curve);
    for c in 0..3 {
        assert!(
            (img.pixels[0][c] - predicted).abs() < 1e-6,
            "predict_tone_curve({}) = {}, got {} (chan {})",
            scene,
            predicted,
            img.pixels[0][c],
            c
        );
    }
}

const SIMPLE_S_CURVE: &[(f32, f32)] = &[
    (0.0, 0.0),
    (0.18, 0.15),
    (0.5, 0.55),
    (0.82, 0.9),
    (1.0, 1.0),
];

#[test]
fn ptc_at_origin() {
    round_trip_ptc(0.0, SIMPLE_S_CURVE);
}
#[test]
fn ptc_at_first_knot() {
    round_trip_ptc(0.18, SIMPLE_S_CURVE);
}
#[test]
fn ptc_at_midpoint() {
    round_trip_ptc(0.5, SIMPLE_S_CURVE);
}
#[test]
fn ptc_at_last_knot() {
    round_trip_ptc(0.82, SIMPLE_S_CURVE);
}
#[test]
fn ptc_at_unity() {
    round_trip_ptc(1.0, SIMPLE_S_CURVE);
}
#[test]
fn ptc_below_first_knot() {
    round_trip_ptc(0.10, SIMPLE_S_CURVE);
}
#[test]
fn ptc_above_last_knot() {
    round_trip_ptc(0.90, SIMPLE_S_CURVE);
}

// The vignette / grain / split-tone predictor round-trips moved to
// `predictions_display.rs` with their predictors (#1170).

#[test]
fn radial_gain_at_center_uses_first_value() {
    let lut = vec![1.5, 1.3, 1.0, 0.85, 0.7];
    let g = predict_radial_gain(1.0, 0.0, &lut);
    assert!((g - 1.5).abs() < 1e-6);
}

#[test]
fn radial_gain_at_edge_uses_last_value() {
    let lut = vec![1.5, 1.3, 1.0, 0.85, 0.7];
    let g = predict_radial_gain(1.0, 1.0, &lut);
    assert!((g - 0.7).abs() < 1e-6);
}

#[test]
fn radial_gain_at_midpoint_lerps() {
    let lut = vec![1.0, 0.5];
    let g = predict_radial_gain(1.0, 0.5, &lut);
    assert!((g - 0.75).abs() < 1e-6);
}

#[test]
fn radial_gain_scales_input() {
    let lut = vec![2.0, 1.0];
    let g = predict_radial_gain(0.5, 0.0, &lut);
    assert!((g - 1.0).abs() < 1e-6);
}
