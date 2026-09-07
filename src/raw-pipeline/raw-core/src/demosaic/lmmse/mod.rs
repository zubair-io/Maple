//! LMMSE — directional linear minimum mean-square-error Bayer demosaic, the
//! high-ISO kernel (#3413).
//!
//! **Provenance.** The method is Lei Zhang and Xiaolin Wu's, published as
//! *"Color demosaicking via directional linear minimum mean square-error
//! estimation"* (IEEE Transactions on Image Processing 14(12):2167–2178,
//! 2005). This is an independent Rust implementation written from that
//! published description: the structure — form the primary difference signal
//! along each axis, treat it as a signal in noise, shrink it toward its local
//! mean by the LMMSE gain, and fuse the two directions by their estimated
//! mean-square errors — is theirs; the discrete interpolator, the
//! signal/noise split, the extremum bound and the banding strategy below are
//! derived here. No code, coefficients or naming were taken from the GPL
//! implementations that ship in RawTherapee or darktable.
//!
//! ## Why this kernel exists
//!
//! Every other kernel in this module treats the CFA samples as noiseless and
//! spends its cleverness on *which direction* to interpolate along. At high
//! ISO that premise fails: the direction is chosen from noise, and the
//! reconstruction faithfully amplifies whatever the sensor read. LMMSE is the
//! only kernel here with an explicit noise model, and it is what the
//! automatic selection reaches for when the frame's noise level says the
//! other kernels' assumptions no longer hold (see [`super::policy`]).
//!
//! ## The method
//!
//! 1. **The primary difference signal.** Along any single row of a Bayer
//!    sensor the samples alternate between green and *one* chroma colour, so
//!    a row-local `G − C` is a well-defined quantity at every site: at a
//!    green site it is the sample minus the row's interpolated chroma, at a
//!    chroma site the interpolated green minus the sample. Both use the same
//!    5-tap gradient-corrected interpolator, which reproduces a linear ramp
//!    exactly. The same holds down any column. That gives two full planes,
//!    `d_h` and `d_v`.
//!
//!    Note the two agree on *what they are* only at R/B sites: an R site's
//!    row and column both carry red, so both planes estimate `G − R` there.
//!    At a green site the row carries one chroma colour and the column the
//!    other, so the two planes measure different things — which is fine,
//!    because green is only ever *interpolated* at R/B sites, and the window
//!    statistics along a line stay internally consistent.
//!
//! 2. **Signal in noise.** Over a 9-tap window along the direction, the
//!    total variance of `d` is split into a smooth part and a noise part.
//!    The noise part is estimated from the second difference of `d` along the
//!    same direction: for white noise of variance `σ²` the second difference
//!    has variance `6σ²`, so a mean of squared second differences over the
//!    window divided by 6 is an unbiased estimate that costs three taps and
//!    needs no separate filtered plane.
//!
//! 3. **The LMMSE estimate.** With `var_x` the signal variance and `var_n`
//!    the noise variance, the estimate is the classic shrinkage
//!    `d̂ = μ + var_x / (var_x + var_n) · (d − μ)`: on clean data the gain is
//!    1 and `d` passes through, and as noise takes over the gain falls to 0
//!    and the estimate relaxes to the local mean. Its own mean-square error
//!    is `var_x · var_n / (var_x + var_n)`.
//!
//! 4. **Fusion.** The two directional estimates combine weighted by the
//!    inverse of those errors, so the direction the data says is better
//!    estimated dominates — a continuous, data-driven version of the hard
//!    direction choice the other kernels make.
//!
//! 5. **Chroma** is [`super::chroma_diff`]'s unweighted colour-difference
//!    completion. Chroma noise is the dominant artefact in exactly the
//!    frames this kernel runs on, and unweighted averaging of four
//!    neighbours is the quietest reconstruction available.
//!
//! ## Structure
//!
//! Bands of [`BAND`] output rows over rayon against the shared read-only CFA
//! plane, the same shape as [`super::rcd`] and [`super::vng4`]. The per-band
//! scratch is the two difference planes plus green and chroma over the band
//! and its halo — a few MB, not the full-frame planes a 100 MP sensor cannot
//! afford. The outer [`BORDER`] ring takes the bilinear reconstruction, as
//! does any frame under [`MIN_DIM`] px per side.

