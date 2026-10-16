//! Resolve name-only imported Auto WB before camera preparation (#4669).
//!
//! This uses the existing shared estimator on the complete unedited RAW.
//! Numeric sidecar components are authoritative. Callers retaining a live
//! session must retain the resolved pair too; estimation is import work.

use std::borrow::Cow;

use crate::{
    cancel::CancelToken,
    image::RawImage,
    pipeline::{develop_scene_linear_from_raw_with_quality_cancellable, RenderQuality},
    types::{WbScaleVersion, WbSource},
    xmp::AdjustmentModel,
    Error, Result,
};

pub fn needs_resolution(model: &AdjustmentModel) -> bool {
    model.unresolved_auto_wb && !model.temperature_seen && !model.tint_seen
}

/// The same WB estimate as global AUTO on a fresh image, without computing
/// or applying its exposure/tone recommendations. The explicit neutral probe
/// clears unresolved intent, preventing recursive import analysis.
pub fn estimate(raw: &RawImage, cancel: CancelToken<'_>) -> Result<(f32, f32)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let probe_model = super::auto_adjustments::probe_model(&AdjustmentModel::default());
    let probe = develop_scene_linear_from_raw_with_quality_cancellable(
        raw,
        &probe_model,
        RenderQuality::Preview,
        cancel,
    )?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(super::auto_adjustments_awb::compute_awb(
        &probe,
        raw,
        &probe_model,
    ))
}

/// Apply an already resolved pair to an owned request model without allocating.
/// Live callers can retain the estimate and use this on subsequent requests.
pub fn apply_estimate(model: &mut AdjustmentModel, pair: (f32, f32)) {
    if !needs_resolution(model) {
        return;
    }
    model.temperature = pair.0;
    model.tint = pair.1;
    model.temperature_seen = true;
    model.tint_seen = true;
    model.unresolved_auto_wb = false;
    model.wb_scale_version = WbScaleVersion::V5;
    model.wb_source = WbSource::Auto;
    model.wb_algorithm_version = super::auto_adjustments::AUTO_WB_ALGORITHM_VERSION as f32;
}

/// Borrow ordinary models unchanged; only unresolved imported Auto needs an
/// owned resolved model. Originals and the caller's parsed model remain intact.
pub fn resolve<'a>(
    raw: &RawImage,
    model: &'a AdjustmentModel,
    cancel: CancelToken<'_>,
) -> Result<Cow<'a, AdjustmentModel>> {
    if !needs_resolution(model) {
        return Ok(Cow::Borrowed(model));
    }
    let pair = estimate(raw, cancel)?;
    let mut resolved = model.clone();
    apply_estimate(&mut resolved, pair);
    Ok(Cow::Owned(resolved))
}

/// One estimate retained by a session that owns one decoded RAW. Recreate this
/// cache with the session when its source changes. Ordinary requests do no work.
#[derive(Default)]
pub struct CachedEstimate {
    pair: Option<(f32, f32)>,
}

impl CachedEstimate {
    pub fn resolve_in_place(
        &mut self,
        raw: &RawImage,
        model: &mut AdjustmentModel,
        cancel: CancelToken<'_>,
    ) -> Result<()> {
        if !needs_resolution(model) {
            return Ok(());
        }
        let pair = match self.pair {
            Some(pair) => pair,
            None => {
                let pair = estimate(raw, cancel)?;
                self.pair = Some(pair);
                pair
            }
        };
        apply_estimate(model, pair);
        Ok(())
    }
}

#[cfg(test)]
#[path = "imported_auto_wb_tests.rs"]
mod tests;
