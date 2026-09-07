//! RCD — Ratio Corrected Demosaicing (Luis Sanz Rodríguez, 2017).
//!
//! The on-screen full-quality Bayer kernel (`RenderQuality::Full`, #3412).
//! It sits between Hamilton-Adams and AMaZE: close to AMaZE on resolved
//! detail, better than either on smooth gradients and skin because every
//! interpolation is a *ratio transport* rather than an additive Laplacian
//! correction, and materially cheaper than AMaZE.
//!
//! **Provenance.** This is an independent Rust implementation written from
//! the published description of the method — the four-step structure and
//! the ratio-correction idea are Sanz Rodríguez's; the discrete operators,
//! the weighting form, the stabilising floors and the banding strategy
//! below are derived here. No code, coefficients or naming were taken from
//! the GPL implementations that ship in RawTherapee or darktable.
//!
//! ## The method, in four steps
//!
//! 1. **Directional discrimination.** At every site, measure how *rough*
//!    the CFA data is along the vertical and the horizontal axis over a
//!    7-tap window ([`steps::axis_energy`]). The measure combines the
//!    same-colour curvature (samples two apart share a CFA colour, so this
//!    term carries no chroma) with the opposite-colour curvature and
//!    gradient, so a region of constant colour scores exactly zero on both
//!    axes no matter how far apart R, G and B sit. The two energies become
//!    a soft blend weight through their ratio, `w_v = E_h / (E_v + E_h)`,
//!    with a floor `DIR_EPS` added to both sides: below the sensor noise
//!    level the weights relax to ½ ½ (plain averaging) instead of latching
//!    onto noise. Blending softly rather than switching hard is what keeps
//!    zippers off edges the discriminator finds ambiguous.
//!
//! 2. **Green at R/B sites, by ratio-corrected transport.** Along one axis
//!    the two green neighbours sit halfway between the centre's own colour
//!    samples at 0 and ±2. Rather than averaging the greens and adding a
//!    curvature correction (Hamilton-Adams), each green neighbour is
//!    *transported* to the centre by the ratio the centre channel changes
//!    over that same half-step: `g · c₀ / mean(c₀, c±2)`. That is the "ratio
//!    correction". It reproduces a flat field and a linear ramp exactly, it
//!    cannot overshoot at a step edge (the transport ratio of non-negative
//!    data is bounded by `RATIO_MAX` = 2 by construction), and it carries
//!    the centre sample's full high-frequency content into green rather
//!    than a smoothed version of it. The vertical and horizontal estimates
//!    are blended by step 1's weights.
//!
//! 3. **The opposite chroma at R/B sites, on the diagonals.** At an R site
//!    blue lives on the four diagonal neighbours (and vice versa). The same
//!    discrimination runs on the two ±45° axes, and the winning diagonal's
//!    colour difference `C − G` is interpolated and added back to the
//!    centre's green. Colour difference rather than colour ratio here: the
//!    chroma/green ratio is unbounded in deep shadow, where a difference is
//!    numerically bulletproof.
//!
//! 4. **Red and blue at G sites.** After step 3 both chroma channels are
//!    known at every non-green site, so all four orthogonal neighbours of a
//!    green site carry both. Their colour differences are interpolated with
//!    step 1's weights again and added to the site's own green sample.
//!
//! ## Structure
//!
//! Bands of [`BAND`] output rows are distributed over rayon; each band owns
//! its rows exclusively and derives everything it needs from the shared
//! read-only mosaic plane, so the result is scheduling-independent and
//! bit-reproducible. Bands span the full frame width, so only a top/bottom
//! halo is needed and it is read straight out of the shared plane — no tile
//! fill, no mirrored halo, no seam risk. The per-band scratch is two small
//! planes (green, and the R/B pair) covering the band plus a ±2 / ±1 row
//! halo, a few MB rather than the full-frame planes a 100 MP sensor cannot
//! afford.
//!
//! The outer [`BORDER`] ring takes the bilinear reconstruction, because the
//! step-1 stencil reaches 5 px and would hang outside the frame there —
//! the same policy as Hamilton-Adams' 2-px ring and the same reason. A
//! frame too small to have any interior at all is bilinear outright.

