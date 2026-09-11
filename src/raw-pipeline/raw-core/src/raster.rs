//! Non-RAW raster image decode, SIMD resampling, metadata probing, and ML tensor extraction.
//!
//! Provides the core bitmap processing engine in Maple, closing the functional gap
//! with Sharp (libvips) for non-RAW raster assets (JPEG, PNG, WebP, TIFF).

use std::io::Cursor;

use fast_image_resize as fr;
use image::{DynamicImage, GenericImageView, ImageReader};

use crate::error::{Error, Result};
use crate::image::ExifOrientation;

#[path = "raster_exif.rs"]
mod raster_exif;
use raster_exif::*;

#[path = "raster_jpeg.rs"]
mod raster_jpeg;

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

    /// Rotate / orient according to EXIF orientation tag, resetting orientation to Normal.
    pub fn auto_orient(&mut self) {
        if self.orientation == ExifOrientation::Normal {
            return;
        }
        let rgb = self.to_rgb_bytes();
        let (nw, nh, rotated) =
            crate::image::apply_orientation(&rgb, self.width, self.height, self.orientation);
        self.width = nw;
        self.height = nh;
        self.channels = 3;
        self.data = rotated;
        self.orientation = ExifOrientation::Normal;
    }

    /// Adopt caller-supplied interleaved 8-bit pixels. Greyscale (1 channel)
    /// is expanded to RGB so every downstream op sees 3 or 4 channels.
    pub fn from_raw(width: u32, height: u32, channels: u8, data: Vec<u8>) -> Result<Self> {
        let invalid = |reason: String| Error::Decode {
            path: "<memory>".into(),
            reason,
        };
        if width == 0 || height == 0 {
            return Err(invalid("raw input dimensions must be non-zero".into()));
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(channels as usize))
            .ok_or_else(|| {
                invalid(format!(
                    "raw input dimensions {width}x{height}x{channels} overflow"
                ))
            })?;
        if data.len() != expected {
            return Err(invalid(format!(
                "raw input has {} bytes, expected {expected} for {width}x{height}x{channels}",
                data.len()
            )));
        }
        match channels {
            3 => Ok(Self::new_rgb(width, height, data)),
            4 => Ok(Self::new_rgba(width, height, data)),
            1 => Ok(Self::new_rgb(
                width,
                height,
                data.iter().flat_map(|&g| [g, g, g]).collect(),
            )),
            other => Err(invalid(format!(
                "unsupported raw channel count {other} (1, 3 or 4)"
            ))),
        }
    }

    /// Strip alpha (if any) and return a 3-channel image.
    pub fn into_rgb8(self) -> Self {
        if self.channels == 3 {
            return self;
        }
        let data = self.to_rgb_bytes();
        Self {
            width: self.width,
            height: self.height,
            channels: 3,
            data,
            orientation: self.orientation,
        }
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
            orientation: 1,
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

    Ok(RasterMetadata {
        width,
        height,
        format: final_format.into(),
        channels: 3, // Default assumed sRGB channels
        orientation,
    })
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

/// Sizing and framing strategy for resizing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ResizeFit {
    /// Scale image to fit inside target bounding box, preserving aspect ratio.
    #[default]
    Inside,
    /// Scale image to exactly target width and height, distorting aspect ratio if needed.
    Fill,
}

/// Filter kernel for resampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FilterAlg {
    #[default]
    Lanczos3,
    Bilinear,
    Nearest,
}

/// Options controlling image resizing.
#[derive(Clone, Debug)]
pub struct ResizeOptions {
    pub width: u32,
    pub height: u32,
    pub fit: ResizeFit,
    pub filter: FilterAlg,
    pub without_enlargement: bool,
}

impl Default for ResizeOptions {
    fn default() -> Self {
        Self {
            width: 512,
            height: 512,
            fit: ResizeFit::Inside,
            filter: FilterAlg::Lanczos3,
            without_enlargement: true,
        }
    }
}

