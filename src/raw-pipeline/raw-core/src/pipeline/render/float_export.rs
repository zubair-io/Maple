//! Full-size export that keeps the shared display tail at f32 (#5163): the
//! quantizer belongs to the destination encoder, never to a baked host cube.
//!
//! Shares [`render_display_scene`] with the canvas and the 8/16-bit export
//! terminals, so everything that decides colour has already run by the time
//! the buffer comes back here — this file only packs RGBA and applies the
//! same geometry tail the quantized terminals apply.
use super::{auto_fit, render_display_scene, RawInput, RenderQuality};
use crate::{
    film::FilmLut,
    image::{ExifOrientation, Image, RawImage},
    pipeline::orient::apply_orientation_f32_rgba,
    stages::{crop, perspective},
    types::Profile,
    view::{
        auto_profile,
        encode::{self, TargetPrimaries},
    },
    xmp::AdjustmentModel,
};
use rayon::prelude::*;

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
    // Auto artifacts are fitted in encoded sRGB, never P3 channel values.
    // Neutral (including Auto without an available fit) keeps the wider P3 hull.
    let srgb_auto = target == TargetPrimaries::P3 && auto_has_fit(raw, model, quality, source);
    let working_target = if srgb_auto {
        TargetPrimaries::Srgb
    } else {
        target
    };
    let mut scene = render_display_scene(raw, model, quality, source, None, working_target, film)?;
    if srgb_auto {
        scene.pixels.par_iter_mut().for_each(|pixel| {
            *pixel = crate::color::matrices::M_SRGB_TO_P3
                .mul_vec(pixel.map(encode::srgb_degamma))
                .map(encode::srgb_gamma);
        });
    }
    Ok(finish(scene, raw.orientation, model))
}

fn auto_has_fit(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    source: Option<RawInput<'_>>,
) -> bool {
    if model.profile != Profile::Auto || std::env::var_os("MAPLE_DISABLE_AUTO_PROFILE").is_some() {
        return false;
    }
    let key = match source {
        Some(RawInput::Path(path)) => auto_profile::cache::CacheKey::from_path(path, quality),
        Some(RawInput::Bytes { bytes, .. }) => {
            Some(auto_profile::cache::CacheKey::from_bytes(bytes, quality))
        }
        None => return false,
    }
    .map(|key| key.with_origin(auto_fit::render_fit_origin(raw.width.max(raw.height), None)));
    if key.as_ref().is_some_and(|key| {
        auto_profile::cache::get(key).is_some() || auto_profile::cache::get_lut(key).is_some()
    }) {
        return true;
    }
    match source {
        Some(RawInput::Path(path)) => auto_profile::preview::extract_for_fit(path).is_some(),
        Some(RawInput::Bytes { bytes, ext }) => {
            auto_profile::preview::extract_for_fit_from_bytes(bytes, ext).is_some()
        }
        None => false,
    }
}

fn finish(
    scene: Image,
    orientation: ExifOrientation,
    model: &AdjustmentModel,
) -> (u32, u32, Vec<f32>) {
    let (width, height) = (scene.width, scene.height);
    let rgba: Vec<f32> = scene
        .pixels
        .into_iter()
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 1.0])
        .collect();
    let (w, h, oriented) = {
        let input = rgba;
        if orientation == ExifOrientation::Normal {
            (width, height, input)
        } else {
            apply_orientation_f32_rgba(&input, width, height, orientation)
        }
    };
    let geometry = perspective::Perspective::from_model(model);
    let warped = {
        let input = oriented;
        if geometry.is_identity() {
            input
        } else {
            let inverse = geometry.inverse_matrix(perspective::aspect_ratio(w, h));
            perspective::warp_f32_rgba(&input, w, h, &inverse)
        }
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
