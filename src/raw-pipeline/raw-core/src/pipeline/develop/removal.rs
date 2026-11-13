//! The canonical develop with accepted removal patches composited into the
//! pre-optics camera plate (#3955). An empty stack is never routed here.
use super::{
    develop_after_colour, develop_camera, develop_camera_geometry, develop_camera_unwarped,
    develop_colour, effective_quality_divisor, CameraReady,
};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{Image, RawImage},
    pipeline::{
        capture_first::Chain,
        removal_calibration::{composite_camera_sampled, sensor_buffer_window},
        stage, RenderQuality,
    },
    types::{AdjustmentModel, InpaintPatch},
};

/// [`super::develop_scene_linear_from_raw_with_quality_cancellable_with_gain`]
/// with the accepted replacements composited before optical geometry.
pub(in crate::pipeline) fn develop_with_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
    patches: &[InpaintPatch],
) -> Result<(Image, f32)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (frame_w, frame_h) = crate::pipeline::native_render_dims(raw);
    let model = &*crate::types::with_brush_rasters(model, frame_w, frame_h);
    let haze = crate::pipeline::develop_sized::frame_haze(raw, model, cancel)?;
    let (camera_rgb, input) = develop_camera_with_patches(raw, model, quality, cancel, patches)?
        .colour(raw, model, Chain::Full, cancel);
    let (scene, ae_gain) = develop_colour(camera_rgb, input)?;
    develop_after_colour(scene, raw, model, haze.as_ref(), cancel).map(|scene| (scene, ae_gain))
}

/// The profile-ready camera buffer with the replacements composited. The
/// Whites statistic stays the original plate's, so a removal never moves the
/// global tone anchor; the original plate is released before the rebuild.
fn develop_camera_with_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
    patches: &[InpaintPatch],
) -> Result<CameraReady> {
    let original = develop_camera(raw, model, quality, cancel)?;
    if patches.is_empty() {
        return Ok(original);
    }
    let CameraReady {
        camera_rgb,
        profile,
        profile_source,
        skip_pre_gain,
        whites_anchor_ev,
    } = original;
    drop(camera_rgb);
    let (mut camera, _) = develop_camera_unwarped(raw, model, quality, cancel)?;
    let divisor = effective_quality_divisor(quality, raw.cfa);
    let window = sensor_buffer_window(raw, [camera.width, camera.height], divisor);
    stage("removal_camera_composite", || {
        composite_camera_sampled(&mut camera, patches, &profile, window, divisor)
    })?;
    let composited = develop_camera_geometry(raw, model, quality, camera, skip_pre_gain)?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(CameraReady {
        camera_rgb: composited.camera_rgb,
        profile,
        profile_source,
        skip_pre_gain,
        whites_anchor_ev,
    })
}
