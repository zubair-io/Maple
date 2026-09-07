//! Colour-difference chroma completion, shared by the two smooth Bayer
//! kernels ([`super::vng4`] and [`super::lmmse`], #3413).
//!
//! Both kernels reconstruct green first and then owe the caller the two
//! chroma channels everywhere. Chroma on a Bayer sensor is sampled at half
//! the green rate and carries no detail green does not already have, so the
//! interpolation runs on the colour *difference* `C − G` — a signal that is
//! flat wherever the scene's hue is flat, however violently luminance moves
//! — and adds the site's own green back at the end.
//!
//! Unlike [`super::rcd`]'s chroma steps, which blend the two diagonals (and
//! the two axes) by a directional discriminator, everything here is an
//! **unweighted** mean over all four contributing neighbours. That is the
//! whole point: these are the kernels chosen for flat and noisy regions, and
//! averaging four samples instead of leaning on the smoothest one is what
//! halves the chroma noise the region is being reconstructed for. On
//! resolved detail the directional kernels do better, which is exactly why
//! the dual mode ([`super::dual`]) hands those regions to AMaZE or RCD
//! instead.
//!
//! Both steps bound their result to the range of the samples that fed it
//! ([`no_new_extrema`]) for the same reason RCD does: the colour-difference
//! form extrapolates across a hard edge into a patch whose green is near
//! zero, and the develop chain's pre-DCP stages would clip the resulting
//! negative to a flat zero.

use crate::image::CfaPattern;

/// Bound an interpolated chroma value to the range its own contributing
/// neighbours span, so the reconstruction introduces no new extremum.
#[inline]
pub(super) fn no_new_extrema(value: f32, neighbours: [f32; 4]) -> f32 {
    let lo = neighbours.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = neighbours.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    value.clamp(lo, hi)
}

/// The full `[R, B]` pair at every non-green site in rows `[cy0, cy1)`: the
/// site's own sample, plus the opposite chroma from the unweighted mean of
/// the four ±45° diagonal neighbours' colour differences.
///
/// `green` covers rows `[gy0, …)` and is indexed the same way the caller's
/// full-frame index arithmetic runs (`j − gy0 * w`); green sites of the
/// output are left at zero because nothing reads them.
#[allow(clippy::too_many_arguments)]
pub(super) fn chroma_plane(
    c: &[f32],
    w: usize,
    cfa: CfaPattern,
    green: &[f32],
    gy0: usize,
    cy0: usize,
    cy1: usize,
    border: usize,
) -> Vec<[f32; 2]> {
    let (d_back, d_fwd) = (w + 1, w - 1);
    let mut chroma = vec![[0.0f32; 2]; (cy1 - cy0) * w];
    for y in cy0..cy1 {
        for x in (border - 1)..(w - border + 1) {
            let colour = cfa.color_at(x as u32, y as u32);
            if colour == 1 {
                continue;
            }
            let i = y * w + x;
            let g_at = |j: usize| green[j - gy0 * w];
            let mean_diff = |d: usize| 0.5 * ((c[i - d] - g_at(i - d)) + (c[i + d] - g_at(i + d)));
            let raw = g_at(i) + 0.5 * (mean_diff(d_back) + mean_diff(d_fwd));
            let other = no_new_extrema(
                raw,
                [c[i - d_back], c[i + d_back], c[i - d_fwd], c[i + d_fwd]],
            );
            // `colour` is 0 (R) or 2 (B); slot 0 holds R, slot 1 holds B.
            chroma[(y - cy0) * w + x] = if colour == 0 {
                [c[i], other]
            } else {
                [other, c[i]]
            };
        }
    }
    chroma
}

/// Write the finished `[R, G, B]` triple into `band`'s rows `[iy0, iy1)`.
///
/// A non-green site already has both chroma channels from
/// [`chroma_plane`]. A green site takes each channel from the unweighted
/// mean of its four orthogonal neighbours' colour differences — after
/// [`chroma_plane`] every one of those neighbours carries both R and B.
#[allow(clippy::too_many_arguments)]
pub(super) fn assemble(
    c_w: usize,
    cfa: CfaPattern,
    band: &mut [[f32; 3]],
    y0: usize,
    iy0: usize,
    iy1: usize,
    border: usize,
    green: &[f32],
    chroma: &[[f32; 2]],
    gy0: usize,
    cy0: usize,
) {
    let w = c_w;
    for y in iy0..iy1 {
        for x in border..(w - border) {
            let i = y * w + x;
            let g_here = green[(y - gy0) * w + x];
            let out = &mut band[(y - y0) * w + x];
            if cfa.color_at(x as u32, y as u32) != 1 {
                let rb = chroma[(y - cy0) * w + x];
                *out = [rb[0], g_here, rb[1]];
                continue;
            }
            let at = |j: usize, ch: usize| chroma[j - cy0 * w][ch];
            let est = |ch: usize| {
                let neighbours = [at(i - w, ch), at(i + w, ch), at(i - 1, ch), at(i + 1, ch)];
                let mean_diff = 0.25
                    * ((neighbours[0] - green[(i - w) - gy0 * w])
                        + (neighbours[1] - green[(i + w) - gy0 * w])
                        + (neighbours[2] - green[(i - 1) - gy0 * w])
                        + (neighbours[3] - green[(i + 1) - gy0 * w]));
                no_new_extrema(g_here + mean_diff, neighbours)
            };
            *out = [est(0), g_here, est(1)];
        }
    }
}
