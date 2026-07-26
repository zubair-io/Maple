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
//! Parametric curve: synthesises a monotone piecewise-cubic from the four
//! PV2012 region sliders over a region axis anchored to scene exposure —
//! see [`parametric`] for the region model, the closed-form gain profile
//! and the monotonicity bound. The luma-coupled application path mirrors
//! `scene_tone_controls`'s `highlights` step 2 — scale all three channels
//! by `Y_new / Y_old` — so hue is preserved by construction. The
//! per-channel `tone_curve_{red,green,blue}` paths default to a
//! direct-per-lane application (hue is NOT preserved — cross-channel cast
//! control is their purpose per ticket #273). Ticket #436 adds an opt-in
//! ratio-preserving mode for users who want the contrast shape without the
//! hue shift; see [`apply_point_curves_ratio_preserving`] for the formula
//! and Darktable citation.

mod evaluator;
mod parametric;

use evaluator::{eval_curve_scene_linear, prepare_curve, PreparedCurve};
use parametric::build_parametric_curve;

use crate::{
    image::{ColorSpace, Image},
    types::adjustment::{ToneCurve, ToneCurveMode},
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
///    curves. Application depends on `model.tone_curve_mode`:
///    - `PerChannel` (default): each curve applies independently per RGB
///      lane (hue NOT preserved — pre-#436 behavior).
///    - `RatioPreserving` (ticket #436): the three curves fold through
///      Rec.2020 luma to a single scale factor per pixel (hue preserved).
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

    // Per-channel curves: dispatch on the user-selected mode. The
    // `PerChannel` branch is the pre-#436 default (hue shifts);
    // `RatioPreserving` folds the three curves through Rec.2020 luma so
    // hue is preserved. See `ToneCurveMode` and Darktable citation in
    // `apply_point_curves_ratio_preserving`.
    let any_per_channel_active = !model.tone_curve_red.is_identity()
        || !model.tone_curve_green.is_identity()
        || !model.tone_curve_blue.is_identity();
    if any_per_channel_active {
        match model.tone_curve_mode {
            ToneCurveMode::PerChannel => {
                apply_point_curve_per_channel(img, &model.tone_curve_red, 0);
                apply_point_curve_per_channel(img, &model.tone_curve_green, 1);
                apply_point_curve_per_channel(img, &model.tone_curve_blue, 2);
            }
            ToneCurveMode::RatioPreserving => {
                apply_point_curves_ratio_preserving(
                    img,
                    &model.tone_curve_red,
                    &model.tone_curve_green,
                    &model.tone_curve_blue,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------
// Parametric region sliders → synthesised curve, luma-coupled apply
// ---------------------------------------------------------------------

/// Apply the synthesised parametric curve in scene-linear with luma
/// coupling. Mirrors the per-pixel pattern from
/// `scene_tone_controls::apply`'s `highlights` step 2 — scale all three
/// channels by `Y_new / Y_old` — so hue is preserved by construction.
fn apply_parametric_luma_coupled(img: &mut Image, model: &AdjustmentModel) {
    // Prepare once — the knots and their analytic tangents are computed
    // here, not per-pixel.
    let prepared = build_parametric_curve(model);

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

// ---------------------------------------------------------------------
// Point curves — ratio-preserving (hue-preserving) apply
// ---------------------------------------------------------------------

/// Apply the three per-channel curves in ratio-preserving mode (ticket
/// #436). Hue is preserved by folding the three curves through Rec.2020
/// luma to produce a single scale factor per pixel:
///
/// ```text
///   Y_in  = 0.2627·R + 0.6780·G + 0.0593·B
///   r' = R_curve(Y_in);  g' = G_curve(Y_in);  b' = B_curve(Y_in)
///   Y_out = 0.2627·r' + 0.6780·g' + 0.0593·b'
///   scale = Y_out / Y_in
///   (R, G, B) *= scale
/// ```
///
/// Canonical reference: Darktable's `iop/tonecurve.c`, `preserve_colors`
/// branch — the `dt_rgb_norm(...) → curve_lum → ratio = curve_lum/lum →
/// rgb[c] *= ratio` loop around lines 520–547. Darktable evaluates a
/// **single** curve on `dt_rgb_norm(rgb)`. Maple's three per-channel
/// curves collapse to the Darktable formulation when `R_curve == G_curve
/// == B_curve` (then `r' = g' = b' = curve(Y_in)`, and `Y_out` is just
/// that scalar).
///
/// Identity curves (`is_identity() == true`) contribute their lane's
/// luma-weighted Y_in to the sum unchanged, so e.g. setting only
/// `tone_curve_red` still preserves the G:B ratio while the R curve's
/// effect on Y_in routes back through the global scale.
///
/// As with the other curve paths: pixels with `Y_in <= 0` (zero or
/// negative luma) pass through untouched — the authoring `[0, 1]` domain
/// cannot map negative input.
fn apply_point_curves_ratio_preserving(
    img: &mut Image,
    curve_r: &ToneCurve,
    curve_g: &ToneCurve,
    curve_b: &ToneCurve,
) {
    // Prepare each curve once. Identity curves yield empty knots; the
    // evaluator falls back to `v` (pass-through) so they contribute the
    // unmodified luma to the Y_out sum. No allocation in the hot loop.
    let prepared_r = prepare_curve(curve_r);
    let prepared_g = prepare_curve(curve_g);
    let prepared_b = prepare_curve(curve_b);
    eval_ratio_preserving(img, &prepared_r, &prepared_g, &prepared_b);
}

/// Inner loop split out so the prepared-curve build is unit-testable in
/// isolation (and so future tile-/SIMD-friendly variants can share the
/// pixel kernel).
fn eval_ratio_preserving(
    img: &mut Image,
    curve_r: &PreparedCurve,
    curve_g: &PreparedCurve,
    curve_b: &PreparedCurve,
) {
    for p in &mut img.pixels {
        let y_in = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if y_in <= 0.0 {
            continue;
        }
        let r_prime = eval_curve_scene_linear(curve_r, y_in);
        let g_prime = eval_curve_scene_linear(curve_g, y_in);
        let b_prime = eval_curve_scene_linear(curve_b, y_in);
        let y_out =
            LUMA_REC2020[0] * r_prime + LUMA_REC2020[1] * g_prime + LUMA_REC2020[2] * b_prime;
        let scale = y_out / y_in;
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_parametric;
