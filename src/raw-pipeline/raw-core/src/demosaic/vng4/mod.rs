//! VNG4 — a four-direction variable-number-of-gradients Bayer demosaic
//! (#3413).
//!
//! **Provenance.** The variable-number-of-gradients idea is Ed Chang, Shiufun
//! Cheung and Davis Y. Pan's, published as *"Color filter array recovery
//! using a threshold-based variable number of gradients"* (Proc. SPIE 3650,
//! Sensors, Cameras, and Applications for Digital Photography, 1999). This is
//! an independent Rust implementation written from that published
//! description: the structure — measure a gradient per direction, keep the
//! directions that fall under a threshold derived from the gradient spread,
//! average only those — is theirs; the discrete gradient stencil, the
//! interpolator it averages, the extremum bound and the banding strategy
//! below are derived here. No code, coefficients or naming were taken from
//! the GPL implementations that ship in RawTherapee or darktable.
//!
//! ## Why a *smooth* kernel exists at all
//!
//! AMaZE and RCD both resolve as much detail as the sensor holds by
//! committing hard to a direction. That is the right trade on resolved
//! detail and the wrong one on a noisy sky: the direction they commit to is
//! chosen from noise, and the result is the maze patterning and false colour
//! that every detail-first kernel produces in low-contrast regions. VNG4 is
//! the opposite trade — in a flat region *every* direction passes the
//! threshold, so green is the mean of four independent estimates and chroma
//! the mean of four colour differences, which is a ~2× noise reduction over
//! any single-direction reconstruction. [`super::dual`] runs both and blends
//! by local contrast so each region gets the kernel it wants.
//!
//! ## The method
//!
//! 1. **Four gradients.** For each cardinal direction `d` ∈ {N, E, S, W},
//!    [`axis_gradient`] sums absolute differences between same-colour sample
//!    pairs separated by `d`, taken on the centre line and the two lines
//!    either side of it. Every term differences two samples of one CFA
//!    colour, so a region of constant colour scores exactly zero on all four
//!    directions however far apart R, G and B sit.
//!
//! 2. **Variable number of gradients.** With `gmin` and `gmax` the smallest
//!    and largest of the four, the threshold is
//!    `T = K1·gmin + K2·(gmax − gmin)` and every direction scoring `≤ T` is
//!    kept. `gmin` always qualifies, so the set is never empty; on a flat
//!    field all four qualify, and across a hard edge only the ones that do
//!    not cross it do. This is the "variable number" the method is named
//!    for.
//!
//! 3. **Green at R/B sites.** Each kept direction contributes the
//!    gradient-corrected estimate `g_d = c[i+d] + ½(c[i] − c[i+2d])`, which
//!    reproduces a linear ramp exactly, and green is their unweighted mean.
//!    The result is bounded to the range of the four green samples around
//!    the site, so a step edge cannot make it overshoot.
//!
//! 4. **Chroma** is [`super::chroma_diff`]'s unweighted colour-difference
//!    completion — see that module for why it is unweighted here.
//!
//! ## Structure
//!
//! Bands of [`BAND`] output rows over rayon against the shared read-only CFA
//! plane, identical in shape to [`super::rcd`]: each band owns its rows, the
//! halo is read straight out of the shared plane, and the per-band scratch is
//! a few MB rather than the full-frame planes a 100 MP sensor cannot afford.
//! The outer [`BORDER`] ring takes the bilinear reconstruction, as does any
//! frame under [`MIN_DIM`] px per side.

#[cfg(test)]
mod tests;

use super::bilinear::{bilinear_cancellable, bilinear_pixel};
use super::chroma_diff;
use super::flatten_mosaic;
use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

/// Weight on the smallest gradient in the selection threshold. Chang,
/// Cheung and Pan's published pair is (1.5, 0.5) and nothing measured here
/// argued for moving it: 1.5 keeps a direction only slightly rougher than
/// the best one in the average, which is what makes the kernel average four
/// estimates on a flat field and one or two across an edge.
const K1: f32 = 1.5;

/// Weight on the gradient *spread* in the selection threshold. Widens the
/// accepted set when all four directions disagree mildly (texture) and
/// narrows it when one direction is dramatically rougher (an edge).
const K2: f32 = 0.5;

/// Width of the frame border that falls back to bilinear. The widest
/// stencil chain is a green site's assembly (±1) → that neighbour's chroma
/// (±1) → its green (±2), i.e. a reach of 4; 6 matches [`super::rcd`]'s ring
/// so the two kernels' rings coincide exactly where [`super::dual`] blends
/// them.
const BORDER: usize = 6;

/// Smallest frame that has any VNG4 interior at all. Below this the kernel
/// returns the bilinear reconstruction outright.
pub(super) const MIN_DIM: usize = 2 * BORDER + 1;

/// Output rows per rayon task. Matches [`super::rcd`]'s band height, for the
/// same reason: the per-band scratch stays in the low single-digit megabytes
/// even on a 100 MP sensor's row length.
const BAND: usize = 64;

/// VNG4 demosaic. `mosaic` must be `CameraNativeMosaic` as produced by
/// `sensor_linearize` (one populated channel per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
///
/// Non-cancellable wrapper — forwards to [`vng4_cancellable`] with a
/// never-cancel token, so the two produce identical output.
#[inline]
pub fn vng4(mosaic: &Image, cfa: CfaPattern) -> Image {
    vng4_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`vng4`], matching the [`bilinear_cancellable`]
