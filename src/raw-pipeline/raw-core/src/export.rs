//! Edited-image export (#943): render an edit to a deliverable file.
//!
//! One entry, [`export_from_raw`], that takes the RAW bytes plus the user's
//! adjustments and returns encoded file bytes ready to be written or handed to
//! a browser download. The render goes through
//! [`crate::pipeline::render_export_from_raw`], which shares its whole colour
//! chain with the on-screen display render, so what lands in the file is what
//! the user approved on the canvas.
//!
//! Every format is tagged with an ICC profile describing the primaries it
//! actually carries ([`crate::icc`]). Untagged files are read as sRGB, so a
//! Display P3 export without a profile would be silently re-stretched by the
//! viewer — the option would look like it worked while being wrong.

use crate::{
    error::{Error, Result},
    film, icc,
    image::RawImage,
    pipeline::{
        render_export_from_raw_with_film, ExportDepth, ExportPixels, RawInput, RenderQuality,
    },
    view::encode::TargetPrimaries,
    xmp::AdjustmentModel,
};
use image::codecs::{jpeg::JpegEncoder, png::PngEncoder, tiff::TiffEncoder};
use image::{ExtendedColorType, ImageEncoder};

/// Container the export is encoded into.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportFormat {
    /// 8-bit lossy — the everyday deliverable. Honours `quality`.
    Jpeg,
    /// 16-bit lossless — the archival/hand-off master.
    Tiff16,
    /// 8-bit lossless.
    Png,
    /// 8-bit AVIF.
    Avif,
    /// 8-bit WebP.
    Webp,
}

impl ExportFormat {
    /// Parse the wire spelling used by the web layer.
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Self::Jpeg),
            "tiff" => Some(Self::Tiff16),
            "png" => Some(Self::Png),
            "avif" => Some(Self::Avif),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    /// MIME type for the encoded bytes.
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Tiff16 => "image/tiff",
            Self::Png => "image/png",
            Self::Avif => "image/avif",
            Self::Webp => "image/webp",
        }
    }

    /// Filename extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Tiff16 => "tif",
            Self::Png => "png",
            Self::Avif => "avif",
            Self::Webp => "webp",
        }
    }

    /// The channel depth this container is written at.
    fn depth(self) -> ExportDepth {
        match self {
            Self::Tiff16 => ExportDepth::Sixteen,
            Self::Jpeg | Self::Png | Self::Avif | Self::Webp => ExportDepth::Eight,
        }
    }
}

/// Everything the caller gets to choose about an export.
pub struct ExportOptions {
    pub format: ExportFormat,
    /// JPEG quality in `[1, 100]`; ignored by the lossless formats.
    pub quality: u8,
    /// Output primaries — and the ICC profile the file is tagged with.
    pub target: TargetPrimaries,
    /// Long-edge cap in pixels; `None` renders native full resolution. Never
    /// upscales.
    pub max_long_edge: Option<u32>,
}

/// An encoded export, with the dimensions actually written.
pub struct ExportedImage {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

/// Render `raw` under `model` and encode it per `options`.
///
/// `raw_source` is the undecoded RAW, needed by Auto Profile's embedded-JPEG
/// fit — pass it, or `Profile::Auto` silently degrades to plain AgX and the
/// export stops matching the canvas.
///
/// Delegates to [`export_from_raw_with_film`] with `film_lut: None` —
/// byte-identical to the pre-#2683 behaviour regardless of `model.film_look` /
/// `model.film_strength`.
pub fn export_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    raw_source: Option<RawInput<'_>>,
    options: &ExportOptions,
) -> Result<ExportedImage> {
    export_from_raw_with_film(raw, model, raw_source, options, None)
}

