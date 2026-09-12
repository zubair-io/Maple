//! Non-RAW raster image decode, SIMD resampling, metadata probing, and ML tensor extraction.
//!
//! Provides the core bitmap processing engine in Maple, closing the functional gap
//! with Sharp (libvips) for non-RAW raster assets (JPEG, PNG, WebP, TIFF).

use std::io::Cursor;

use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader};

use crate::error::{Error, Result};
use crate::image::ExifOrientation;

#[path = "raster_exif.rs"]
mod raster_exif;
use raster_exif::*;

#[path = "raster_jpeg.rs"]
mod raster_jpeg;

#[path = "raster_ops.rs"]
mod raster_ops;

#[path = "raster_resize.rs"]
mod raster_resize;
pub use raster_resize::{resize_raster, FilterAlg, ResizeFit, ResizeOptions};

/// Representation of a decoded non-RAW raster image in memory.
#[derive(Clone, Debug)]
pub struct RasterImage {
    pub width: u32,
    pub height: u32,
    /// 3 for RGB8, 4 for RGBA8
    pub channels: u8,
    /// Interleaved pixel bytes ([R, G, B, R, G, B, ...])
    pub data: Vec<u8>,
    /// EXIF orientation tag, if preserved from source metadata
    pub orientation: ExifOrientation,
}

impl RasterImage {
    pub fn new_rgb(width: u32, height: u32, data: Vec<u8>) -> Self {
        Self {
            width,
            height,
            channels: 3,
            data,
            orientation: ExifOrientation::Normal,
        }
    }

    pub fn new_rgba(width: u32, height: u32, data: Vec<u8>) -> Self {
        Self {
            width,
            height,
            channels: 4,
            data,
            orientation: ExifOrientation::Normal,
        }
    }

    /// Return raw bytes as an RGB buffer, stripping alpha if present.
    pub fn to_rgb_bytes(&self) -> Vec<u8> {
        if self.channels == 3 {
            return self.data.clone();
        }
        if self.channels == 4 {
            let pixel_count = (self.width as usize) * (self.height as usize);
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            for chunk in self.data.chunks_exact(4) {
                rgb.push(chunk[0]);
                rgb.push(chunk[1]);
                rgb.push(chunk[2]);
            }
            return rgb;
        }
        self.data.clone()
    }

    /// Rotate / orient per the EXIF tag, resetting orientation to Normal.
    /// See `raster_orient::auto_orient` — split out to keep this file under
    /// budget (#3505).
    pub fn auto_orient(&mut self) {
        crate::raster_orient::auto_orient(self);
    }
}

/// Metadata probed from a raster image container without decoding full pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RasterMetadata {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub channels: u8,
    pub orientation: u16,
    /// Whether the container's own colour type carries an alpha channel
    /// (#3507 controller ruling). Derived from the real container header for
    /// every non-AVIF format (see [`channels_and_alpha_from_header`]); AVIF
    /// keeps its box-derived value (Task G2's `ispe`/alpha-item read).
    pub has_alpha: bool,
}

/// Quick probing of raster image dimensions and format from raw bytes.
pub fn probe_raster_metadata(bytes: &[u8]) -> Result<RasterMetadata> {
    if is_avif(bytes) {
        let probe = avif_decode_gate::probe(bytes)?;
        return Ok(RasterMetadata {
            width: probe.width,
            height: probe.height,
            format: "avif".to_string(),
            channels: if probe.has_alpha { 4 } else { 3 },
            // Real orientation from the container's irot/imir transform
            // properties (#3507). Before this, `.rotate()` on an AVIF source
            // was a silent no-op.
            orientation: crate::avif_boxes::read_avif_boxes(bytes).orientation,
            has_alpha: probe.has_alpha,
        });
    }

    let cursor = Cursor::new(bytes);
    let reader = ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("failed to probe image format: {e}"),
        })?;

    let format_str = match reader.format() {
        Some(image::ImageFormat::Jpeg) => "jpeg",
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Tiff) => "tiff",
        Some(image::ImageFormat::Avif) => "avif",
        Some(other) => return Err(Error::UnsupportedFormat(format!("{other:?}"))),
        None => return Err(Error::UnsupportedFormat("unknown image format".into())),
    };

    let (width, height, final_format) = match reader.into_dimensions() {
        Ok((w, h)) => {
            let fmt = if format_str == "tiff" {
                if let Some((_, _, is_dng)) = parse_tiff_dimensions(bytes) {
                    if is_dng {
                        "dng"
                    } else {
                        "tiff"
                    }
                } else {
                    "tiff"
                }
            } else {
                format_str
            };
            (w, h, fmt)
        }
        Err(_) => {
            if let Some((w, h, is_dng)) = parse_tiff_dimensions(bytes) {
                (w, h, if is_dng { "dng" } else { "tiff" })
            } else {
                return Err(Error::Decode {
                    path: "<memory>".into(),
                    reason: "failed to read image dimensions".into(),
                });
            }
        }
    };

    // Try to extract EXIF orientation if available in the first 64KB
    let orientation = extract_exif_orientation(bytes).unwrap_or(1);
    let (channels, has_alpha) = channels_and_alpha_from_header(bytes);

    Ok(RasterMetadata {
        width,
        height,
        format: final_format.into(),
        channels,
        orientation,
        has_alpha,
    })
}

