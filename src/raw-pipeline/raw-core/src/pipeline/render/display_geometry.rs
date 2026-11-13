//! Display render that also reports the oriented crop-input extent (#3941).
use super::{finish, render_display_scene_with_context, stage, RawInput, RenderQuality};
use crate::{
    error::Result,
    film,
    image::RawImage,
    view::{auto_profile::AutoFitOutcome, encode},
    xmp::AdjustmentModel,
};

/// Display render plus the actual oriented crop-input extent, measured from the
/// developed display buffer rather than estimated from sensor dimensions (#3941).
pub struct DisplayRender {
    pub pixels: (u32, u32, Vec<u8>),
    pub crop_input_size: [u32; 2],
    pub auto_fit: Option<AutoFitOutcome>,
}

impl DisplayRender {
    fn from_quantized(
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        orientation: crate::image::ExifOrientation,
        model: &AdjustmentModel,
        auto_fit: Option<AutoFitOutcome>,
    ) -> Self {
        let crop_input_size = if orientation.swaps_wh() {
            [height, width]
        } else {
            [width, height]
        };
        let pixels = finish::apply_geometry(
            bytes,
            width,
            height,
            orientation,
            &crate::stages::perspective::Perspective::from_model(model),
            &model.crop,
        );
        Self {
            pixels,
            crop_input_size,
            auto_fit,
        }
    }
}

/// [`render_from_raw_with_auto_fit`] that also reports the crop-input extent
/// the removal geometry inverts (#3941).
pub fn render_display_with_geometry(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: Option<u32>,
    film_lut: Option<&film::FilmLut>,
) -> Result<DisplayRender> {
    let (mut scene, context) = render_display_scene_with_context(
        raw,
        model,
        quality,
        raw_source,
        max_long_edge,
        encode::TargetPrimaries::Srgb,
        film_lut,
    )?;
    let (w, h) = (scene.width, scene.height);
    let bytes = stage("dither_and_quantize", || {
        encode::dither_and_quantize(&mut scene)
    });
    Ok(DisplayRender::from_quantized(
        bytes,
        w,
        h,
        raw.orientation,
        model,
        context.auto_fit,
    ))
}
