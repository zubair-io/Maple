//! Full-size export that keeps the shared display tail at f32 (#5163): the
//! quantizer belongs to the destination encoder, never to a baked host cube.
//!
//! Shares [`render_display_scene`] with the canvas and the 8/16-bit export
//! terminals, so everything that decides colour has already run by the time
//! the buffer comes back here — this file only packs RGBA and applies the
//! same geometry tail the quantized terminals apply.
use super::{render_display_scene, RawInput, RenderQuality};
use crate::{
    film::FilmLut,
    image::{ExifOrientation, Image, RawImage},
    pipeline::orient::apply_orientation_f32_rgba,
    stages::{crop, perspective},
    view::encode::TargetPrimaries,
    xmp::AdjustmentModel,
};

/// Display-encoded, straight-alpha RGBA f32 in `target` primaries at native
/// resolution, with EXIF orientation, manual geometry and crop applied once —
/// the framing the 8/16-bit export terminals produce, one step short of their
/// quantizer.
pub fn render_export_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    source: Option<RawInput<'_>>,
    target: TargetPrimaries,
    film: Option<&FilmLut>,
) -> crate::Result<(u32, u32, Vec<f32>)> {
    let scene = render_display_scene(raw, model, quality, source, None, target, film)?;
    Ok(finish(scene, raw.orientation, model))
}

fn finish(
    scene: Image,
    orientation: ExifOrientation,
    model: &AdjustmentModel,
) -> (u32, u32, Vec<f32>) {
    let (width, height) = (scene.width, scene.height);
    let rgba: Vec<f32> = scene
        .pixels
        .iter()
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 1.0])
        .collect();
    let (w, h, oriented) = if orientation == ExifOrientation::Normal {
        (width, height, rgba)
    } else {
        apply_orientation_f32_rgba(&rgba, width, height, orientation)
    };
    let geometry = perspective::Perspective::from_model(model);
    let warped = if geometry.is_identity() {
        oriented
    } else {
        let inverse = geometry.inverse_matrix(perspective::aspect_ratio(w, h));
        perspective::warp_f32_rgba(&oriented, w, h, &inverse)
    };
    if model.crop.is_identity() {
        (w, h, warped)
    } else {
        crop::apply_f32_rgba(&warped, w, h, &model.crop)
    }
}

#[cfg(test)]
#[path = "float_export_tests.rs"]
mod tests;
