//! The inverse warp: for every destination pixel, find where it came from in
//! the source frame and bilinear-sample there.
//!
//! Output dimensions equal input dimensions. The transform moves content
//! *within* the frame rather than growing a bounding box around it, which is
//! what makes the surround visible (Adobe's behaviour) and what lets the user
//! crop it away with the crop tool that runs immediately after. Auto-constrain
//! is deliberately not part of this stage.
//!
//! The samplers are `stages::crop`'s, not second copies: they already define
//! the out-of-bounds fill and the narrowing round for every buffer shape the
//! renderer has, and a straighten and a keystone that disagreed about either
//! would put a visible seam between two stages the user thinks of as one tool.
//! Note the fill rule those samplers implement is a hybrid — clamp-to-edge for
//! a footprint that straddles the border, hard black once it is fully outside
//! — which is exactly what the WGSL present shader has to reproduce.

use super::matrix::Homography;
use crate::stages::crop::bilinear::{sample_rgb, sample_rgba};
use crate::stages::crop::Sample;

/// Destination pixel `(x, y)` → source pixel coordinates, or `None` when the
/// destination lies on or beyond the projective horizon.
///
/// Both halves of the conversion are the pixel-centre convention
/// `stages::crop::bilinear` uses: a destination index becomes a continuous
/// coordinate by `+ 0.5`, and the source coordinate loses the same half pixel
/// again because the sampler indexes pixel centres.
#[inline]
fn source_for(
    inverse: &Homography,
    x: usize,
    y: usize,
    half_w: f32,
    half_h: f32,
) -> Option<(f32, f32)> {
    let nx = (x as f32 + 0.5) / half_w - 1.0;
    let ny = (y as f32 + 0.5) / half_h - 1.0;
    let (sxn, syn) = inverse.project(nx, ny)?;
    Some(((sxn + 1.0) * half_w - 0.5, (syn + 1.0) * half_h - 0.5))
}

/// Inverse-warp an interleaved integer RGB buffer through `inverse`
/// (destination → source, in normalized `[-1, 1]` space).
///
/// Runs at both display depths off one implementation for the same reason the
/// crop tail does (#943): the 8-bit canvas and the 16-bit export master must
/// not be able to disagree about where a pixel landed.
pub(super) fn warp_int_rgb<T: Sample>(
    rgb: &[T],
    width: u32,
    height: u32,
    inverse: &Homography,
) -> Vec<T> {
    let w = width as usize;
    let h = height as usize;
    let half_w = width as f32 / 2.0;
    let half_h = height as f32 / 2.0;
    let mut out = vec![T::default(); w * h * 3];
    for y in 0..h {
        for x in 0..w {
            // A `None` source leaves the surround fill already in `out`,
            // which is the same black the sampler returns for a finite
            // coordinate outside the frame.
            let Some((sx, sy)) = source_for(inverse, x, y, half_w, half_h) else {
                continue;
            };
            let sample = sample_rgb(rgb, width, height, sx, sy);
            let di = (y * w + x) * 3;
            out[di] = sample[0];
            out[di + 1] = sample[1];
            out[di + 2] = sample[2];
        }
    }
    out
}

/// Inverse-warp a packed `[f32; 4]` RGBA buffer — the shape the GPU live
/// chain hands the present shader.
///
/// This is the oracle the WGSL present warp is gated against
/// (`raw-gpu`'s `present_chain` parity test), which is why it exists
/// alongside the integer tail rather than being folded into it: the display
/// tail warps quantized samples, the present shader warps the chain's f32
/// output, and only the second is a fair comparison for the shader.
/// Out-of-frame pixels take the sampler's `[0, 0, 0, 1]` — opaque black, so
/// no downstream view transform sees a premultiplied-alpha discontinuity.
pub fn warp_f32_rgba(rgba: &[f32], width: u32, height: u32, inverse: &Homography) -> Vec<f32> {
    let w = width as usize;
    let h = height as usize;
    let half_w = width as f32 / 2.0;
    let half_h = height as f32 / 2.0;
    let mut out = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let di = (y * w + x) * 4;
            let sample = match source_for(inverse, x, y, half_w, half_h) {
                Some((sx, sy)) => sample_rgba(rgba, width, height, sx, sy),
                None => [0.0, 0.0, 0.0, 1.0],
            };
            out[di] = sample[0];
            out[di + 1] = sample[1];
            out[di + 2] = sample[2];
            out[di + 3] = sample[3];
        }
    }
    out
}
