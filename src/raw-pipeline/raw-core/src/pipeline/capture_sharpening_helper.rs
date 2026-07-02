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

/// Upper bound on the Gaussian sigma we'll accept from XMP, in pixels.
/// The declared model range is `[0.5, 2.0]`, so 8.0 is generous head-room
/// while still bounding the windowed kernel size (`2 * ceil(3 * sigma) + 1`,
/// i.e. ≤ 49 taps) and preventing absurd XMPs from blowing out runtime.
const MAX_SIGMA_PX: f32 = 8.0;

/// Translate the AdjustmentModel's user-facing capture-sharpening sliders
/// into the stage's [`capture_sharpening::CaptureSharpeningParams`]. Returns
/// `None` when the stage should be skipped (default identity: amount = 0).
///
/// Reads [`AdjustmentModel::capture_sharpening_sigma`] (renamed from
/// `capture_sharpening_radius` in #456 to reflect the PR #452 PSF swap from
/// integer-radius tripled-box-blur to a true Gaussian). The XMP parser
/// writes both `papp:CaptureSharpeningSigma` and the legacy
/// `papp:CaptureSharpeningRadius` into this field — see `xmp::parse`.
///
/// - `is_finite` guards against NaN / ±Infinity on either field.
/// - `amount <= 0` short-circuits the stage entirely (the off-by-default
///   path), so this is also the structural "off = no-op" guarantee.
/// - sigma is clamped to `(0, MAX_SIGMA_PX]` so an out-of-range XMP cannot
///   blow up kernel size.
pub(super) fn capture_sharpening_params_from_model(
    model: &AdjustmentModel,
) -> Option<capture_sharpening::CaptureSharpeningParams> {
    if !model.capture_sharpening_amount.is_finite() || !model.capture_sharpening_sigma.is_finite() {
        return None;
    }
    if model.capture_sharpening_amount <= 0.0 {
        return None;
    }
    let sigma = model.capture_sharpening_sigma.clamp(1e-3, MAX_SIGMA_PX);
    let strength = (model.capture_sharpening_amount / 100.0).clamp(0.0, 1.5);
    Some(capture_sharpening::CaptureSharpeningParams {
        sigma,
        strength,
        ..capture_sharpening::CaptureSharpeningParams::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: `capture_sharpening_params_from_model` must not let
    /// non-finite or absurdly large XMP values flow through to the stage —
    /// without the `is_finite` / `clamp` guards a NaN `amount` slips past
    /// `<= 0.0` (NaN comparisons are false) and an out-of-range `radius`
    /// would produce a kernel with thousands of taps.
    ///
    /// We don't run the full pipeline — the cast happens entirely in this
    /// helper, so calling it with each pathological value and asserting
    /// (a) no panic, (b) `sigma` lands inside the `(0, MAX_SIGMA_PX]`
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
                    capture_sharpening_sigma: radius,
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
        // (defensive: the sigma is unusable, so skip the stage entirely).
        for radius in non_finite_radii {
            let model = AdjustmentModel {
                capture_sharpening_amount: 50.0,
                capture_sharpening_sigma: radius,
                ..AdjustmentModel::default()
            };
            assert!(
                capture_sharpening_params_from_model(&model).is_none(),
                "non-finite radius {radius} (amount=50) should return None"
            );
        }

        // Finite-but-pathological radius (huge, negative, zero) paired
        // with a finite > 0 amount → must still return params, but sigma
        // must be inside `(0, MAX_SIGMA_PX]` and strength finite.
        for &radius in &huge_finite_radii {
            let model = AdjustmentModel {
                capture_sharpening_amount: 50.0,
                capture_sharpening_sigma: radius,
                ..AdjustmentModel::default()
            };
            let params = capture_sharpening_params_from_model(&model)
                .expect("amount=50 with finite radius should produce Some(params)");
            assert!(
                params.sigma > 0.0 && params.sigma <= MAX_SIGMA_PX,
                "sigma {} (input {radius}) outside (0, {MAX_SIGMA_PX}] clamp",
                params.sigma
            );
            assert!(
                params.sigma.is_finite(),
                "sigma {} (input {radius}) not finite",
                params.sigma
            );
            assert!(
                params.strength.is_finite() && params.strength > 0.0,
                "strength {} not finite-positive",
                params.strength
            );
        }
    }

    /// Default model (amount = 0) returns None — the structural "off by
    /// default" guarantee for the stage.
    #[test]
    fn default_model_returns_none() {
        let model = AdjustmentModel::default();
        assert!(capture_sharpening_params_from_model(&model).is_none());
    }

    /// A typical user-facing slider value (sigma = 1.0 px) maps through
    /// to the stage's `sigma = 1.0` — no implicit rescaling.
    #[test]
    fn sigma_field_passes_through_unchanged() {
        let model = AdjustmentModel {
            capture_sharpening_amount: 50.0,
            capture_sharpening_sigma: 1.0,
            ..AdjustmentModel::default()
        };
        let params = capture_sharpening_params_from_model(&model)
            .expect("amount=50 sigma=1.0 should produce params");
        assert!((params.sigma - 1.0).abs() < 1e-6);
    }
}