/// Sibling of [`export_from_raw`] that also threads a baked film-look LUT
/// (Task 1 [`film::FilmLut`]) through to the export render (epic #2683, Task
/// 9) — so a deliverable file carries the SAME look the canvas showed rather
/// than silently dropping it. `film_lut: None` renders byte-identical to
/// [`export_from_raw`] regardless of `model.film_look` / `model.film_strength`
/// — a host that can't resolve the `.mlut` asset passes `None` here.
pub fn export_from_raw_with_film(
    raw: &RawImage,
    model: &AdjustmentModel,
    raw_source: Option<RawInput<'_>>,
    options: &ExportOptions,
    film_lut: Option<&film::FilmLut>,
) -> Result<ExportedImage> {
    let (width, height, pixels) = render_export_from_raw_with_film(
        raw,
        model,
        // Export always gets the best demosaic available for THIS frame
        // (#940, #3413) — nobody keeps a file rendered with the interactive
        // fast-phase kernel, and a noisy frame's "best" is not the same
        // kernel a clean one's is. `Auto` asks `demosaic::policy`; the
        // model's `demosaic` field overrides it.
        RenderQuality::Auto,
        raw_source,
        options.max_long_edge,
        options.target,
        options.format.depth(),
        film_lut,
    )?;

    let profile = icc::profile_for(options.target);
    let bytes = match (options.format, pixels) {
        (ExportFormat::Jpeg, ExportPixels::Eight(rgb)) => {
            encode_jpeg(width, height, &rgb, options.quality, profile)?
        }
        (ExportFormat::Png, ExportPixels::Eight(rgb)) => encode_png(width, height, &rgb, profile)?,
        (ExportFormat::Tiff16, ExportPixels::Sixteen(rgb)) => {
            encode_tiff16(width, height, &rgb, profile)?
        }
        (ExportFormat::Avif, ExportPixels::Eight(rgb)) => {
            encode_avif(width, height, &rgb, options.quality)?
        }
        (ExportFormat::Webp, ExportPixels::Eight(rgb)) => {
            encode_webp(width, height, &rgb, options.target)?
        }
        // `ExportFormat::depth` is what chose the buffer, so the pairings above
        // are exhaustive in practice; this keeps that invariant loud rather
        // than letting a future format land on a silently wrong encoder.
        (format, _) => {
            return Err(Error::Png(format!(
                "export: render produced the wrong sample depth for {format:?}"
            )))
        }
    };

    Ok(ExportedImage {
        width,
        height,
        bytes,
    })
}

/// Reject a buffer whose length disagrees with the dimensions before handing it
/// to an encoder, so the failure names the real problem.
fn check_len(width: u32, height: u32, actual: usize) -> Result<()> {
    let expected = (width as usize) * (height as usize) * 3;
    if actual != expected {
        return Err(Error::Png(format!(
            "export: expected {expected} samples for {width}x{height}, got {actual}"
        )));
    }
    Ok(())
}

fn encode_jpeg(
    width: u32,
    height: u32,
    rgb: &[u8],
    quality: u8,
    profile: Vec<u8>,
) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

fn encode_png(width: u32, height: u32, rgb: &[u8], profile: Vec<u8>) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = PngEncoder::new(&mut out);
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

fn encode_tiff16(width: u32, height: u32, rgb: &[u16], profile: Vec<u8>) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = TiffEncoder::new(std::io::Cursor::new(&mut out));
    encoder
        .set_icc_profile(profile)
        .map_err(|e| Error::Png(e.to_string()))?;
    encoder
        .write_image(
            bytemuck::cast_slice::<u16, u8>(rgb),
            width,
            height,
            ExtendedColorType::Rgb16,
        )
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(feature = "avif")]
pub fn encode_avif(width: u32, height: u32, rgb: &[u8], quality: u8) -> Result<Vec<u8>> {
    crate::avif::encode(width, height, rgb, quality)
}

#[cfg(not(feature = "avif"))]
pub fn encode_avif(_width: u32, _height: u32, _rgb: &[u8], _quality: u8) -> Result<Vec<u8>> {
    Err(Error::UnsupportedFormat(
        "AVIF export requires the 'avif' feature".into(),
    ))
}

#[cfg(feature = "avif")]
pub fn encode_avif_with_speed(
    width: u32,
    height: u32,
    rgb: &[u8],
    quality: u8,
    speed: u8,
) -> Result<Vec<u8>> {
    crate::avif::encode_with_speed(width, height, rgb, quality, speed)
}

#[cfg(not(feature = "avif"))]
pub fn encode_avif_with_speed(
    _width: u32,
    _height: u32,
    _rgb: &[u8],
    _quality: u8,
    _speed: u8,
) -> Result<Vec<u8>> {
    Err(Error::UnsupportedFormat(
        "AVIF export requires the 'avif' feature".into(),
    ))
}

