//! The canvas placeholder (#5758): the still the shared canvas draws while the
//! photo's own render is not ready — the grid thumbnail, then a server or
//! cached preview. It is drawn on the canvas's own surface, through the same
//! present pass as the render, so a source swap changes only the pixels.
//!
//! The present pass reads display-encoded RGBA in the canvas's target
//! primaries (the live chain's output encoding) and bilinearly resamples it
//! to the surface. This module turns a host's decoded 8-bit still into that
//! encoding, picks the surface size by the same fit rule as the render's
//! fast pass, and holds the CPU reference of the present for the GPU parity
//! gate.

use crate::canvas::{Size, MAX_TEXTURE_EDGE};
use crate::color::matrices::M_SRGB_TO_P3;
use crate::math::Matrix3;
use crate::view::encode::TargetPrimaries;
use crate::view::gamma::{srgb_degamma, srgb_gamma};

/// The colour encoding of a host's decoded 8-bit still. Both use the sRGB
/// transfer curve; they differ only in primaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaceholderColorSpace {
    Srgb,
    DisplayP3,
}

impl PlaceholderColorSpace {
    /// `1` is Display P3; every other value is sRGB, the encoding of a
    /// thumbnail with no profile.
    #[must_use]
    pub fn from_u32(value: u32) -> Self {
        match value {
            1 => Self::DisplayP3,
            _ => Self::Srgb,
        }
    }

    fn primaries(self) -> TargetPrimaries {
        match self {
            Self::Srgb => TargetPrimaries::Srgb,
            Self::DisplayP3 => TargetPrimaries::P3,
        }
    }
}

/// The longest edge a placeholder still may have. Seeds are 512 px grid
/// thumbnails and 1280 px display previews; the surface is the viewport's
/// size, so a larger still only costs memory and aliases in the present
/// pass's bilinear downscale.
pub const PLACEHOLDER_MAX_EDGE: u32 = 4096;

/// Why a still cannot become a placeholder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaceholderError {
    /// A zero width or height.
    Empty,
    /// Wider or taller than [`PLACEHOLDER_MAX_EDGE`].
    TooLarge,
    /// A row stride shorter than `width × 4` bytes.
    RowBytes,
    /// The pixel slice ends before the last row.
    Truncated,
    /// The output slice is not exactly `width × height` texels.
    OutputLength,
}

/// The surface size for a placeholder of `source_px`: the source's aspect
/// fitted into `viewport_px` and floored, the rule the render's fast pass
/// sizes its surface by, so swapping to the render rarely resizes the
/// surface. Unlike the render it upscales a small thumbnail to the viewport,
/// so the dither lands on display pixels. An unknown viewport keeps the
/// source size. Never wider or taller than [`MAX_TEXTURE_EDGE`].
#[must_use]
pub fn placeholder_surface_dims(source_px: (u32, u32), viewport_px: Size) -> Option<(u32, u32)> {
    let (source_w, source_h) = source_px;
    if source_w == 0 || source_h == 0 {
        return None;
    }
    let source = Size::new(f64::from(source_w), f64::from(source_h));
    let viewport = viewport_px.sanitized_extent();
    let fitted = if viewport.width >= 1.0 && viewport.height >= 1.0 {
        let scale = (viewport.width / source.width).min(viewport.height / source.height);
        Size::new(
            (source.width * scale).floor(),
            (source.height * scale).floor(),
        )
    } else {
        source
    };
    let long_edge = fitted.width.max(fitted.height);
    let capped = if long_edge > MAX_TEXTURE_EDGE {
        let scale = MAX_TEXTURE_EDGE / long_edge;
        Size::new(
            (fitted.width * scale).floor(),
            (fitted.height * scale).floor(),
        )
    } else {
        fitted
    };
    Some((capped.width.max(1.0) as u32, capped.height.max(1.0) as u32))
}

/// Re-encode an 8-bit RGBA still (`row_bytes` per row, alpha ignored) into
/// `out` as display-encoded RGBA in `target` primaries — the encoding the
/// present pass reads. A still already in the target primaries maps each
/// byte to `byte / 255` exactly; otherwise it is decoded, converted between
/// sRGB and Display P3 (clipped to the target gamut) and re-encoded.
/// Allocates nothing.
pub fn encode_placeholder(
    rgba: &[u8],
    dims: (u32, u32),
    row_bytes: usize,
    source: PlaceholderColorSpace,
    target: TargetPrimaries,
    out: &mut [[f32; 4]],
) -> Result<(), PlaceholderError> {
    let (width, height) = dims;
    if width == 0 || height == 0 {
        return Err(PlaceholderError::Empty);
    }
    if width > PLACEHOLDER_MAX_EDGE || height > PLACEHOLDER_MAX_EDGE {
        return Err(PlaceholderError::TooLarge);
    }
    let (width, height) = (width as usize, height as usize);
    if row_bytes < width * 4 {
        return Err(PlaceholderError::RowBytes);
    }
    if rgba.len() < (height - 1) * row_bytes + width * 4 {
        return Err(PlaceholderError::Truncated);
    }
    if out.len() != width * height {
        return Err(PlaceholderError::OutputLength);
    }
    let conversion = conversion_matrix(source.primaries(), target);
    for (row_index, out_row) in out.chunks_exact_mut(width).enumerate() {
        let row = &rgba[row_index * row_bytes..row_index * row_bytes + width * 4];
        for (texel, pixel) in out_row.iter_mut().zip(row.chunks_exact(4)) {
            let rgb = [pixel[0], pixel[1], pixel[2]];
            let encoded = conversion.map_or_else(
                || rgb.map(|byte| f32::from(byte) / 255.0),
                |matrix| convert_encoded(rgb, matrix),
            );
            *texel = [encoded[0], encoded[1], encoded[2], 1.0];
        }
    }
    Ok(())
}

