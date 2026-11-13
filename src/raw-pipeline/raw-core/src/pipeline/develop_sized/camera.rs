//! Sized develop with accepted removal patches composited into the
//! pre-optics camera plate (#3955). An empty stack is never routed here.
use super::{
    develop_sized_after_colour, develop_sized_after_dehaze, develop_sized_camera,
    develop_sized_camera_geometry, develop_sized_camera_unwarped,
};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    image::{Image, RawImage},
    pipeline::{
        capture_first::Chain,
        develop::{develop_colour, CameraReady},
        dump_after,
        removal_calibration::{composite_camera_sampled, sensor_buffer_window},
        stage, RenderQuality,
    },
    stages::dehaze,
    types::{AdjustmentModel, InpaintPatch},
};

/// [`super::develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain`]
/// with the accepted replacements composited before optics and downsample.
pub(in crate::pipeline) fn develop_with_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
    patches: &[InpaintPatch],
) -> Result<(Image, f32)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (frame_w, frame_h) = crate::pipeline::native_render_dims(raw);
    let rastered = &*crate::types::with_brush_rasters(model, frame_w, frame_h);
    let (camera_rgb, input) =
        camera_with_patches(raw, rastered, quality, max_long_edge, cancel, patches)?.colour(
            raw,
            rastered,
            Chain::Sized,
            cancel,
        );
    let (scene, ae_gain) = develop_colour(camera_rgb, input)?;
    let mut scene = develop_sized_after_colour(scene, rastered, cancel)?;
    stage("sized_dehaze", || {
        dehaze::apply(&mut scene, rastered.dehaze)
    });
    dump_after("12_dehaze", &scene);
    let mut scene = develop_sized_after_dehaze(scene, raw, rastered)?;
    crate::pipeline::sized_detail::apply(&mut scene, raw, model, cancel)?;
    Ok((scene, ae_gain))
}

/// The sized profile-ready camera buffer with the replacements composited.
/// The Whites statistic stays the original sized plate's; the original plate
/// is released before the bounded prefix is rebuilt.
pub(in crate::pipeline) fn camera_with_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
    patches: &[InpaintPatch],
) -> Result<CameraReady> {
    let original = develop_sized_camera(raw, model, quality, max_long_edge, cancel)?;
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
    let (mut unwarped, _, divisor) =
        develop_sized_camera_unwarped(raw, model, quality, max_long_edge, cancel)?;
    let window = sensor_buffer_window(raw, [unwarped.width, unwarped.height], divisor);
    composite_camera_sampled(&mut unwarped, patches, &profile, window, divisor)?;
    let composited =
        develop_sized_camera_geometry(raw, model, unwarped, skip_pre_gain, divisor, max_long_edge)?;
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
