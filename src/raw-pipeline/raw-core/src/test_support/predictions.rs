//! Closed-form predictors for scene-linear adjustments. Mirror the math
//! in `crate::stages::scene_tone_controls::apply` exactly so each
//! predictor + production-code pair drifts together. See spec
//! `docs/superpowers/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// scene_tone_controls::apply, step 1.
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    if ev.abs() < 1e-6 { return scene; }
    scene * ev.exp2()
}

/// scene_tone_controls::apply, step 2. Highlights only fires above 1.0.
pub fn predict_highlights(scene: f32, h_slider: f32) -> f32 {
    if h_slider.abs() < 1e-3 { return scene; }
    if scene <= 1.0 { return scene; }
    let h_amount = h_slider / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;
    if h_denom.abs() < 1e-6 { return scene; }
    1.0 + (scene - 1.0) / h_denom
}

/// scene_tone_controls::apply, step 3. For a neutral pixel R=G=B=scene,
/// luma == scene, so the per-channel math collapses to scalar math.
pub fn predict_shadows(scene: f32, s_slider: f32) -> f32 {
    if s_slider.abs() < 1e-3 { return scene; }
    let s_factor = (s_slider / 100.0) * 0.5;
    let mask = 1.0 - smoothstep(0.0, 0.1, scene);
    let lift = mask * s_factor;
    scene * (1.0 + lift)
}

/// scene_tone_controls::apply, step 4. (Simplified to a uniform scalar
/// gain on every pixel after the 2026-04-28 whites refactor — no
/// luma weighting, no overshoot.)
pub fn predict_whites(scene: f32, w_slider: f32) -> f32 {
    if w_slider.abs() < 1e-3 { return scene; }
    let w_gain = 1.0 + w_slider / 200.0;
    scene * w_gain
}

/// scene_tone_controls::apply, step 5. (Simplified to a uniform additive
/// shift after the 2026-04-28 blacks refactor — no luma weighting, no
/// per-direction multiplicative branch. Floor at 0 keeps deep shadows
/// non-negative for AgX's per-channel log encode.)
pub fn predict_blacks(scene: f32, b_slider: f32) -> f32 {
    if b_slider.abs() < 1e-3 { return scene; }
    let b_add = b_slider / 400.0;
    (scene + b_add).max(0.0)
}

pub fn predict_saturation(scene: f32, _s_slider: f32) -> f32 { scene }
pub fn predict_vibrance(scene: f32, _v_slider: f32) -> f32 { scene }

/// Predict the post-radial-gain value at a given normalised radius.
/// `gain_values` is a flat 1-D LUT sampled along radius [0, 1].
/// Output = `input * gain(radius_norm)` with linear interp between
/// adjacent LUT samples.
pub fn predict_radial_gain(input: f32, radius_norm: f32, gain_values: &[f32]) -> f32 {
    if gain_values.is_empty() { return input; }
    if gain_values.len() == 1 { return input * gain_values[0]; }
    let r = radius_norm.clamp(0.0, 1.0);
    let n = gain_values.len();
    let scaled = r * (n as f32 - 1.0);
    let i = scaled.floor() as usize;
    if i + 1 >= n {
        return input * gain_values[n - 1];
    }
    let t = scaled - i as f32;
    let g = gain_values[i] + t * (gain_values[i + 1] - gain_values[i]);
    input * g
}

/// Mirrors color/profile_tone_curve::ProfileToneCurve::eval (linear interp
/// between adjacent control points, endpoint clamp). For a neutral input
/// R=G=B=scene, the production `apply` path scales by curve.eval(max)/max
/// where max == scene — i.e. the output is just curve.eval(scene).
pub fn predict_tone_curve(scene: f32, control_points: &[(f32, f32)]) -> f32 {
    if control_points.is_empty() { return scene; }
    let first = control_points[0];
    let last = control_points[control_points.len() - 1];
    if scene <= first.0 { return first.1; }
    if scene >= last.0 { return last.1; }

    // Linear scan for the bracketing pair (curves are short).
    let mut i = 0;
    while i + 1 < control_points.len() && control_points[i + 1].0 < scene {
        i += 1;
    }
    if i + 1 >= control_points.len() {
        return last.1;
    }
    let (xa, ya) = control_points[i];
    let (xb, yb) = control_points[i + 1];
    if (xb - xa).abs() < f32::EPSILON {
        return ya;
    }
    let t = (scene - xa) / (xb - xa);
    ya + t * (yb - ya)
}