mod steps;
#[cfg(test)]
mod tests;

use super::bilinear::{bilinear_cancellable, bilinear_pixel};
use super::flatten_mosaic;
use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;
use steps::Frame;

/// Width of the frame border that falls back to bilinear. The widest
/// stencil chain is a green site's assembly (±1) → the neighbour's chroma
/// (±1) → that neighbour's green (±3), i.e. a reach of 5; 6 keeps the ring
/// even so tile-local CFA parity reasoning stays trivial.
const BORDER: usize = 6;

/// Smallest frame that has any RCD interior at all. Below this the kernel
/// returns the bilinear reconstruction outright.
const MIN_DIM: usize = 2 * BORDER + 1;

/// Output rows per rayon task. Sized so the per-band scratch stays in the
/// low single-digit megabytes even on a 100 MP sensor's row length, while
/// the recomputed green halo (±2 rows) is under 7 % of the band's work.
const BAND: usize = 64;

/// RCD demosaic. `mosaic` must be `CameraNativeMosaic` as produced by
/// `sensor_linearize` (one populated channel per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
///
/// Non-cancellable wrapper — forwards to [`rcd_cancellable`] with a
/// never-cancel token, so the two produce identical output.
#[inline]
pub fn rcd(mosaic: &Image, cfa: CfaPattern) -> Image {
    rcd_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`rcd`], matching the [`bilinear_cancellable`]
/// contract: `cancel` is loaded once at the top of each band closure and a
/// cancelled band leaves its rows at their zero-init value. A rayon
/// parallel iterator cannot `break`, so already-scheduled bands return
/// immediately and the rest are skipped; the develop chain discards the
/// whole partially-filled buffer at its post-demosaic bail. With a
/// never-cancel token the per-band load is a no-op branch and the output is
/// identical to [`rcd`].
pub fn rcd_cancellable(mosaic: &Image, cfa: CfaPattern, cancel: CancelToken<'_>) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

    // Too small for any interior — and the zero-dimension guard, since
    // `par_chunks_mut(0)` panics. `bilinear_cancellable` handles both.
    if w < MIN_DIM || h < MIN_DIM {
        return bilinear_cancellable(mosaic, cfa, cancel);
    }

    let cfa_flat = flatten_mosaic(mosaic, cfa);
    let frame = Frame {
        c: &cfa_flat,
        w,
        cfa,
    };
    let mut out = Image::new(
        mosaic.width,
        mosaic.height,
        ColorSpace::CameraNativeLinearRgb,
    );

    out.pixels
        .par_chunks_mut(w * BAND)
        .enumerate()
        .for_each(|(band_idx, band)| {
            // Per-band cancel check, mirroring bilinear's per-row one.
            if cancel.is_cancelled() {
                return;
            }
            render_band(band, band_idx * BAND, mosaic, &frame, h);
        });
    out
}

/// Fill one band of output rows: the bilinear border ring first, then the
/// RCD interior for whatever rows of this band are inside it.
fn render_band(band: &mut [[f32; 3]], y0: usize, mosaic: &Image, frame: &Frame<'_>, h: usize) {
    let w = frame.w;
    let y1 = y0 + band.len() / w;

    for y in y0..y1 {
        let row = &mut band[(y - y0) * w..(y - y0) * w + w];
        if y < BORDER || y >= h - BORDER {
            // Whole row is ring.
            for (x, px) in row.iter_mut().enumerate() {
                *px = bilinear_pixel(mosaic, frame.cfa, x as i32, y as i32);
            }
        } else {
            // Left and right ring columns only.
            for x in 0..BORDER {
                row[x] = bilinear_pixel(mosaic, frame.cfa, x as i32, y as i32);
                let xr = w - 1 - x;
                row[xr] = bilinear_pixel(mosaic, frame.cfa, xr as i32, y as i32);
            }
        }
    }

    let iy0 = y0.max(BORDER);
    let iy1 = y1.min(h - BORDER);
    if iy0 >= iy1 {
        return;
    }
    steps::interior(frame, band, y0, iy0, iy1, BORDER);
}
