//! Closed-form predictors for scene-linear adjustments. Mirror the math
//! in `crate::stages::scene_tone_controls::apply` exactly so each
//! predictor + production-code pair drifts together. See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// scene_tone_controls::apply, step 1.
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    if ev.abs() < 1e-6 {
        return scene;
    }
    scene * ev.exp2()
}

/// scene_tone_controls::apply, step 1b (#1102, tone/zoom design spec
/// § 4.1). Brightness midtone-band gain — for a neutral input
/// R=G=B=scene, Y collapses to scalar `scene`:
///   w(Y)  = smoothstep(0.05, 0.25, Y) · (1 − smoothstep(1.0, 4.0, Y))
///   gain  = exp2(0.7 · b/100 · w(Y))
/// Output = scene · gain. Exactly identity at Y ≤ 0.05 and Y ≥ 4.0.
pub fn predict_brightness(scene: f32, b_slider: f32) -> f32 {
    if b_slider.abs() < 1e-3 {
        return scene;
    }
    let w = smoothstep(0.05, 0.25, scene) * (1.0 - smoothstep(1.0, 4.0, scene));
    let gain = (0.7 * b_slider / 100.0 * w).exp2();
    scene * gain
}

/// scene_tone_controls::apply, step 2 (#1103, tone/zoom design § 4.2).
/// Highlights — for a neutral input R=G=B=scene, Y collapses to scalar
/// `scene` and (on a uniform field) the detail mask degenerates to the
/// per-pixel curve, so the output is `scene · highlights_mult(scene)`:
///
/// - weighted gain `exp2(−0.7 · h/100 · smoothstep(0.25, 1.0, Y))` — engages
///   below the clip point (positive h darkens toward the knee, negative h
///   brightens; sign conventions unchanged; the 0.25 band floor is the
///   calibrated value — see `H_W0` in the stage);
/// - above the knee (Y > 1), sign-branched shape: h ≥ 0 keeps the
///   `1 + (Y−1)/(1+2h)` compression; h < 0 expands by `1 + (Y−1)·(1+2|h|)` —
///   the pole-free mirror (#1081 / PR #1117; the legacy shared denominator
///   crossed zero at h = −50).
pub fn predict_highlights(scene: f32, h_slider: f32) -> f32 {
    if h_slider.abs() < 1e-3 {
        return scene;
    }
    let h_amount = h_slider / 100.0;
    let w = smoothstep(0.25, 1.0, scene);
    let g = (-0.7 * h_amount * w).exp2();
    let shape = if scene > 1.0 {
        let y_new = if h_amount >= 0.0 {
            1.0 + (scene - 1.0) / (1.0 + h_amount * 2.0)
        } else {
            1.0 + (scene - 1.0) * (1.0 + 2.0 * h_amount.abs())
        };
        y_new / scene
    } else {
        1.0
    };
    scene * shape * g
}

/// scene_tone_controls::apply, step 3 (#1103, tone/zoom design § 4.2).
/// Shadows — for a neutral pixel R=G=B=scene on a uniform field the detail
/// mask degenerates and the output is `scene · shadows_mult(scene)`:
/// `w_s(Y) = (1 − smoothstep(0, 0.25, Y))²` (engagement widened from 0.1),
/// `mult = mix(1, exp2(1.5 · s/100), w_s)` — 2.83× lift / 0.35× crush cap
/// at slider ±100 (the monotonicity-bounded calibration of the spec's ≈4×,
/// see `S_GAIN_EV` in the stage), exactly 1 at Y ≥ 0.25. Sign conventions
/// unchanged.
pub fn predict_shadows(scene: f32, s_slider: f32) -> f32 {
    if s_slider.abs() < 1e-3 {
        return scene;
    }
    let t = 1.0 - smoothstep(0.0, 0.25, scene);
    let w = t * t;
    let mult = 1.0 + ((1.5 * s_slider / 100.0).exp2() - 1.0) * w;
    scene * mult
}

/// scene_tone_controls::apply, step 4. Parametric upper-end curve
/// (Ticket #267) — smoothstep-weighted gain near diffuse white.
pub fn predict_whites(scene: f32, w_slider: f32) -> f32 {
    if w_slider.abs() < 1e-3 {
        return scene;
    }
    let w = smoothstep(0.5, 1.0, scene);
    let w_gain = 1.0 + (w_slider / 200.0) * w;
    scene * w_gain
}

/// scene_tone_controls::apply, step 5. Parametric toe curve (Ticket #268)
/// — smoothstep-weighted near zero, identity above ~Y=0.2. Branch on
/// sign of slider: negative crushes multiplicatively (no negative
/// scene values possible); positive lifts additively (matches the
/// legacy zero-input lift semantics).
pub fn predict_blacks(scene: f32, b_slider: f32) -> f32 {
    if b_slider.abs() < 1e-3 {
        return scene;
    }
    let w = 1.0 - smoothstep(0.0, 0.2, scene);
    if b_slider < 0.0 {
        let b_amount = b_slider / 100.0; // -1..0
        let factor = 1.0 + b_amount * w;
        scene * factor
    } else {
        let delta = (b_slider / 400.0) * w;
        scene + delta
    }
}

pub fn predict_saturation(scene: f32, _s_slider: f32) -> f32 {
    scene
}
pub fn predict_vibrance(scene: f32, _v_slider: f32) -> f32 {
    scene
}

/// The position-aware / display-tail predictors (vignette #1109, grain
/// #1110, split toning #1111) live in the sibling `predictions_display`
/// module — split out to stay under the 600-LOC file budget (#1170).
/// Re-exported here so `predictions::*` glob consumers keep resolving them.
pub use super::predictions_display::{predict_grain, predict_split_tone_ab, predict_vignette};

/// Predict the post-radial-gain value at a given normalised radius.
/// `gain_values` is a flat 1-D LUT sampled along radius [0, 1].
/// Output = `input * gain(radius_norm)` with linear interp between
/// adjacent LUT samples.
pub fn predict_radial_gain(input: f32, radius_norm: f32, gain_values: &[f32]) -> f32 {
    if gain_values.is_empty() {
        return input;
    }
    if gain_values.len() == 1 {
        return input * gain_values[0];
    }
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
    if control_points.is_empty() {
        return scene;
    }
    let first = control_points[0];
    let last = control_points[control_points.len() - 1];
    if scene <= first.0 {
        return first.1;
    }
    if scene >= last.0 {
        return last.1;
    }

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

// Tests live in the sibling `predictions_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "predictions_tests.rs"]
mod tests;