/// contract: `cancel` is loaded once at the top of each band closure and a
/// cancelled band leaves its rows at their zero-init value. The develop
/// chain discards the whole partially-filled buffer at its post-demosaic
/// bail.
pub fn vng4_cancellable(mosaic: &Image, cfa: CfaPattern, cancel: CancelToken<'_>) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

    // Too small for any interior — and the zero-dimension guard, since
    // `par_chunks_mut(0)` panics. `bilinear_cancellable` handles both.
    if w < MIN_DIM || h < MIN_DIM {
        return bilinear_cancellable(mosaic, cfa, cancel);
    }

    let cfa_flat = flatten_mosaic(mosaic, cfa);
    let mut out = Image::new(
        mosaic.width,
        mosaic.height,
        ColorSpace::CameraNativeLinearRgb,
    );

    out.pixels
        .par_chunks_mut(w * BAND)
        .enumerate()
        .for_each(|(band_idx, band)| {
            if cancel.is_cancelled() {
                return;
            }
            render_band(band, band_idx * BAND, mosaic, &cfa_flat, cfa, w, h);
        });
    out
}

/// Fill one band of output rows: the bilinear border ring first, then the
/// VNG4 interior for whatever rows of this band are inside it.
///
/// `pub(super)` because [`super::dual`] renders VNG4 one band at a time into
/// its own scratch rather than materialising a second full-frame plane.
pub(super) fn render_band(
    band: &mut [[f32; 3]],
    y0: usize,
    mosaic: &Image,
    c: &[f32],
    cfa: CfaPattern,
    w: usize,
    h: usize,
) {
    let y1 = y0 + band.len() / w;

    for y in y0..y1 {
        let row = &mut band[(y - y0) * w..(y - y0) * w + w];
        if y < BORDER || y >= h - BORDER {
            for (x, px) in row.iter_mut().enumerate() {
                *px = bilinear_pixel(mosaic, cfa, x as i32, y as i32);
            }
        } else {
            for x in 0..BORDER {
                row[x] = bilinear_pixel(mosaic, cfa, x as i32, y as i32);
                let xr = w - 1 - x;
                row[xr] = bilinear_pixel(mosaic, cfa, xr as i32, y as i32);
            }
        }
    }

    let iy0 = y0.max(BORDER);
    let iy1 = y1.min(h - BORDER);
    if iy0 >= iy1 {
        return;
    }
    let (gy0, gy1) = (iy0 - 2, iy1 + 2);
    let (cy0, cy1) = (iy0 - 1, iy1 + 1);
    let green = green_plane(c, w, cfa, gy0, gy1, BORDER);
    let chroma = chroma_diff::chroma_plane(c, w, cfa, &green, gy0, cy0, cy1, BORDER);
    chroma_diff::assemble(
        w, cfa, band, y0, iy0, iy1, BORDER, &green, &chroma, gy0, cy0,
    );
}

/// Roughness along one direction, as a sum of absolute differences between
/// same-colour sample pairs separated by that direction.
///
/// `d` is the signed step to the neighbour (`±1` horizontal, `±w` vertical)
/// and `p` the perpendicular step. Three parallel lines contribute — the
/// centre line and the two either side — which is what makes the measure a
/// *region* property rather than a single row's noise. Every term pairs two
/// samples symmetric about a common site or two samples exactly `2d` apart,
/// so both members of every pair carry the same CFA colour and constant
/// chroma scores exactly zero.
#[inline]
fn axis_gradient(c: &[f32], i: usize, d: isize, p: isize) -> f32 {
    let at = |off: isize| c[(i as isize + off) as usize];
    let along = |o: isize| (at(o + d) - at(o - d)).abs() + (at(o + 2 * d) - at(o)).abs();
    along(0) + 0.5 * (along(p) + along(-p))
}

/// Steps 1–3 — green everywhere in rows `[gy0, gy1)`. Indexed
/// `(y − gy0) * w + x`; columns outside `[border − 2, w − border + 2)` are
/// never read and stay zero.
fn green_plane(
    c: &[f32],
    w: usize,
    cfa: CfaPattern,
    gy0: usize,
    gy1: usize,
    border: usize,
) -> Vec<f32> {
    let wi = w as isize;
    let dirs: [(isize, isize); 4] = [(-wi, 1), (wi, 1), (-1, wi), (1, wi)];
    let mut green = vec![0.0f32; (gy1 - gy0) * w];
    for y in gy0..gy1 {
        for x in (border - 2)..(w - border + 2) {
            let i = y * w + x;
            if cfa.color_at(x as u32, y as u32) == 1 {
                green[(y - gy0) * w + x] = c[i];
                continue;
            }
            let g: [f32; 4] = std::array::from_fn(|k| {
                let (d, p) = dirs[k];
                axis_gradient(c, i, d, p)
            });
            let gmin = g.iter().copied().fold(f32::INFINITY, f32::min);
            let gmax = g.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let threshold = K1 * gmin + K2 * (gmax - gmin);
            let at = |off: isize| c[(i as isize + off) as usize];
            let (mut sum, mut count) = (0.0f32, 0.0f32);
            for (k, (d, _)) in dirs.iter().enumerate() {
                if g[k] > threshold {
                    continue;
                }
                sum += at(*d) + 0.5 * (c[i] - at(2 * d));
                count += 1.0;
            }
            // `gmin <= threshold` holds for any non-negative gradient pair,
            // so `count` is at least 1; the guard is defence in depth
            // against a NaN sample making every comparison false.
            let raw = if count > 0.0 { sum / count } else { c[i] };
            green[(y - gy0) * w + x] =
                chroma_diff::no_new_extrema(raw, [at(-wi), at(wi), at(-1), at(1)]);
        }
    }
    green
}
