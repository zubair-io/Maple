//! Edited JPEG/TIFF/PNG/WebP export (#3891), using the existing non-RAW live chain.
//! No AgX or camera Auto Profile is applied to already tone-mapped pixels.
use super::{finish_eight, finish_sixteen, ExportDepth, ExportPixels};
use crate::{
    color::matrices::M_SRGB_TO_REC2020,
    error::{Error, Result},
    film::FilmLut,
    image::{ColorSpace, ExifOrientation, Image},
    pipeline::{
        apply_scene_linear_chain_f32_with_film_cancellable, downsample_image_area, ChainOptions,
    },
    view::encode::{self, TargetPrimaries},
    AdjustmentModel,
};
use image::{DynamicImage, ImageDecoder, ImageReader};
use std::io::Cursor;

fn unsupported(message: &str) -> Error {
    Error::Pipeline(format!("raster image: {message}"))
}

/// RAW-only authored stages must never disappear silently on a raster source.
pub fn validate_raster_adjustments(model: &AdjustmentModel) -> Result<()> {
    let defaults = AdjustmentModel::default();
    let checks = [
        // These controls belong to AgX, which cannot be run a second time
        // on a baked raster. Do not claim success while dropping them.
        (model.contrast != 0.0, "AgX contrast"),
        (model.whites != 0.0, "AgX whites"),
        (model.capture_sharpening_amount != 0.0, "capture sharpening"),
        (model.deep_denoise != 0.0, "deep denoise"),
        (model.chroma_prefilter != 0.0, "sensor chroma prefilter"),
        (
            model.hot_pixel_suppression != defaults.hot_pixel_suppression,
            "hot pixel suppression",
        ),
        (
            model.auto_lateral_ca != defaults.auto_lateral_ca,
            "sensor lateral CA",
        ),
        (model.demosaic != defaults.demosaic, "demosaic selection"),
        (!model.lens_profile.is_empty(), "imported lens profile"),
        (!model.inpaint_removals.is_empty(), "inpaint removal"),
        (!model.retouch_spots.is_empty(), "repair spots"),
        (
            model.lens_correction_distortion != defaults.lens_correction_distortion
                || model.lens_correction_ca != defaults.lens_correction_ca
                || model.lens_correction_vignetting != defaults.lens_correction_vignetting,
            "embedded lens correction strengths",
        ),
    ];
    for (active, name) in checks {
        if active {
            return Err(unsupported(&format!("{name} requires a RAW source")));
        }
    }
    Ok(())
}

/// Decode to linear Rec.2020 without the 8-bit intermediate of thumbnail APIs.
/// Untagged inputs use sRGB. Tagged RGB inputs transform directly to linear
/// Rec.2020 in f32, preserving wide gamut without an sRGB/8-bit intermediate.
fn decode(bytes: &[u8]) -> Result<(Image, ExifOrientation)> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| unsupported(&e.to_string()))?;
    // image identifies Classic TIFF only; the shared TIFF decoder also reads BigTIFF.
    if reader.format().is_none()
        && (bytes.starts_with(b"II\x2b\0") || bytes.starts_with(b"MM\0\x2b"))
    {
        reader.set_format(image::ImageFormat::Tiff);
    }
    if !matches!(
        reader.format(),
        Some(
            image::ImageFormat::Jpeg
                | image::ImageFormat::Tiff
                | image::ImageFormat::Png
                | image::ImageFormat::WebP
        )
    ) {
        return Err(unsupported(
            "only JPEG, TIFF, PNG and WebP inputs are supported",
        ));
    }
    if reader.format() == Some(image::ImageFormat::Tiff) {
        if let Some(decoded) = crate::raster::decode_jpeg_tiff(bytes)? {
            let rgb = image::RgbImage::from_raw(decoded.width, decoded.height, decoded.data)
                .ok_or_else(|| unsupported("invalid JPEG-compressed TIFF pixel buffer"))?;
            return to_scene(
                DynamicImage::ImageRgb8(rgb).to_rgba32f(),
                crate::raster_meta::read_sidecars(bytes).icc,
                decoded.orientation,
            );
        }
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(crate::raster::MAX_BITMAP_DECODE_BYTES);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| unsupported(&e.to_string()))?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > u64::from(crate::raster::MAX_RASTER_PIXELS) {
        return Err(unsupported("dimensions exceed the 268000000 pixel limit"));
    }
    limits
        .reserve(decoder.total_bytes())
        .map_err(|e| unsupported(&e.to_string()))?;
    decoder
        .set_limits(limits)
        .map_err(|e| unsupported(&e.to_string()))?;
    // The image TIFF decoder omits BYTE-typed ICC tags; Maple's bounded
    // container reader also handles that legal representation.
    if matches!(
        decoder.original_color_type(),
        image::ExtendedColorType::Cmyk8 | image::ExtendedColorType::Cmyk16
    ) {
        return Err(unsupported("CMYK input is not supported"));
    }
    let profile = decoder
        .icc_profile()
        .map_err(|e| unsupported(&e.to_string()))?
        .or_else(|| crate::raster_meta::read_sidecars(bytes).icc);
    let raster = DynamicImage::from_decoder(decoder)
        .map_err(|e| unsupported(&e.to_string()))?
        .to_rgba32f();
    let orientation =
        ExifOrientation::from_u16(crate::raster::container_orientation(bytes).unwrap_or(1));
    to_scene(raster, profile, orientation)
}