/// Linear `source` → linear `target`, or `None` when they are the same.
fn conversion_matrix(source: TargetPrimaries, target: TargetPrimaries) -> Option<&'static Matrix3> {
    match (source, target) {
        (TargetPrimaries::Srgb, TargetPrimaries::P3) => Some(&M_SRGB_TO_P3),
        (TargetPrimaries::P3, TargetPrimaries::Srgb) => Some(p3_to_srgb()),
        _ => None,
    }
}

fn p3_to_srgb() -> &'static Matrix3 {
    static CELL: std::sync::OnceLock<Matrix3> = std::sync::OnceLock::new();
    CELL.get_or_init(|| M_SRGB_TO_P3.inverse().unwrap_or(Matrix3::IDENTITY))
}

/// The 256 sRGB-transfer decodes, computed once.
fn decode_table() -> &'static [f32; 256] {
    static TABLE: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| std::array::from_fn(|byte| srgb_degamma(byte as f32 / 255.0)))
}

fn convert_encoded(rgb: [u8; 3], matrix: &Matrix3) -> [f32; 3] {
    let table = decode_table();
    let linear = matrix.mul_vec(rgb.map(|byte| table[usize::from(byte)]));
    linear.map(srgb_gamma)
}

/// The CPU reference of the placeholder present (`present_chain.wgsl`'s
/// load and bilinear arms, then its blue-noise dither and quantize): the
/// RGB bytes the surface holds after presenting `encoded` (`source` texels)
/// at `surface`. The GPU parity gate diffs the real present against it.
#[cfg(any(test, feature = "test-support"))]
#[must_use]
pub fn reference_present_rgb8(
    encoded: &[[f32; 4]],
    source: (u32, u32),
    surface: (u32, u32),
) -> Vec<u8> {
    let (surface_w, surface_h) = surface;
    (0..surface_h)
        .flat_map(|y| (0..surface_w).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let color = present_sample(encoded, source, surface, x, y);
            let offset = crate::view::dither::blue_noise_offset_lsb(x, y);
            [0, 1, 2].map(|channel| quantized_byte(color[channel], offset))
        })
        .collect()
}

#[cfg(any(test, feature = "test-support"))]
fn present_sample(
    encoded: &[[f32; 4]],
    source: (u32, u32),
    surface: (u32, u32),
    x: u32,
    y: u32,
) -> [f32; 4] {
    let (src_w, src_h) = source;
    let (surface_w, surface_h) = surface;
    if source == surface {
        return encoded[(y * surface_w + x) as usize];
    }
    let sx = ((x as f32 + 0.5) * src_w as f32 / surface_w as f32 - 0.5).max(0.0);
    let sy = ((y as f32 + 0.5) * src_h as f32 / surface_h as f32 - 0.5).max(0.0);
    let (x0f, y0f) = (sx.floor(), sy.floor());
    let (fx, fy) = (sx - x0f, sy - y0f);
    let x0 = (x0f as u32).min(src_w - 1);
    let y0 = (y0f as u32).min(src_h - 1);
    let x1 = (x0 + 1).min(src_w - 1);
    let y1 = (y0 + 1).min(src_h - 1);
    let at = |px: u32, py: u32| encoded[(py * src_w + px) as usize];
    let mix =
        |a: [f32; 4], b: [f32; 4], t: f32| std::array::from_fn(|i| a[i] * (1.0 - t) + b[i] * t);
    mix(
        mix(at(x0, y0), at(x1, y0), fx),
        mix(at(x0, y1), at(x1, y1), fx),
        fy,
    )
}

#[cfg(any(test, feature = "test-support"))]
fn quantized_byte(value: f32, offset: f32) -> u8 {
    (value * 255.0 + offset + 0.5).clamp(0.0, 255.0).floor() as u8
}

#[cfg(test)]
#[path = "canvas_placeholder_tests.rs"]
mod tests;
