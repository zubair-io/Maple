use crate::{
    cancel::CancelToken,
    color::dcp::DcpProfile,
    error::{Error, Result},
    image::{Image, RawImage},
    pipeline::{
        develop::{camera, effective_quality_divisor},
        removal_calibration::{composite_camera_sampled, sensor_buffer_window},
        stage, RenderQuality,
    },
    types::{AdjustmentModel, InpaintPatch},
};

/// Rebuild the pre-optics camera plate, composite accepted removal patches,
/// then resume normal geometry. The original plate is released by the caller
/// first, so this native-size pass does not retain two full RGB buffers.
pub(super) fn apply_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
    patches: &[InpaintPatch],
    profile: &DcpProfile,
) -> Result<Image> {
    let (mut camera, _) = camera::prepare_unwarped(raw, model, quality, cancel)?;
    let divisor = effective_quality_divisor(quality, raw.cfa);
    let window = sensor_buffer_window(raw, [camera.width, camera.height], divisor);
    stage("removal_camera_composite", || {
        composite_camera_sampled(&mut camera, patches, profile, window, divisor)
    })?;
    let output = camera::finish_geometry(raw, model, quality, camera)?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(output)
}