fn to_scene(
    raster: image::Rgba32FImage,
    profile: Option<Vec<u8>>,
    orientation: ExifOrientation,
) -> Result<(Image, ExifOrientation)> {
    let mut scene = Image::new(
        raster.width(),
        raster.height(),
        ColorSpace::SceneLinearRec2020,
    );
    let transform = profile.as_deref().map(input_transform).transpose()?;
    let mut row = vec![0.0f32; raster.width() as usize * 4];
    if let Some(transform) = transform {
        for (pixels, output) in raster
            .as_raw()
            .chunks_exact(row.len())
            .zip(scene.pixels.chunks_exact_mut(raster.width() as usize))
        {
            if pixels
                .chunks_exact(4)
                .any(|p| p.iter().any(|v| !v.is_finite()) || p[3] != 1.0)
            {
                return Err(unsupported(
                    "non-finite pixels or transparency are not supported",
                ));
            }
            transform
                .transform(pixels, &mut row)
                .map_err(|e| unsupported(&format!("input ICC transform: {e}")))?;
            for (out, pixel) in output.iter_mut().zip(row.chunks_exact(4)) {
                *out = [pixel[0], pixel[1], pixel[2]];
            }
        }
    } else {
        for (out, pixel) in scene.pixels.iter_mut().zip(raster.pixels()) {
            if pixel.0.iter().any(|v| !v.is_finite()) || pixel[3] != 1.0 {
                return Err(unsupported(
                    "non-finite pixels or transparency are not supported",
                ));
            }
            *out = M_SRGB_TO_REC2020.mul_vec([
                encode::srgb_degamma(pixel[0]),
                encode::srgb_degamma(pixel[1]),
                encode::srgb_degamma(pixel[2]),
            ]);
        }
    }
    Ok((scene, orientation))
}

fn input_transform(profile: &[u8]) -> Result<std::sync::Arc<moxcms::TransformF32Executor>> {
    use moxcms::{ColorProfile, DataColorSpace, Layout, ToneReprCurve, TransformOptions};
    let source = ColorProfile::new_from_slice(profile)
        .map_err(|e| unsupported(&format!("input ICC profile: {e}")))?;
    if source.color_space != DataColorSpace::Rgb {
        return Err(unsupported("input ICC profile must describe RGB pixels"));
    }
    let mut destination = ColorProfile::new_bt2020();
    let linear = Some(ToneReprCurve::Parametric(vec![1.0]));
    destination.red_trc = linear.clone();
    destination.green_trc = linear.clone();
    destination.blue_trc = linear;
    source
        .create_transform_f32(
            Layout::Rgba,
            &destination,
            Layout::Rgba,
            TransformOptions {
                prefer_fixed_point: false,
                ..Default::default()
            },
        )
        .map_err(|e| unsupported(&format!("input ICC transform: {e}")))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod bounds_tests;

pub fn render_export_raster(
    bytes: &[u8],
    model: &AdjustmentModel,
    max_long_edge: Option<u32>,
    target: TargetPrimaries,
    depth: ExportDepth,
    film: Option<&FilmLut>,
) -> Result<(u32, u32, ExportPixels)> {
    render_export_raster_cancellable(
        bytes,
        model,
        max_long_edge,
        target,
        depth,
        film,
        crate::CancelToken::never(),
    )
}

/// Cancel between stages and within supported sharpening/noise-reduction kernels.
/// Container decode and remaining display/geometry kernels stop at boundaries.
pub fn render_export_raster_cancellable(
    bytes: &[u8],
    model: &AdjustmentModel,
    max_long_edge: Option<u32>,
    target: TargetPrimaries,
    depth: ExportDepth,
    film: Option<&FilmLut>,
    cancel: crate::CancelToken<'_>,
) -> Result<(u32, u32, ExportPixels)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    validate_raster_adjustments(model)?;
    if !model.film_look.is_empty() && film.is_none() {
        return Err(unsupported("selected film LUT is unavailable"));
    }
    // Masks, grain and geometry are authored against the oriented canvas.
    // Share the editor base so asymmetric edits cannot rotate relative to it.
    let (width, height, rgba) =
        decode_raster_base(bytes, max_long_edge.unwrap_or(u32::MAX), cancel)?;
    let mut scene = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    let chained = apply_scene_linear_chain_f32_with_film_cancellable(
        &rgba,
        scene.width,
        scene.height,
        model,
        &ChainOptions {
            skip_agx: true,
            ..Default::default()
        },
        film,
        cancel,
    )?;
    for (pixel, rgba) in scene.pixels.iter_mut().zip(chained.chunks_exact(4)) {
        *pixel = [rgba[0], rgba[1], rgba[2]];
    }
    scene.space = ColorSpace::DisplayLinearRec2020;
    encode::rec2020_to_display(&mut scene, target);
    encode::srgb_gamma_encode(&mut scene);
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let output = match depth {
        ExportDepth::Eight => finish_eight(&mut scene, ExifOrientation::Normal, model),
        ExportDepth::Sixteen => finish_sixteen(&mut scene, ExifOrientation::Normal, model),
    };
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(output)
}

/// Color-managed editor base, with EXIF orientation applied once and no user
/// edits baked in. CPU/GPU hosts must use their non-RAW chain on this buffer.
pub fn decode_raster_base(
    bytes: &[u8],
    max_long_edge: u32,
    cancel: crate::CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>)> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if max_long_edge == 0 {
        return Err(unsupported("maxLongEdge must be positive"));
    }
    let (mut scene, orientation) = decode(bytes)?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    downsample_image_area(&mut scene, max_long_edge);
    let rgba: Vec<f32> = scene
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let result = crate::pipeline::orient::apply_orientation_f32_rgba(
        &rgba,
        scene.width,
        scene.height,
        orientation,
    );
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "raster/formats_tests.rs"]
mod formats_tests;

mod detail;
pub use detail::RasterDetailImage;
