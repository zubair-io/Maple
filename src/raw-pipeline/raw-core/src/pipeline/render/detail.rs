//! Retained full-frame anchors for a native-detail patch (#1107).
//! The patch consumes the base render's AE and Auto artifacts, never fits
//! a tone curve or measures exposure from a viewport's histogram.

use super::{display_prefix, finish, render_display_scene_with_context, RawInput};
use crate::{
    error::{Error, Result},
    film::FilmLut,
    image::{apply_orientation, ColorSpace, ExifOrientation, Image, RawImage},
    pipeline::{RenderQuality, TileRect},
    view::{auto_profile, encode},
    xmp::AdjustmentModel,
};

pub struct DetailContext {
    pub(super) model: AdjustmentModel,
    pub(super) active_model: AdjustmentModel,
    pub(super) ae_gain: f32,
    pub(super) profile_curve: Option<auto_profile::curve::ProfileCurve>,
    pub(super) profile_lut: Option<auto_profile::lut::ColorLut>,
    pub(super) auto_guard: bool,
}

pub struct DetailRenderOptions<'a> {
    pub quality: RenderQuality,
    pub max_long_edge: u32,
    pub film_lut: Option<&'a FilmLut>,
}

/// The same bounded display render as the CPU canvas, retaining its anchors.
pub fn render_detail_base(
    raw: &RawImage,
    model: &AdjustmentModel,
    source: RawInput<'_>,
    options: DetailRenderOptions<'_>,
) -> Result<(u32, u32, Vec<u8>, DetailContext)> {
    let (mut scene, context) = render_display_scene_with_context(
        raw,
        model,
        options.quality,
        Some(source),
        Some(options.max_long_edge),
        encode::TargetPrimaries::Srgb,
        options.film_lut,
    )?;
    let rgb = encode::dither_and_quantize(&mut scene);
    let (w, h, rgb) =
        finish::apply_geometry(rgb, scene.width, scene.height, raw.orientation, &model.crop);
    Ok((w, h, rgb, context))
}

/// Display-oriented, DefaultCrop-relative source rect. Native pixels only.
/// `max_working_pixels` includes the core's exact spatial overlap, so a
/// large filter halo cannot bypass the host's memory cap.
pub fn render_detail_tile(
    raw: &RawImage,
    context: &DetailContext,
    rect: TileRect,
    film_lut: Option<&FilmLut>,
    max_working_pixels: u64,
) -> Result<(u32, u32, Vec<u8>)> {
    let (native_w, native_h) = super::native_render_dims(raw);
    if !context.model.crop.is_identity() {
        return Err(Error::Pipeline(
            "native detail requires an uncropped canvas".into(),
        ));
    }
    if rect.src_w == 0
        || rect.src_h == 0
        || rect.src_w != rect.out_w
        || rect.src_h != rect.out_h
        || rect
            .src_x
            .checked_add(rect.src_w)
            .is_none_or(|x| x > native_w)
        || rect
            .src_y
            .checked_add(rect.src_h)
            .is_none_or(|y| y > native_h)
    {
        return Err(Error::Pipeline(
            "invalid native-detail source rectangle".into(),
        ));
    }
    let crop = sensor_crop(raw);
    let inverse = inverse_orientation(raw.orientation);
    let sensor_display = if raw.orientation.swaps_wh() {
        (raw.height, raw.width)
    } else {
        (raw.width, raw.height)
    };
    let (display_x, display_y, _, _) = inverse.display_rect_to_sensor(
        crop.0,
        crop.1,
        crop.2,
        crop.3,
        sensor_display.0,
        sensor_display.1,
    );
    let absolute = TileRect {
        src_x: rect.src_x + display_x,
        src_y: rect.src_y + display_y,
        ..rect
    };
    let working = super::super::tile::tile_working_pixels(
        raw,
        &context.active_model,
        absolute,
        RenderQuality::Amaze,
    )?;
    if working > max_working_pixels {
        return Err(Error::Pipeline(
            "native-detail patch exceeds the memory budget".into(),
        ));
    }
    let (w, h, rgba) = super::super::tile::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
        raw, &context.active_model, absolute, RenderQuality::Amaze, None, context.ae_gain,
    )?;
    let rgb: Vec<f32> = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    // Run the display tail in sensor orientation, exactly as the base.
    // Grain and dither use the full DefaultCrop-relative source coordinates.
    let (sw, sh, rgb) = apply_orientation(&rgb, w, h, inverse);
    let mut scene = Image {
        width: sw,
        height: sh,
        pixels: rgb.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect(),
        space: ColorSpace::SceneLinearRec2020,
    };
    let (sx, sy, _, _) = raw.orientation.display_rect_to_sensor(
        absolute.src_x,
        absolute.src_y,
        absolute.src_w,
        absolute.src_h,
        raw.width,
        raw.height,
    );
    let origin = (sx - crop.0, sy - crop.1);
    display_prefix::apply(
        &mut scene,
        &context.model,
        film_lut,
        encode::TargetPrimaries::Srgb,
        (origin, (crop.2, crop.3)),
    );
    let pixels: &mut [f32] = bytemuck::cast_slice_mut(&mut scene.pixels);
    if let Some(curve) = &context.profile_curve {
        auto_profile::apply_curve(pixels, curve);
    }
    if let Some(lut) = &context.profile_lut {
        lut.apply_with_strength(pixels, auto_profile::lut::lut_strength_from_env());
    }
    if context.auto_guard {
        encode::gamut_guard_display_encoded_srgb(&mut scene);
    }
    let rgb = encode::dither_and_quantize_windowed(&mut scene, origin);
    Ok(apply_orientation(&rgb, sw, sh, raw.orientation))
}

fn inverse_orientation(orientation: ExifOrientation) -> ExifOrientation {
    match orientation {
        ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
        ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
        other => other,
    }
}

fn sensor_crop(raw: &RawImage) -> (u32, u32, u32, u32) {
    if let Some(crop) = raw.crop_rect {
        let w = crop.w.min(raw.width.saturating_sub(crop.x));
        let h = crop.h.min(raw.height.saturating_sub(crop.y));
        if w > 0 && h > 0 {
            return (crop.x, crop.y, w, h);
        }
    }
    (0, 0, raw.width, raw.height)
}

#[cfg(all(test, feature = "test-support"))]
#[path = "detail_tests.rs"]
mod tests;
