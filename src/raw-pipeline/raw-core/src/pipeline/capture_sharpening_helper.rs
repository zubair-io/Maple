//! Pure helper: translate the user-facing capture-sharpening sliders on
//! [`AdjustmentModel`] into the stage's
//! [`capture_sharpening::CaptureSharpeningParams`].
//!
//! Lives in the pipeline module (not `stages::capture_sharpening`) because
//! it's plumbing between the XMP-driven adjustment surface and the stage
//! API — the stage itself is the algorithm, this helper is the contract
//! that maps a slider value to a stage configuration. Used by
//! [`super::develop`]'s two entry points.

use crate::stages::capture_sharpening;
use crate::xmp::AdjustmentModel;

/// Translate the AdjustmentModel's user-facing capture-sharpening sliders
/// into the stage's [`capture_sharpening::CaptureSharpeningParams`]. Returns
/// `None` when the stage should be skipped (default identity: amount = 0).
///
/// The AdjustmentModel's `capture_sharpening_radius` is an f32 with a
/// declared range of `[0.5, 2.0]`; the underlying tripled-box-blur
/// approximation accepts only integer-pixel radii, so we round to the
/// nearest integer. The slider in the UI is quantised to whole-pixel steps
/// (`min=1`, `max=2`, `step=1`) so user-driven inputs already land on an
/// integer — but XMP can in principle carry any f32, so we defensively
/// clamp the value to `[1, 4]` before the cast:
///
/// - `is_finite` guards against NaN / ±Infinity — without this a non-finite
///   value would cast to `usize::MAX` and overflow inside
///   `gaussian_blur_plane`.
/// - The upper bound of 4 is 2× the declared model max — generous head-room
///   for any in-flight XMP yet still small enough that the blur cost stays
///   bounded. The algorithm tolerates larger radii in principle, but
///   anything above 4 px would only make sense paired with the true-sigma
///   path (tracked in the follow-up KTLO ticket #320).
pub(super) fn capture_sharpening_params_from_model(
    model: &AdjustmentModel,
) -> Option<capture_sharpening::CaptureSharpeningParams> {
    if !model.capture_sharpening_amount.is_finite()
        || !model.capture_sharpening_radius.is_finite()
    {
        return None;
    }
    if model.capture_sharpening_amount <= 0.0 {
        return None;
    }
    let radius = model.capture_sharpening_radius.round().clamp(1.0, 4.0) as usize;
    let strength = (model.capture_sharpening_amount / 100.0).clamp(0.0, 1.5);
    Some(capture_sharpening::CaptureSharpeningParams {
        radius,
        strength,
        ..capture_sharpening::CaptureSharpeningParams::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: `capture_sharpening_params_from_model` must not let
    /// non-finite or absurdly large XMP values flow through the `f32 →
    /// usize` cast — without the `is_finite` / `clamp` guards a NaN
    /// `amount` slips past `<= 0.0` (NaN comparisons are false) and a
    /// `+Infinity` `radius` casts to `usize::MAX`, which then overflows
    /// inside `gaussian_blur_plane`'s `usize` arithmetic.
    ///
    /// We don't run the full pipeline — the cast happens entirely in this
    /// helper, so calling it with each pathological value and asserting
    /// (a) no panic, (b) `radius` lands inside the declared `[1, 4]`
    /// clamp range when the helper does return params, is enough.
    #[test]
    fn capture_sharpening_params_clamp_pathological_inputs() {
        let bad_amounts = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        let non_finite_radii = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        let huge_finite_radii = [f32::MAX, f32::MIN, 1.0e30, -1.0e30, 0.0, -2.0];

        // Non-finite amount → must short-circuit to None regardless of radius.
        for amount in bad_amounts {
            for &radius in non_finite_radii.iter().chain(huge_finite_radii.iter()) {
                let model = AdjustmentModel {
                    capture_sharpening_amount: amount,
                    capture_sharpening_radius: radius,
                    ..AdjustmentModel::default()
                };
                let params = capture_sharpening_params_from_model(&model);
                assert!(
                    params.is_none(),
                    "non-finite amount {amount} (radius {radius}) should return None"
                );
            }
        }

        // Non-finite radius with a finite, > 0 amount → return None
        // (defensive: the radius is unusable, so skip the stage entirely
        // rather than guess an integer for the user).
        for radius in non_finite_radii {
            let model = AdjustmentModel {
                capture_sharpening_amount: 50.0,
                capture_sharpening_radius: radius,
                ..AdjustmentModel::default()
            };
            assert!(
                capture_sharpening_params_from_model(&model).is_none(),
                "non-finite radius {radius} (amount=50) should return None"
            );
        }

        // Finite-but-pathological radius (huge, negative, zero) paired
        // with a finite > 0 amount → must still return params, but radius
        // must be inside the [1, 4] clamp and strength finite. Catches
        // the `f32::MAX as usize` overflow path.
        for &radius in &huge_finite_radii {
            let model = AdjustmentModel {
                capture_sharpening_amount: 50.0,
                capture_sharpening_radius: radius,
                ..AdjustmentModel::default()
            };
            let params = capture_sharpening_params_from_model(&model)
                .expect("amount=50 with finite radius should produce Some(params)");
            assert!(
                params.radius >= 1 && params.radius <= 4,
                "radius {} (input {radius}) outside [1, 4] clamp",
                params.radius
            );
            assert!(
                params.strength.is_finite() && params.strength > 0.0,
                "strength {} not finite-positive",
                params.strength
            );
        }
    }
}
