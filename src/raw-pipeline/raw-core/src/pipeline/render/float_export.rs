//! Full-size export that keeps the shared display tail at f32 (#5163): the
//! quantizer belongs to the destination encoder, never to a baked host cube.
//!
//! Shares the display and geometry tail with the canvas and quantized export,
//! while enforcing native output dimensions. A rejected Auto fit restores
//! Neutral exposure; a successful fit runs in sRGB before conversion to P3.
use super::{
    auto_fit, render_display_scene, render_display_scene_with_context, RawInput, RenderQuality,
};
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
    // This terminal promises native dimensions even to compatibility Preview callers.
    let quality = if quality == RenderQuality::Preview {
        RenderQuality::Full
    } else {
        quality
    };
    // Auto artifacts are fitted in encoded sRGB, never P3 channel values.
    // Neutral (including Auto without an available fit) keeps the wider P3 hull.
    let auto_available = auto_has_fit(raw, model, quality, source);
    let srgb_auto = target == TargetPrimaries::P3 && auto_available;
    let working_target = if srgb_auto {
        TargetPrimaries::Srgb
    } else {
        target
    };
    let (mut scene, context) =
        render_display_scene_with_context(raw, model, quality, source, None, working_target, film)?;
    if auto_available && context.profile_curve.is_none() && context.profile_lut.is_none() {
        // A cache marker or extractable preview predicts a fit but cannot prove
        // one succeeded. Restore Neutral auto-exposure in the destination primaries
        // if no Auto tail was produced; rotating an already gamut-mapped sRGB buffer would
        // permanently discard colours the P3 destination can represent.
        drop(scene);
        let neutral = AdjustmentModel {
            profile: Profile::Neutral,
            ..model.clone()
        };
        let scene = render_display_scene(raw, &neutral, quality, source, None, target, film)?;
        return Ok(finish(scene, raw.orientation, model));
    }
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
    source.is_some_and(|source| auto_fit::preview_for_fit(&source, key.as_ref()).is_ok())
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