/// Lossless WebP. `image`'s `WebPEncoder` only writes an `ICCP` chunk when
/// [`ImageEncoder::set_icc_profile`] is called before encoding, so a sRGB
/// request skips that call entirely and produces the exact bytes this crate
/// shipped before #3503 — sRGB WebP output stays untagged (every viewer
/// already assumes sRGB for an untagged file). A Display P3 request embeds
/// [`icc::profile_for`] so the file says what it actually carries, same as
/// the JPEG/PNG/TIFF paths.
pub fn encode_webp(
    width: u32,
    height: u32,
    rgb: &[u8],
    primaries: crate::view::encode::TargetPrimaries,
) -> Result<Vec<u8>> {
    check_len(width, height, rgb.len())?;
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
    if primaries == crate::view::encode::TargetPrimaries::P3 {
        encoder
            .set_icc_profile(icc::profile_for(primaries))
            .map_err(|e| Error::Png(e.to_string()))?;
    }
    encoder
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

/// Encode a non-RAW RasterImage into the requested container format, tagged
/// sRGB — the Tier 1 entry point, byte-identical to its pre-#3503 behaviour.
pub fn encode_raster(
    raster: &crate::raster::RasterImage,
    format: ExportFormat,
    quality: u8,
) -> Result<Vec<u8>> {
    encode_raster_rgb(
        raster,
        format,
        quality,
        6,
        crate::view::encode::TargetPrimaries::Srgb,
    )
}

/// AVIF's `colr` box (the ICC/CICP tag) is not written by this crate yet
/// (#3503 Tier 2 leaves it out of scope) — every AVIF this crate emits is
/// implicitly read back as sRGB by a colour-managed viewer. Encoding a
/// Display-P3-rotated raster into that untagged container would silently
/// reproduce the double-stretch defect `icc.rs` exists to prevent, so the
/// combination is rejected by name instead.
pub(crate) fn reject_untagged_avif_p3(
    format: ExportFormat,
    primaries: crate::view::encode::TargetPrimaries,
) -> Result<()> {
    if format == ExportFormat::Avif && primaries == crate::view::encode::TargetPrimaries::P3 {
        return Err(Error::UnsupportedFormat(
            "AVIF export cannot carry a Display P3 ICC profile yet (#3503) — export sRGB, \
             or choose JPEG/PNG/TIFF/WebP for a Display P3 deliverable"
                .into(),
        ));
    }
    Ok(())
}

/// RGB-only raster encode. Callers with a possibly-4-channel raster go through
/// [`crate::raster_encode::encode_raster_opts`], which decides per container
/// whether to keep the alpha channel or flatten first (#3505). `primaries`
/// says which space the SAMPLES are already in (set via
/// [`crate::raster::RasterImage::to_colourspace`]) — the ICC profile embedded
/// is [`icc::profile_for`] of that same value, so the tag always matches the
/// bytes.
pub fn encode_raster_rgb(
    raster: &crate::raster::RasterImage,
    format: ExportFormat,
    quality: u8,
    avif_speed: u8,
    primaries: crate::view::encode::TargetPrimaries,
) -> Result<Vec<u8>> {
    reject_untagged_avif_p3(format, primaries)?;
    let rgb = raster.to_rgb_bytes();
    let profile = icc::profile_for(primaries);
    match format {
        ExportFormat::Jpeg => encode_jpeg(raster.width, raster.height, &rgb, quality, profile),
        ExportFormat::Png => encode_png(raster.width, raster.height, &rgb, profile),
        ExportFormat::Tiff16 => {
            let rgb16: Vec<u16> = rgb.iter().map(|&v| (v as u16) * 257).collect();
            encode_tiff16(raster.width, raster.height, &rgb16, profile)
        }
        ExportFormat::Avif => {
            encode_avif_with_speed(raster.width, raster.height, &rgb, quality, avif_speed)
        }
        ExportFormat::Webp => encode_webp(raster.width, raster.height, &rgb, primaries),
    }
}

/// RGBA AVIF. `image`'s `AvifEncoder` accepts `ExtendedColorType::Rgba8` and
/// routes it to `ravif::Encoder::encode_rgba`, which writes a real alpha item.
#[cfg(feature = "avif")]
pub fn encode_avif_rgba_with_speed(
    width: u32,
    height: u32,
    rgba: &[u8],
    quality: u8,
    speed: u8,
) -> Result<Vec<u8>> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(Error::Png(format!(
            "expected {expected} bytes, got {}",
            rgba.len()
        )));
    }
    let mut out: Vec<u8> = Vec::new();
    image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, speed.clamp(1, 10), quality)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(not(feature = "avif"))]
pub fn encode_avif_rgba_with_speed(
    _width: u32,
    _height: u32,
    _rgba: &[u8],
    _quality: u8,
    _speed: u8,
) -> Result<Vec<u8>> {
    Err(Error::UnsupportedFormat(
        "AVIF export requires the 'avif' feature".into(),
    ))
}

// Tests live in the sibling `export_tests.rs` so this file stays under the
// 570-LOC file-size budget (#3503 Task D6 pushed it to 578). Same `#[path]`
// split pattern as `view/encode.rs` / `stages/blur.rs`.
#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
