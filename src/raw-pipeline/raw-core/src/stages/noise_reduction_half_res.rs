//! Half-resolution chroma NR at native density (#6018): the full develop, its
//! deep-zoom tiles, and the scene-linear chains whenever they run at a
//! sampling scale of one. raw-gpu's `noise_reduction/half_grid.rs` is the
//! WGSL twin.
//!
//! Chroma NLM at native resolution was half of a default 24 MP export. Here
//! the Oklab a/b planes are box-averaged 2×2 on a grid anchored to the
//! developed frame, denoised with the search support the sized chain uses at
//! a 0.5 sampling scale (#3875), and bilinearly upsampled. The finest-scale
//! chroma residual (native minus its own upsampled 2×2 average) is almost all
//! noise; it is kept with weight `1 - t`, so the slider still runs
//! continuously from identity at 0 to fully half-resolution chroma at 100.
//!
//! The block grid and the fixed 0.25 / 0.75 upsampling weights depend only
//! on frame coordinates, so a tile or native window whose buffer starts at
//! `origin` reproduces the whole-frame result away from its edges;
//! [`HALF_RES_CHROMA_REACH_PX`] is that edge band.

use super::{chroma_params, oklab_planes, CHROMA_PATCH_RADIUS};
use crate::cancel::CancelToken;
use crate::color::oklab::oklab_to_rec2020;
use crate::image::{ColorSpace, Image};
use crate::stages::nlm::denoise_chroma_pair_cancellable;
use rayon::prelude::*;

/// `chroma_search_radius(0.5)`: the sized chain's support at half density.
const HALF_RES_SEARCH_RADIUS: usize = 2;

/// Native pixels per side a tile needs beyond its inner rect: the half-res
/// NLM stencil and one block of bilinear support, in native pixels, plus a
/// partial block at an odd buffer edge.
pub const HALF_RES_CHROMA_REACH_PX: usize =
    2 * (CHROMA_PATCH_RADIUS + HALF_RES_SEARCH_RADIUS + 1) + 2;

/// Block grid of a buffer whose first pixel sits at frame coordinate
/// `origin` along one axis.
#[derive(Clone, Copy)]
struct Axis {
    offset: usize,
    blocks: usize,
}

impl Axis {
    fn new(len: usize, origin: i32) -> Self {
        let offset = origin.rem_euclid(2) as usize;
        Self {
            offset,
            blocks: (len - 1 + offset) / 2 + 1,
        }
    }

    /// The buffer pixels block `b` covers.
    fn span(self, b: usize, len: usize) -> std::ops::Range<usize> {
        (2 * b).saturating_sub(self.offset)..(2 * b + 2 - self.offset).min(len)
    }

    fn block_of(self, i: usize) -> usize {
        (i + self.offset) / 2
    }

    /// The two blocks bilinear upsampling reads for pixel `i`, nearer first.
    fn taps(self, i: usize) -> (usize, usize) {
        let aligned = i + self.offset;
        let near = aligned / 2;
        let far = if aligned % 2 == 0 {
            near.saturating_sub(1)
        } else {
            (near + 1).min(self.blocks - 1)
        };
        (near, far)
    }
}

fn box_down(plane: &[f32], w: usize, h: usize, x: Axis, y: Axis) -> Vec<f32> {
    let mut means = vec![0.0f32; x.blocks * y.blocks];
    means
        .par_chunks_exact_mut(x.blocks)
        .enumerate()
        .for_each(|(by, row)| {
            let rows = y.span(by, h);
            for r in rows.clone() {
                for (c, v) in plane[r * w..(r + 1) * w].iter().enumerate() {
                    row[x.block_of(c)] += v;
                }
            }
            for (bx, m) in row.iter_mut().enumerate() {
                *m /= (x.span(bx, w).len() * rows.len()) as f32;
            }
        });
    means
}

fn sample(plane: &[f32], stride: usize, x: Axis, y: Axis, c: usize, r: usize) -> f32 {
    let ((xn, xf), (yn, yf)) = (x.taps(c), y.taps(r));
    let at = |bx: usize, by: usize| plane[by * stride + bx];
    0.75 * (0.75 * at(xn, yn) + 0.25 * at(xf, yn)) + 0.25 * (0.75 * at(xn, yf) + 0.25 * at(xf, yf))
}

/// `origin` is the buffer's top-left in the developed frame: `(0, 0)` for a
/// whole frame, the trimmed tile's or the native window's origin otherwise.
pub(super) fn apply_color_half_res_cancellable(
    img: &mut Image,
    amount: f32,
    cancel: CancelToken<'_>,
    noise_profile: Option<&[f32]>,
    iso: u32,
    origin: (i32, i32),
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    let (w, h) = (img.width as usize, img.height as usize);
    if amount.abs() < 1e-3 || w == 0 || h == 0 {
        return;
    }
    let params = super::NlmParams {
        search_radius: HALF_RES_SEARCH_RADIUS,
        ..chroma_params(amount)
    };
    let residual_weight = 1.0 - (amount / 100.0).clamp(0.0, 1.0);
    let (x, y) = (Axis::new(w, origin.0), Axis::new(h, origin.1));
    let (l_plane, a_plane, b_plane) = oklab_planes(&img.pixels);
    let (half_l, half_a, half_b) = (
        box_down(&l_plane, w, h, x, y),
        box_down(&a_plane, w, h, x, y),
        box_down(&b_plane, w, h, x, y),
    );
    let (den_a, den_b) = denoise_chroma_pair_cancellable(
        &half_a,
        &half_b,
        x.blocks,
        y.blocks,
        params,
        cancel,
        &half_l,
        noise_profile,
        iso,
    );
    let stride = x.blocks;
    img.pixels
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(r, row)| {
            for (c, dst) in row.iter_mut().enumerate() {
                let i = r * w + c;
                let up = |den: &[f32], noisy: &[f32], native: f32| {
                    sample(den, stride, x, y, c, r)
                        + residual_weight * (native - sample(noisy, stride, x, y, c, r))
                };
                *dst = oklab_to_rec2020([
                    l_plane[i],
                    up(&den_a, &half_a, a_plane[i]),
                    up(&den_b, &half_b, b_plane[i]),
                ]);
            }
        });
}

#[cfg(test)]
#[path = "noise_reduction_half_res_tests.rs"]
mod tests;
