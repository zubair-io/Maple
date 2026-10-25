//! The f32 tile entries that take a host-measured exposure gain, split out of
//! `tile/mod.rs` for the file-size budget.

use super::{develop_tile_oriented_f32, develop_tile_with_frame, TileOutput, TileRect};
use crate::{error::Result, image::RawImage, pipeline::RenderQuality, xmp::AdjustmentModel};

/// f32 (16 B/px) counterpart to
/// [`super::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`],
/// additionally accepting the auto-exposure anchor gain (#1167) a full-image
/// (or sized) develop of the same model already measured — see
/// `pipeline::develop::develop_scene_linear_from_raw_with_quality_with_gain`
/// (or the sized sibling) for how to obtain it. `ae_gain = 1.0` is a
/// bit-identical no-op, so this entry is a strict superset of
/// [`super::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32`], kept
/// as a separate function (rather than widening that one's arity) so
/// existing callers — including the Apple FFI entry point that predates this
/// ticket — are untouched.
pub fn render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
    ae_gain: f32,
) -> Result<(u32, u32, Vec<f32>)> {
    develop_tile_oriented_f32(
        raw,
        model,
        rect,
        quality,
        decoded_wb_anchor,
        ae_gain,
        crate::CancelToken::never(),
    )
}

/// Cooperative cancellation through tile demosaic, repair, sharpening and NR.
/// Existing entries use a never-cancel token and retain identical pixel math.
pub fn render_scene_linear_tile_cancellable_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    decoded_wb_anchor: Option<(f32, f32)>,
    ae_gain: f32,
    cancel: crate::CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>)> {
    develop_tile_oriented_f32(
        raw,
        model,
        rect,
        quality,
        decoded_wb_anchor,
        ae_gain,
        cancel,
    )
}

/// [`render_scene_linear_tile_cancellable_f32`] with the frame's retained
/// haze map (#3287), so the tile need not measure it.
pub(crate) fn render_scene_linear_tile_with_haze_cancellable_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
    ae_gain: f32,
    haze: Option<&crate::stages::dehaze::FrameHaze>,
    cancel: crate::CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = TileOutput::Scene {
        decoded_wb_anchor: None,
        ae_gain,
    };
    develop_tile_with_frame(raw, model, rect, quality, scene, None, haze, cancel)
}