/// Real channel count and alpha presence for a non-AVIF container, read
/// straight from its header (`image::ImageDecoder::color_type()`) rather
/// than assumed. #3507 controller ruling: this replaces a hard-coded
/// `channels: 3` that made `RasterMetadata` unable to ever report a real
/// alpha channel for a JPEG/PNG/TIFF/WebP source, which is a real
/// `metadata()` parity bug against sharp — measured against sharp 0.34.5,
/// see `raster_tests.rs`'s `probe_channels_and_has_alpha_match_sharp_*`
/// cases. Mirrors the header-level probe Task G4's `raster_analyze` used to
/// carry locally (now collapsed onto this field — see that module's doc).
///
/// A decoder-construction failure here — after `probe_raster_metadata`
/// already succeeded at reading dimensions above — shouldn't happen in
/// practice; falls back to `(3, false)` rather than turning an advisory
/// field probe into a hard error.
fn channels_and_alpha_from_header(bytes: &[u8]) -> (u8, bool) {
    match ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_decoder().ok())
    {
        Some(decoder) => {
            let color = decoder.color_type();
            (color.channel_count(), color.has_alpha())
        }
        None => (3, false),
    }
}

/// Decode a non-RAW bitmap (JPEG, PNG, WebP, TIFF) from in-memory bytes into a RasterImage.
pub fn decode_raster(bytes: &[u8], ext_hint: Option<&str>) -> Result<RasterImage> {
    let hinted_avif = matches!(
        ext_hint.map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("avif")
    );
    if hinted_avif || is_avif(bytes) {
        return avif_decode_gate::decode(bytes);
    }

    let hinted_jpeg = matches!(
        ext_hint.map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("jpg" | "jpeg")
    );
    if hinted_jpeg || bytes.starts_with(&[0xFF, 0xD8]) {
        return raster_jpeg::decode_jpeg_lenient(bytes);
    }

    let mut reader = ImageReader::new(Cursor::new(bytes));
    if let Some(ext) = ext_hint {
        let fmt = match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => Some(image::ImageFormat::Jpeg),
            "png" => Some(image::ImageFormat::Png),
            "webp" => Some(image::ImageFormat::WebP),
            "tif" | "tiff" => Some(image::ImageFormat::Tiff),
            "avif" => Some(image::ImageFormat::Avif),
            _ => None,
        };
        if let Some(f) = fmt {
            reader.set_format(f);
        }
    }

    if reader.format().is_none() {
        reader = reader.with_guessed_format().map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("cannot identify raster image format: {e}"),
        })?;
    }

    let dyn_img = reader.decode().map_err(|e| Error::Decode {
        path: "<memory>".into(),
        reason: format!("failed to decode raster pixels: {e}"),
    })?;

    let orientation_val = extract_exif_orientation(bytes).unwrap_or(1);
    let orientation = ExifOrientation::from_u16(orientation_val);

    let (width, height) = dyn_img.dimensions();

    match dyn_img {
        DynamicImage::ImageRgb8(rgb) => Ok(RasterImage {
            width,
            height,
            channels: 3,
            data: rgb.into_raw(),
            orientation,
        }),
        DynamicImage::ImageRgba8(rgba) => Ok(RasterImage {
            width,
            height,
            channels: 4,
            data: rgba.into_raw(),
            orientation,
        }),
        other => {
            // Normalize any grayscale (L8, La8) or 16-bit to standard 8-bit sRGB
            let rgb = other.to_rgb8();
            Ok(RasterImage {
                width,
                height,
                channels: 3,
                data: rgb.into_raw(),
                orientation,
            })
        }
    }
}

