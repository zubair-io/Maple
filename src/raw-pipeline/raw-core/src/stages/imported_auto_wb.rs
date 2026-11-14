//! Resolve name-only imported Auto WB off the first-frame path (#4669).
//!
//! A sidecar that says `crs:WhiteBalance="Auto"` without `Temperature`/`Tint`
//! needs the shared estimator's pair. Interactive sessions must not wait for
//! it: they render the first frame As Shot, call [`CachedEstimate::resolve`]
//! once off the render thread, and re-render once. [`CachedEstimate::apply`]
//! builds each request's model: the cached pair when resolved, As Shot until
//! then, never analysis. Final-output entries (export, thumbnails, CLI) have
//! no first frame to protect and call [`resolve`] themselves. Numeric
//! components always take precedence, and the authored model and its sidecar
//! keep their name-only intent.

use std::borrow::Cow;

use crate::{
    cancel::CancelToken,
    image::RawImage,
    pipeline::{develop_scene_linear_sized_from_raw_with_quality_cancellable, RenderQuality},
    types::{WbScaleVersion, WbSource},
    xmp::AdjustmentModel,
    Result,
};

pub fn needs_resolution(model: &AdjustmentModel) -> bool {
    model.unresolved_auto_wb && !model.temperature_seen && !model.tint_seen
}

/// A full-frame probe costs seconds on a 100 MP RAW; the WB statistics
/// survive a proxy, as the Auto profile fit's do (#3510).
pub const PROBE_LONG_EDGE: u32 = 1536;

/// The shared AUTO WB estimator on a fresh image's proxy probe, without
/// computing or applying its exposure/tone recommendations. The neutral probe
/// model clears unresolved intent, so analysis never recurses. A cancelled
/// estimate returns `Err(Cancelled)` within one row or pass of the host's
/// request and keeps nothing: asked again later, it returns the same pair.
pub fn estimate(raw: &RawImage, cancel: CancelToken<'_>) -> Result<(f32, f32)> {
    cancel.check()?;
    let probe_model = super::auto_adjustments::probe_model(&AdjustmentModel::default());
    let probe = develop_scene_linear_sized_from_raw_with_quality_cancellable(
        raw,
        &probe_model,
        RenderQuality::Preview,
        PROBE_LONG_EDGE,
        cancel,
    )?;
    cancel.check()?;
    let pair =
        super::auto_adjustments_awb::compute_awb_cancellable(&probe, raw, &probe_model, cancel);
    cancel.check()?;
    Ok(pair)
}

/// The pair one session resolved for its decoded RAW. Recreate with the
/// session when its source changes.
#[derive(Clone, Copy, Debug, Default)]
pub struct CachedEstimate {
    pair: Option<(f32, f32)>,
}

impl CachedEstimate {
    pub fn pair(&self) -> Option<(f32, f32)> {
        self.pair
    }

    /// Estimate once and retain the pair; later calls return it unchanged.
    pub fn resolve(&mut self, raw: &RawImage, cancel: CancelToken<'_>) -> Result<(f32, f32)> {
        if let Some(pair) = self.pair {
            return Ok(pair);
        }
        let pair = estimate(raw, cancel)?;
        self.pair = Some(pair);
        Ok(pair)
    }

    /// Prepare a session request's model without analysis: overlay the
    /// retained pair, or render As Shot while it is still unresolved.
    /// Ordinary and explicitly authored models are untouched.
    pub fn apply(&self, model: &mut AdjustmentModel) {
        if !needs_resolution(model) {
            return;
        }
        match self.pair {
            Some(pair) => apply_pair(model, pair),
            None => model.unresolved_auto_wb = false,
        }
    }
}

/// Borrow ordinary models unchanged; only unresolved imported Auto needs an
/// owned model carrying the estimate. The caller's parsed model stays intact.
pub fn resolve<'a>(
    raw: &RawImage,
    model: &'a AdjustmentModel,
    cancel: CancelToken<'_>,
) -> Result<Cow<'a, AdjustmentModel>> {
    if !needs_resolution(model) {
        return Ok(Cow::Borrowed(model));
    }
    let mut resolved = model.clone();
    apply_pair(&mut resolved, estimate(raw, cancel)?);
    Ok(Cow::Owned(resolved))
}

/// Overlay a resolved pair on a render model as if it had been authored.
pub fn apply_pair(model: &mut AdjustmentModel, pair: (f32, f32)) {
    model.temperature = pair.0;
    model.tint = pair.1;
    model.temperature_seen = true;
    model.tint_seen = true;
    model.unresolved_auto_wb = false;
    model.wb_scale_version = WbScaleVersion::V5;
    model.wb_source = WbSource::Auto;
    model.wb_algorithm_version = super::auto_adjustments::AUTO_WB_ALGORITHM_VERSION as f32;
}

#[cfg(test)]
#[path = "imported_auto_wb_tests.rs"]
mod tests;