/// High-performance SIMD resizing of a RasterImage using `fast_image_resize`.
pub fn resize_raster(src: &RasterImage, options: &ResizeOptions) -> Result<RasterImage> {
    if src.width == 0 || src.height == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "cannot resize zero-dimension image".into(),
        });
    }

    let (dst_w_calc, dst_h_calc) = match options.fit {
        ResizeFit::Fill => {
            let w = if options.width == 0 {
                src.width
            } else {
                options.width
            };
            let h = if options.height == 0 {
                src.height
            } else {
                options.height
            };
            (w, h)
        }
        ResizeFit::Inside => {
            let scale = match (options.width, options.height) {
                (0, 0) => 1.0,
                (w, 0) => w as f64 / src.width as f64,
                (0, h) => h as f64 / src.height as f64,
                (w, h) => {
                    let sx = w as f64 / src.width as f64;
                    let sy = h as f64 / src.height as f64;
                    sx.min(sy)
                }
            };
            let mut final_scale = scale;
            if options.without_enlargement && final_scale >= 1.0 {
                final_scale = 1.0;
            }
            let w = (src.width as f64 * final_scale).round().max(1.0) as u32;
            let h = (src.height as f64 * final_scale).round().max(1.0) as u32;
            (w, h)
        }
    };

    if dst_w_calc == src.width && dst_h_calc == src.height {
        return Ok(src.clone());
    }

    if dst_w_calc == 0 || dst_h_calc == 0 {
        return Err(Error::Decode {
            path: "<memory>".into(),
            reason: "target dimensions must be non-zero".into(),
        });
    }

    let pixel_type = match src.channels {
        3 => fr::PixelType::U8x3,
        4 => fr::PixelType::U8x4,
        other => {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("unsupported channel count: {other}"),
            })
        }
    };

    let src_image =
        fr::images::Image::from_vec_u8(src.width, src.height, src.data.clone(), pixel_type)
            .map_err(|e| Error::Decode {
                path: "<memory>".into(),
                reason: format!("fast_image_resize source creation error: {e}"),
            })?;

    let mut dst_image = fr::images::Image::new(dst_w_calc, dst_h_calc, pixel_type);

    let alg = match options.filter {
        FilterAlg::Lanczos3 => fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3),
        FilterAlg::Bilinear => fr::ResizeAlg::Convolution(fr::FilterType::Bilinear),
        FilterAlg::Nearest => fr::ResizeAlg::Nearest,
    };

    let fr_opts = fr::ResizeOptions {
        algorithm: alg,
        ..Default::default()
    };

    let mut resizer = fr::Resizer::new();
    resizer
        .resize(&src_image, &mut dst_image, &fr_opts)
        .map_err(|e| Error::Decode {
            path: "<memory>".into(),
            reason: format!("resizing execution failed: {e}"),
        })?;

    Ok(RasterImage {
        width: dst_w_calc,
        height: dst_h_calc,
        channels: src.channels,
        data: dst_image.into_vec(),
        orientation: src.orientation,
    })
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

/// ISO-BMFF `ftyp` box carrying an AVIF-family brand (`avif`, `avis` for
/// image sequences, or `mif1` for a MIAF-conformant still) among the first
/// 32 bytes. Single-sourced here — compiled unconditionally, regardless of
/// the `avif` feature — so a feature-off build applies the same brand check
/// as the real decoder instead of a looser "any ftyp box" heuristic that
/// would misreport other ISO-BMFF containers (HEIC, MP4, MOV) as AVIF.
/// `avif_decode::is_avif` (kept `pub` for Task 1's own tests) delegates here.
pub(crate) fn is_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..bytes.len().min(32)]
            .windows(4)
            .any(|w| w == b"avif" || w == b"avis" || w == b"mif1")
}

/// Feature gate so the AVIF branch compiles to a clean error when raw-core is
/// built without `avif` (raw-wasm), and to the real decoder otherwise.
mod avif_decode_gate {
    use super::*;

    /// Container-level facts needed by `probe_raster_metadata`, mirrored from
    /// `avif_decode::AvifProbe` so this module has a concrete return type
    /// whether or not the `avif_decode` module exists in this build.
    pub(crate) struct AvifProbeLite {
        pub width: u32,
        pub height: u32,
        pub has_alpha: bool,
    }

    #[cfg(feature = "avif")]
    pub(crate) fn decode(bytes: &[u8]) -> Result<RasterImage> {
        crate::avif_decode::decode_avif(bytes)
    }
    #[cfg(not(feature = "avif"))]
    pub(crate) fn decode(_bytes: &[u8]) -> Result<RasterImage> {
        Err(Error::Decode {
            path: "<memory>".into(),
            reason: "AVIF decoding requires the `avif` feature".into(),
        })
    }

    #[cfg(feature = "avif")]
    pub(crate) fn probe(bytes: &[u8]) -> Result<AvifProbeLite> {
        let probe = crate::avif_decode::probe_avif(bytes)?;
        Ok(AvifProbeLite {
            width: probe.width,
            height: probe.height,
            has_alpha: probe.has_alpha,
        })
    }
    #[cfg(not(feature = "avif"))]
    pub(crate) fn probe(_bytes: &[u8]) -> Result<AvifProbeLite> {
        Err(Error::Decode {
            path: "<memory>".into(),
            reason: "AVIF probing requires the `avif` feature".into(),
        })
    }
}

#[cfg(test)]
#[path = "raster_tests.rs"]
mod tests;