#[cfg(test)]
mod tests;

use super::bilinear::{bilinear_cancellable, bilinear_pixel};
use super::chroma_diff;
use super::flatten_mosaic;
use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

/// Half-width of the statistics window along each direction; the window is
/// `2·M + 1` taps. Nine taps is the shortest window whose variance estimate
/// is stable enough to drive a shrinkage gain, and short enough that the
/// local mean it relaxes toward is still local.
const M: usize = 4;

/// Taps in the statistics window.
const WINDOW: usize = 2 * M + 1;

/// Variance of the second difference of white noise, in units of the
/// noise's own variance: `Var(x₋₁ − 2x₀ + x₊₁) = (1 + 4 + 1)σ² = 6σ²`.
/// Dividing the mean squared second difference by this recovers `σ²`.
const SECOND_DIFF_GAIN: f32 = 6.0;

/// Floor on the shrinkage and fusion denominators, so an exactly noiseless
/// and exactly flat window (a synthetic ramp, a black frame) yields a gain
/// of 0 and equal fusion weights rather than `0/0`.
const EPS: f32 = 1e-9;

/// Width of the frame border that falls back to bilinear. The stencil chain
/// is a green site's assembly (±1) → that neighbour's chroma (±1) → its
/// green (±2 more) → the difference-plane window (±5) → the 5-tap
/// interpolator (±2), i.e. a reach of 9; 10 keeps one column of margin.
const BORDER: usize = 10;

/// Smallest frame that has any LMMSE interior at all. Below this the kernel
/// returns the bilinear reconstruction outright.
const MIN_DIM: usize = 2 * BORDER + 1;

/// Output rows per rayon task. Smaller than [`super::rcd`]'s 64 because this
/// kernel's per-band scratch carries two extra full-width difference planes
/// over a ±7-row halo; 48 keeps the total in the low tens of megabytes on a
/// 100 MP sensor's row length while the halo stays under 30 % of the band.
const BAND: usize = 48;

/// LMMSE demosaic. `mosaic` must be `CameraNativeMosaic` as produced by
/// `sensor_linearize` (one populated channel per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
///
/// Non-cancellable wrapper — forwards to [`lmmse_cancellable`] with a
/// never-cancel token, so the two produce identical output.
#[inline]
pub fn lmmse(mosaic: &Image, cfa: CfaPattern) -> Image {
    lmmse_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`lmmse`], matching the [`bilinear_cancellable`]
