//! Native full-size export keeps the shared display tail at f32 (#1472).
//! Quantization belongs to the destination encoder, never a baked host cube.
use super::{render_display_scene, render_display_scene_with_removals, RawInput};
use crate::{
    film::FilmLut,
    image::{ExifOrientation, Image, RawImage},
    pipeline::{orient::apply_orientation_f32_rgba, RenderQuality, ResolvedCalibrationRemovals},
    stages::{crop, perspective},
    types::accepted_removal::ContentDigest,
    view::encode::TargetPrimaries,
    xmp::AdjustmentModel,
};

/// Display-encoded RGBA, with EXIF, manual geometry and crop applied once.
/// The fit uses native render-size artifacts, exactly like shared full export.
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

impl ResolvedCalibrationRemovals {
    /// The same float terminal after verified source-bound saved composition.
    pub fn render_export_f32(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: RenderQuality,
        source: Option<RawInput<'_>>,
        target: TargetPrimaries,
        film: Option<&FilmLut>,
    ) -> crate::Result<(u32, u32, Vec<f32>)> {
        let (scene, _) = render_display_scene_with_removals(
            raw,
            model,
            quality,
            source,
            None,
            target,
            film,
            crate::CancelToken::never(),
            Some((self, original)),
        )?;
        Ok(finish(scene, raw.orientation, model))
    }
}

fn finish(
    scene: Image,
    orientation: ExifOrientation,
    model: &AdjustmentModel,
) -> (u32, u32, Vec<f32>) {
    let (width, height) = (scene.width, scene.height);
    let mut rgba = Vec::with_capacity(scene.pixels.len() * 4);
    for pixel in scene.pixels {
        rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 1.0]);
    }
    // Keep the owned allocation for identity transforms, including 100MP.
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
