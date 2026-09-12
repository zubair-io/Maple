//! Float32 tensor extraction from a decoded bitmap, for the ONNX/ML
//! inference pipelines (face detection, embeddings).
//!
//! A pure move out of `raster.rs` (#3507 final fix wave, item 0): that file
//! sat at 569 lines against the 570-line headroom ceiling, so the next
//! sibling PR to touch it would have turned `main` red on merge. Tensor
//! extraction is the one piece of `raster.rs` with no dependency on the
//! decode/probe/resize machinery around it — it reads a `RasterImage` and
//! produces floats — so it is the cohesive piece to lift out. Declared as
//! a `#[path]` submodule of `raster` and re-exported, so every existing
//! `raster::extract_tensor` / `raster::TensorLayout` path still resolves.

use super::{RasterImage, Result};

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