/// contract: `cancel` is loaded once at the top of each band closure and a
/// cancelled band leaves its rows at their zero-init value.
pub fn lmmse_cancellable(mosaic: &Image, cfa: CfaPattern, cancel: CancelToken<'_>) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

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
/// LMMSE interior for whatever rows of this band are inside it.
fn render_band(
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
    let (dy0, dy1) = (gy0 - (M + 1), gy1 + (M + 1));
    let (dh, dv) = difference_planes(c, w, cfa, dy0, dy1, BORDER);
    let green = green_plane(c, w, cfa, &dh, &dv, dy0, gy0, gy1, BORDER);
    let chroma = chroma_diff::chroma_plane(c, w, cfa, &green, gy0, cy0, cy1, BORDER);
    chroma_diff::assemble(
        w, cfa, band, y0, iy0, iy1, BORDER, &green, &chroma, gy0, cy0,
    );
}

/// The 5-tap gradient-corrected interpolation of the *other* colour along
/// one axis. At a green site it estimates the row's (or column's) chroma; at
/// a chroma site it estimates green. Exact on a linear ramp.
#[inline]
fn interpolate_across(c: &[f32], i: usize, s: usize) -> f32 {
    0.5 * (c[i - s] + c[i + s]) + 0.25 * (2.0 * c[i] - c[i - 2 * s] - c[i + 2 * s])
}

/// Step 1 — the horizontal and vertical primary difference signals `G − C`
/// over rows `[dy0, dy1)`. Both are indexed `j − dy0 * w` for a full-frame
/// index `j`; columns outside the reach of the green pass stay zero.
fn difference_planes(
    c: &[f32],
    w: usize,
    cfa: CfaPattern,
    dy0: usize,
    dy1: usize,
    border: usize,
) -> (Vec<f32>, Vec<f32>) {
    let n = (dy1 - dy0) * w;
    let mut dh = vec![0.0f32; n];
    let mut dv = vec![0.0f32; n];
    let reach = M + 3;
    for y in dy0..dy1 {
        for x in (border - reach)..(w - border + reach) {
            let i = y * w + x;
            let est_h = interpolate_across(c, i, 1);
            let est_v = interpolate_across(c, i, w);
            let (a, b) = if cfa.color_at(x as u32, y as u32) == 1 {
                (c[i] - est_h, c[i] - est_v)
            } else {
                (est_h - c[i], est_v - c[i])
            };
            dh[(y - dy0) * w + x] = a;
            dv[(y - dy0) * w + x] = b;
        }
    }
    (dh, dv)
}

/// Steps 2–3 — the LMMSE estimate of the difference signal at `i` along one
/// direction, and the mean-square error of that estimate.
#[inline]
fn directional_estimate(d: &[f32], base: usize, i: usize, step: usize) -> (f32, f32) {
    let taps: [f32; WINDOW] = std::array::from_fn(|k| d[i + (k * step) - (M * step) - base]);
    let mean = taps.iter().sum::<f32>() / WINDOW as f32;
    let var_total = taps.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / WINDOW as f32;
    let noise_energy: f32 = (0..WINDOW)
        .map(|k| {
            let j = i + (k * step) - (M * step) - base;
            let sd = d[j - step] - 2.0 * d[j] + d[j + step];
            sd * sd
        })
        .sum();
    let var_n = noise_energy / (WINDOW as f32 * SECOND_DIFF_GAIN);
    let var_x = (var_total - var_n).max(0.0);
    let gain = var_x / (var_x + var_n + EPS);
    let estimate = mean + gain * (taps[M] - mean);
    let mse = var_x * var_n / (var_x + var_n + EPS) + EPS;
    (estimate, mse)
}

/// Step 4 plus the write-out — green everywhere in rows `[gy0, gy1)`, from
/// the error-weighted fusion of the two directional estimates. Indexed
/// `(y − gy0) * w + x`.
#[allow(clippy::too_many_arguments)]
fn green_plane(
    c: &[f32],
    w: usize,
    cfa: CfaPattern,
    dh: &[f32],
    dv: &[f32],
    dy0: usize,
    gy0: usize,
    gy1: usize,
    border: usize,
) -> Vec<f32> {
    let base = dy0 * w;
    let mut green = vec![0.0f32; (gy1 - gy0) * w];
    for y in gy0..gy1 {
        for x in (border - 2)..(w - border + 2) {
            let i = y * w + x;
            if cfa.color_at(x as u32, y as u32) == 1 {
                green[(y - gy0) * w + x] = c[i];
                continue;
            }
            let (est_h, mse_h) = directional_estimate(dh, base, i, 1);
            let (est_v, mse_v) = directional_estimate(dv, base, i, w);
            let fused = (est_h * mse_v + est_v * mse_h) / (mse_h + mse_v);
            green[(y - gy0) * w + x] =
                chroma_diff::no_new_extrema(c[i] + fused, [c[i - w], c[i + w], c[i - 1], c[i + 1]]);
        }
    }
    green
}
