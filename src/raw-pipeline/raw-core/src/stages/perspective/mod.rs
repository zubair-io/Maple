//! Manual geometry (#3410) — vertical and horizontal keystone, rotation,
//! scale, aspect stretch and X/Y offset, composed into ONE homography and
//! applied in ONE resample.
//!
//! ## Where it sits
//!
//! In the display tail (`pipeline::render::finish`), between EXIF orientation
//! and the user crop:
//!
//! ```text
//! quantize → EXIF orientation → manual geometry → crop / straighten
//! ```
//!
//! Orientation first, because every slider here is authored against what the
//! photographer sees, not against sensor framing. Crop last, because the crop
//! rect is how the user removes the transparent surround a keystone leaves —
//! it has to be able to see that surround to frame it out. One resample, not
//! two: the seven sliders multiply into a single 3×3 before a pixel moves, so
//! stacking a keystone on a rotation costs exactly what either costs alone.
//!
//! ## Identity is free
//!
//! [`Perspective::is_identity`] short-circuits before any allocation, so a
//! model with untouched geometry renders bit-identically to a build without
//! this stage. That is what keeps the colour parity harness's baseline
//! unmoved.
//!
//! ## What is deliberately not here
//!
//! *Auto-constrain* — growing or shrinking the crop rect to swallow the
//! surround automatically — is out of scope for #3410 and is not stubbed.
//! Pixels the warp pulls from outside the source render as black exactly as
//! Adobe renders them, and the user crops them away with the crop tool.

mod matrix;
mod warp;

#[cfg(test)]
mod tests;

pub use matrix::{Homography, Perspective, ASPECT_MAX_RATIO, KEYSTONE_MAX, OFFSET_MAX};
pub use warp::warp_f32_rgba;

use crate::stages::crop::Sample;

/// Apply the manual-geometry homography to an interleaved integer RGB buffer
/// at either display depth.
///
/// Dimensions are unchanged, so the caller's crop rect keeps meaning what it
/// meant. Returns `None` for an identity transform, letting the caller move
/// its own buffer on rather than take a copy of it — the same allocation
/// discipline `pipeline::render::finish` already applies to orientation and
/// crop (#2486).
pub fn apply_int_rgb<T: Sample>(
    rgb: &[T],
    width: u32,
    height: u32,
    perspective: &Perspective,
) -> Option<Vec<T>> {
    debug_assert_eq!(
        rgb.len(),
        (width as usize) * (height as usize) * 3,
        "RGB buffer size mismatch ({}, expected {})",
        rgb.len(),
        (width as usize) * (height as usize) * 3,
    );
    if perspective.is_identity() || width == 0 || height == 0 {
        return None;
    }
    let inverse = perspective.inverse_matrix(aspect_ratio(width, height));
    if inverse == Homography::IDENTITY {
        return None;
    }
    Some(warp::warp_int_rgb(rgb, width, height, &inverse))
}

/// Display-oriented `width / height`, the one thing the matrix builder needs
/// from the raster so rotation stays circular rather than shearing.
pub fn aspect_ratio(width: u32, height: u32) -> f32 {
    if height == 0 {
        return 1.0;
    }
    width as f32 / height as f32
}
