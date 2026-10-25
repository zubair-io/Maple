//! Capture-first decode products for hosts (#5377): the capture result in
//! the fixed as-shot basis, EXIF-oriented f32 RGBA, and the creative stage a
//! host runs per tick to render it. See docs/pipeline.md § "The capture
//! decode".

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::image::{ExifOrientation, Image, RawImage};
use crate::pipeline::capture_first::{
    CaptureBase, Chain, CreativeHeader, CreativeStage, CreativeWire,
};
use crate::pipeline::develop::{capture_base, capture_colour, develop_camera};
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
    finish(model, capture_colour(camera, input)?, raw.orientation)
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
    let capture = sized_capture(raw, model, quality, max_long_edge, cancel)?;
    finish(model, capture, raw.orientation)
}

/// [`render_capture_sized_from_raw_f32`] left in sensor framing, for a host
/// whose live chain orients at present (Web).
pub fn render_capture_sized_sensor_framed_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<CaptureRender> {
    let capture = sized_capture(raw, model, quality, max_long_edge, cancel)?;
    finish(model, capture, ExifOrientation::Normal)
}

fn sized_capture(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(Image, CreativeStage)> {
    let (camera, input) = develop_sized_camera(raw, model, quality, max_long_edge, cancel)?.colour(
        raw,
        model,
        Chain::Sized,
        cancel,
    );
    capture_colour(camera, input)
}

/// The capture decode (full resolution, or downsampled to `max_long_edge`)
/// and its [`CaptureBase`] (#5381), so a later chroma prefilter, BM3D or
/// capture-sharpening change can refine from the base. `loaded` is the model
/// as the host supplied it; `model` the one developed (after the decode's
/// own overrides). The capture stages run on the base, so the render equals
/// [`render_capture_sized_from_raw_f32`]'s pixels.
pub fn render_capture_with_base_from_raw_f32(
    raw: &RawImage,
    (loaded, model): (&AdjustmentModel, &AdjustmentModel),
    quality: RenderQuality,
    max_long_edge: Option<u32>,
    cancel: CancelToken<'_>,
) -> Result<(CaptureRender, CaptureBase)> {
    let (chain, ready) = match max_long_edge {
        Some(edge) => (
            Chain::Sized,
            develop_sized_camera(raw, model, quality, edge, cancel)?,
        ),
        None => (Chain::Full, develop_camera(raw, model, quality, cancel)?),
    };
    let (camera, input) = ready.colour(raw, model, chain, cancel);
    let base = capture_base(camera, input, loaded)?;
    let capture = base.refine_cpu(model, chain, cancel)?;
    let render = finish_refine(&base, capture, model, chain)?;
    Ok((render, base))
}

/// A refine of `base` at `model` (from [`CaptureBase::refine_model`]),
/// given the refinable stages' output as sensor-frame RGBA, packed exactly
/// as the decode packs its own result.
pub fn finish_capture_refine(
    base: &CaptureBase,
    rgba: &[f32],
    model: &AdjustmentModel,
) -> Result<CaptureRender> {
    let capture = base.image_from_rgba(rgba)?;
    finish_refine(base, capture, model, Chain::Full)
}

fn finish_refine(
    base: &CaptureBase,
    capture: Image,
    model: &AdjustmentModel,
    chain: Chain,
) -> Result<CaptureRender> {
    let creative = base.creative_for(&capture, model, chain)?;
    finish(model, (capture, creative), base.orientation)
}

fn finish(
    model: &AdjustmentModel,
    (capture, creative): (Image, CreativeStage),
    orientation: ExifOrientation,
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
    let (width, height, rgba) = if orientation == ExifOrientation::Normal {
        (capture.width, capture.height, rgba)
    } else {
        stage("apply_orientation_capture_rgba", || {
            apply_orientation_f32_rgba(&rgba, capture.width, capture.height, orientation)
        })
    };
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