/// Tensor memory layout for AI/ML inference pipelines.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TensorLayout {
    /// Planar layout: [Channels, Height, Width]
    #[default]
    Nchw,
    /// Interleaved layout: [Height, Width, Channels]
    Hwc,
}

/// Normalization scheme applied to raw pixel values during tensor extraction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TensorNormalize {
    /// No scaling: raw pixel values [0.0, 255.0]
    #[default]
    None,
    /// InsightFace standard for SCRFD and ArcFace: `(pixel - 127.5) / 128.0` in [-1.0, 1.0]
    InsightFace,
    /// Normalized to [0.0, 1.0]: `pixel / 255.0`
    ZeroToOne,
}

/// Resulting Float32 tensor for ONNX / ML model execution.
#[derive(Clone, Debug)]
pub struct TensorData {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub data: Vec<f32>,
}

/// Extract planar NCHW or interleaved HWC Float32 tensors from a RasterImage.
pub fn extract_tensor(
    src: &RasterImage,
    layout: TensorLayout,
    normalize: TensorNormalize,
) -> Result<TensorData> {
    let rgb = src.to_rgb_bytes();
    let num_pixels = (src.width as usize) * (src.height as usize);
    let mut out = vec![0.0f32; num_pixels * 3];

    let norm_fn: fn(u8) -> f32 = match normalize {
        TensorNormalize::None => |px| px as f32,
        TensorNormalize::InsightFace => |px| (px as f32 - 127.5) / 128.0,
        TensorNormalize::ZeroToOne => |px| px as f32 / 255.0,
    };

    match layout {
        TensorLayout::Hwc => {
            for (i, &px) in rgb.iter().enumerate() {
                out[i] = norm_fn(px);
            }
        }
        TensorLayout::Nchw => {
            let plane = num_pixels;
            for i in 0..num_pixels {
                let r = rgb[i * 3];
                let g = rgb[i * 3 + 1];
                let b = rgb[i * 3 + 2];
                out[i] = norm_fn(r);
                out[plane + i] = norm_fn(g);
                out[2 * plane + i] = norm_fn(b);
            }
        }
    }

    Ok(TensorData {
        width: src.width,
        height: src.height,
        channels: 3,
        data: out,
    })
}

/// Read the EXIF Orientation tag out of a bare TIFF block (the form an AVIF
/// `Exif` item and a JPEG APP1 payload both carry) — #3507, so
/// `raster_meta::read_sidecars`'s AVIF `exif` field can be checked against a
/// real Orientation tag, not just proven non-empty.
pub fn exif_orientation_from_block(block: &[u8]) -> Option<u16> {
    raster_exif::parse_tiff_exif_orientation(block)
}

/// ISO-BMFF `ftyp` box carrying an AVIF-family brand (`avif`, `avis` for
/// image sequences, or `mif1` for a MIAF-conformant still) among the first
/// 32 bytes. Single-sourced here — compiled unconditionally, regardless of
/// the `avif` feature — so a feature-off build applies the same brand check
/// as the real decoder instead of a looser "any ftyp box" heuristic that
/// would misreport other ISO-BMFF containers (HEIC, MP4, MOV) as AVIF.
/// `avif_decode::is_avif` (kept `pub` for Task 1's own tests) delegates here.
/// `pub` (not `pub(crate)`) since `crate::raster_meta::read_sidecars`
/// (#3507, Task G2) also dispatches on it.
pub fn is_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..bytes.len().min(32)]
            .windows(4)
            .any(|w| w == b"avif" || w == b"avis" || w == b"mif1")
}

#[path = "raster_avif_gate.rs"]
mod avif_decode_gate;

#[cfg(test)]
#[path = "raster_tests.rs"]
mod tests;
