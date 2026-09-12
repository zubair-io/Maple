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
/// Float32 tensor extraction — split out to keep this file inside the
/// file-size budget (#3507 final fix wave, item 0); see its own module doc.
#[path = "raster_tensor.rs"]
mod raster_tensor;
pub use raster_tensor::{extract_tensor, TensorData, TensorLayout, TensorNormalize};

/// Header-only container probing (dimensions, format, channels, alpha,
/// orientation) — see its own module doc.
#[path = "raster_probe.rs"]
mod raster_probe;
use raster_probe::container_orientation;
pub use raster_probe::{probe_raster_metadata, RasterMetadata};

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

/// Decode a non-RAW bitmap (JPEG, PNG, WebP, TIFF) from in-memory bytes into a RasterImage.
pub fn decode_raster(bytes: &[u8], ext_hint: Option<&str>) -> Result<RasterImage> {
    let hinted_avif = matches!(
        ext_hint.map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("avif")
    );
    if hinted_avif || is_avif(bytes) {
        // The AVIF decoder itself never looks at `irot`/`imir`, so the
        // container's own transform has to be attached here for
        // `auto_orient` to have anything to apply (#3507 final fix wave,
        // item 4).
        return avif_decode_gate::decode(bytes).map(|image| RasterImage {
            orientation: ExifOrientation::from_u16(container_orientation(bytes)),
            ..image
        });
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

    let orientation = ExifOrientation::from_u16(container_orientation(bytes));

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