#[cfg(test)]
mod tests {
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
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_exposure({},{}) = {}, scene_tone_controls produced {} (chan {})",
                scene, ev, predicted, img.pixels[0][c], c);
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
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_highlights({},{}) = {}, got {} (chan {})",
                scene, h, predicted, img.pixels[0][c], c);
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
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_shadows({},{}) = {}, got {} (chan {})",
                scene, s, predicted, img.pixels[0][c], c);
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
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_whites({},{}) = {}, got {} (chan {})",
                scene, w, predicted, img.pixels[0][c], c);
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
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_blacks({},{}) = {}, got {} (chan {})",
                scene, b, predicted, img.pixels[0][c], c);
        }
    }

    #[test] fn highlights_below_knee_is_identity()  { round_trip_highlights(0.50, 50.0); }
    #[test] fn highlights_above_knee_compresses()   { round_trip_highlights(2.0, 50.0); }
    #[test] fn highlights_zero_is_identity()        { round_trip_highlights(2.0, 0.0); }

    #[test] fn shadows_plus50_lifts_dark()    { round_trip_shadows(0.05, 50.0); }
    #[test] fn shadows_minus50_crushes_dark() { round_trip_shadows(0.05, -50.0); }
    #[test] fn shadows_above_mask_no_op()     { round_trip_shadows(0.50, 50.0); }
    #[test] fn shadows_zero_is_identity()     { round_trip_shadows(0.05, 0.0); }

    #[test] fn whites_plus50_lifts_bright()   { round_trip_whites(0.50, 50.0); }
    #[test] fn whites_minus50_pulls_bright()  { round_trip_whites(0.50, -50.0); }
    #[test] fn whites_below_pivot_no_op()     { round_trip_whites(0.10, 50.0); }
    #[test] fn whites_zero_is_identity()      { round_trip_whites(0.50, 0.0); }

    #[test] fn blacks_plus50_lifts_floor()    { round_trip_blacks(0.05, 50.0); }
    #[test] fn blacks_minus50_crushes_floor() { round_trip_blacks(0.05, -50.0); }
    #[test] fn blacks_above_mid_no_op()       { round_trip_blacks(0.30, 50.0); }
    #[test] fn blacks_zero_is_identity()      { round_trip_blacks(0.05, 0.0); }

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
            assert!((img.pixels[0][c] - predicted).abs() < SAT_VIB_EPS,
                "saturation should not move a neutral; got {}, predicted {}",
                img.pixels[0][c], predicted);
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
            assert!((img.pixels[0][c] - predicted).abs() < SAT_VIB_EPS,
                "vibrance should not move a neutral; got {}, predicted {}",
                img.pixels[0][c], predicted);
        }
    }

    fn round_trip_ptc(scene: f32, points: &[(f32, f32)]) {
        use crate::color::profile_tone_curve::ProfileToneCurve;
        use crate::image::{ColorSpace, Image};
        let curve = ProfileToneCurve::from_floats(
            points.iter().flat_map(|(x, y)| vec![*x, *y]).collect()
        ).expect("valid PTC");
        let predicted = predict_tone_curve(scene, points);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        crate::color::profile_tone_curve::apply(&mut img, &curve);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_tone_curve({}) = {}, got {} (chan {})",
                scene, predicted, img.pixels[0][c], c);
        }
    }

    const SIMPLE_S_CURVE: &[(f32, f32)] = &[
        (0.0,  0.0),
        (0.18, 0.15),
        (0.5,  0.55),
        (0.82, 0.9),
        (1.0,  1.0),
    ];

    #[test] fn ptc_at_origin()        { round_trip_ptc(0.0,  SIMPLE_S_CURVE); }
    #[test] fn ptc_at_first_knot()    { round_trip_ptc(0.18, SIMPLE_S_CURVE); }
    #[test] fn ptc_at_midpoint()      { round_trip_ptc(0.5,  SIMPLE_S_CURVE); }
    #[test] fn ptc_at_last_knot()     { round_trip_ptc(0.82, SIMPLE_S_CURVE); }
    #[test] fn ptc_at_unity()         { round_trip_ptc(1.0,  SIMPLE_S_CURVE); }
    #[test] fn ptc_below_first_knot() { round_trip_ptc(0.10, SIMPLE_S_CURVE); }
    #[test] fn ptc_above_last_knot()  { round_trip_ptc(0.90, SIMPLE_S_CURVE); }

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
}
