//! Capture-first decode products for hosts (#5377): the capture result in
//! the fixed as-shot basis, EXIF-oriented f32 RGBA, and the creative stage a
//! host runs per tick to render it. See docs/pipeline.md § "The capture
//! decode".

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::image::{Image, RawImage};
use crate::pipeline::capture_first::{Chain, CreativeHeader, CreativeStage, CreativeWire};
use crate::pipeline::develop::{capture_colour, develop_camera};
use crate::pipeline::develop_sized::develop_sized_camera;
use crate::pipeline::orient::apply_orientation_f32_rgba;
use crate::pipeline::{finite_or_zero, stage, RenderQuality};
use crate::xmp::AdjustmentModel;

/// One capture decode.
pub struct CaptureRender {
    pub width: u32,
    pub height: u32,
    /// The capture result in the fixed as-shot basis, oriented, alpha 1.
    pub rgba: Vec<f32>,
    pub creative: CreativeHeader,
    pub tables: CreativeWire,
    pub whites_anchor_ev: f32,
    pub nr_sampling_scale: f32,
}

/// The full-resolution capture decode.
pub fn render_capture_from_raw_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<CaptureRender> {
    let (camera, input) =
        develop_camera(raw, model, quality, cancel)?.colour(raw, model, Chain::Full, cancel);
    finish(raw, model, capture_colour(camera, input)?)
}

/// The capture decode downsampled to `max_long_edge` before the capture
/// stages, as the sized develop does.
pub fn render_capture_sized_from_raw_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<CaptureRender> {
    let (camera, input) = develop_sized_camera(raw, model, quality, max_long_edge, cancel)?.colour(
        raw,
        model,
        Chain::Sized,
        cancel,
    );
    finish(raw, model, capture_colour(camera, input)?)
}

fn finish(
    raw: &RawImage,
    model: &AdjustmentModel,
    (capture, creative): (Image, CreativeStage),
) -> Result<CaptureRender> {
    let (header, tables) = creative.transport(model.highlight_recovery)?;
    let rgba = stage("pack_capture_rgba_f32", || {
        let mut v = Vec::with_capacity(capture.pixels.len() * 4);
        for p in &capture.pixels {
            v.extend_from_slice(&[
                finite_or_zero(p[0]),
                finite_or_zero(p[1]),
                finite_or_zero(p[2]),
                1.0,
            ]);
        }
        v
    });
    let (width, height, rgba) = stage("apply_orientation_capture_rgba", || {
        apply_orientation_f32_rgba(&rgba, capture.width, capture.height, raw.orientation)
    });
    Ok(CaptureRender {
        width,
        height,
        rgba,
        creative: header,
        tables,
        whites_anchor_ev: capture
            .whites_anchor_ev
            .expect("the capture decode records the full-frame Whites anchor"),
        nr_sampling_scale: capture.nr_sampling_scale,
    })
}
