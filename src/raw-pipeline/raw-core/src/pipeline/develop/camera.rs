//! Camera-native decode prefix, before user WB and DCP, for the removal
//! calibration plate (#3955). The same stages as the canonical chain's
//! `develop_camera`, exposed without the profile it develops through.

use crate::pipeline::RenderQuality;
use crate::{
    cancel::CancelToken, error::Result, image::Image, image::RawImage, xmp::AdjustmentModel,
};

pub(in crate::pipeline) fn prepare(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(Image, bool)> {
    let ready = super::develop_camera(raw, model, quality, cancel)?;
    Ok((ready.camera_rgb, ready.skip_pre_gain))
}

/// Sensor-sized camera RGB before any optical correction or DefaultCrop.
/// Removal's fixed plate is transported here, so the normal optical stages
/// subsequently process originals and replacements together (#3955).
#[cfg(test)]
pub(in crate::pipeline) fn prepare_unwarped(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(Image, bool)> {
    super::develop_camera_unwarped(raw, model, quality, cancel)
}
