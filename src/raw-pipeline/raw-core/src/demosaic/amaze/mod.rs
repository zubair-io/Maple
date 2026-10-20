//! AMaZE-refinement demosaic. Drop-in alternative to `hamilton_adams` for
//! full-quality renders. Reduces zipper artefacts on edges, resolves finer
//! detail than HA, and resists moiré on Bayer-pattern-prone content (fine
//! fabric, building façades).
//!
//! Algorithm ported from RawTherapee's `amaze_demosaic_RT.cc` (scalar
//! branch), including its tile structure (#1887): the frame is processed in
//! `TS × TS` tiles whose 16-px halos overlap, so every intermediate plane is
//! a small per-thread buffer that stays cache-resident and the tiles run in
//! parallel (bands of output rows are distributed over rayon; each band
//! walks its tiles serially with one reused scratch). Tiles start at −16 and
//! out-of-frame halo pixels are filled by parity-preserving mirror
//! reflection, so frame borders get the full AMaZE reconstruction.
//!
//! Stage map (line numbers refer to the upstream engine source):
//!
//!   * Fill       — copy the tile window out of the flattened mosaic
//!                  (reflected halo at frame edges) — engine 196–360.
//!   * Stage 0.5  — directional roughness weights `dirwts0/dirwts1` and the
//!                  H/V gradient sum `delhvsqsum` (368–377).
//!   * Stage 1    — Hamilton-Adams green + dirwts-weighted colour
//!                  differences (449–532).
//!   * Stage 2    — variance-based selection of vcd/vcdalt, hcd/hcdalt
//!                  (601–609).
//!   * Stage 3    — median-bound colour differences on saturated edges
//!                  (619–682), in the same per-site traversal as stage 2:
//!                  later variance tests read earlier bounded differences.
//!   * Stage 4    — adaptive H/V direction weight per R/B site (741–784).
//!   * Stage 5    — full AMaZE chroma reconstruction (802–1559): Nyquist
//!                  texture mask + dilation, 13×13 area interpolation of
//!                  `hvwt` in Nyquist regions, G-curvature refinement, the
//!                  `pmwt` ±45° diagonal R+B interpolation, the directional
//!                  `Dgrb` field with the `(1.325, −0.175, −0.075)`
//!                  sharpening kernel, and the final hvwt-weighted assembly.
//!   * Stage 6    — Maple-specific post-demosaic false-colour suppression
//!                  (see `fcs.rs`).
//!
//! Index adaptation: the engine stores the per-CFA-pair buffers (`hvwt`,
//! `Dgrb`, `nyquist`, …) at `indx >> 1` because only one 2×2 phase per
//! buffer is ever written. We keep exactly that scheme (`hf(i, d)` =
//! `(i + d) >> 1`): an R/B site and its in-pair G partner alias to the same
//! half-res cell, and the aliasing is load-bearing — the diagonal
//! `hvwt[(i ± m1) >> 1]` reads collapse the horizontal ±1 and become
//! vertical-only, which a naive full-res buffer would get wrong.
//!
//! Maple specifics: input/output use `Image` (`Vec<[f32; 3]>`). Falls back
//! to `hamilton_adams` for frames smaller than 17 px per side (the mirror
//! halo and interior windows need at least that much).

mod assemble;
mod diag;
mod fcs;
mod green;
mod nyquist;
mod scratch;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_fcs_luminance_edge;
#[cfg(test)]
mod tests_white_balance;

use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

use super::flatten_mosaic;
use super::hamilton_adams::hamilton_adams;
use scratch::{Scratch, Tile, BAND, TS};

/// AMaZE demosaic. `mosaic` must be `CameraNativeMosaic` produced by
/// `sensor_linearize` (single channel populated per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
pub fn amaze(mosaic: &Image, cfa: CfaPattern) -> Image {
    amaze_with_gains(mosaic, cfa, [1.0; 3])
}

/// Reconstruct in a metadata-balanced CFA domain, then return native sensor RGB.
/// Scales must be finite positive values at most one. Measured CFA samples are
/// restored exactly after reversing the reconstruction preconditioner.
pub fn amaze_with_gains(mosaic: &Image, cfa: CfaPattern, scales: [f32; 3]) -> Image {
    amaze_with_sensor_gains(mosaic, cfa, scales, None)
}

/// [`amaze_with_gains`] for a mosaic whose sites carry a spatial sensor gain
/// (DNG OpcodeList2). AMaZE bounds reconstruction against one ceiling derived
/// from the [0, 1] sensor range, so sites are reconstructed with `site_gains`
/// divided out and each channel's gain is re-applied afterwards (#5000).
pub(crate) fn amaze_with_sensor_gains(
    mosaic: &Image,
    cfa: CfaPattern,
    scales: [f32; 3],
    site_gains: Option<&[f32]>,
) -> Image {
    assert!(scales
        .iter()
        .all(|v| v.is_finite() && *v > 0.0 && *v <= 1.0));
    let clip_point = scales.into_iter().fold(1.0_f32, f32::min);
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as usize;
    let h = mosaic.height as usize;

    // The mirror halo reads up to 16 px into the frame and the interior
    // windows assume a ±8 ring; below this size return hamilton_adams
    // (which itself falls back to bilinear at < 5 px).
    if w < 17 || h < 17 {
        return hamilton_adams(mosaic, cfa);
    }

    // Flatten the sparse 3-channel mosaic to a single float per CFA site.
    let mut cfa_flat = flatten_mosaic(mosaic, cfa);
    for (i, value) in cfa_flat.iter_mut().enumerate() {
        let gain = site_gains.map_or(1.0, |g| g[i]);
        let ungained = if gain > 0.0 { *value / gain } else { *value };
        *value = ungained * scales[cfa.color_at((i % w) as u32, (i / w) as u32) as usize];
    }

    let mut out = Image::new(w as u32, h as u32, ColorSpace::CameraNativeLinearRgb);

    // Each band of `BAND` output rows is owned exclusively by one task; the
    // task walks its row of tiles serially with one reused scratch. A tile
    // at (top, left) covers `[top, top+TS)` and writes its interior
    // `[top+16, top+TS−16)` — exactly this band's rows — so writes are
    // disjoint and the result is scheduling-independent.
    out.pixels
        .par_chunks_mut(w * BAND)
        .enumerate()
        .for_each(|(band_idx, band)| {
            let top = (band_idx * BAND) as isize - 16;
            let mut s = Scratch::new();
            let mut left = -16_isize;
            while left + 16 < w as isize {
                let bottom = (top + TS as isize).min(h as isize + 16);
                let right = (left + TS as isize).min(w as isize + 16);
                let t = Tile {
                    top,
                    left,
                    rr1: (bottom - top) as usize,
                    cc1: (right - left) as usize,
                };
                s.reset();
                scratch::fill_tile(&mut s, &t, &cfa_flat, w, h);
                green::compute_dirwts_delhv(&mut s, &t);
                green::interpolate_green_diffs(&mut s, &t, cfa, clip_point);
                green::refine_and_bound(&mut s, &t, cfa, clip_point);
                green::adaptive_hvwt(&mut s, &t, cfa);
                nyquist::reconstruct_green(&mut s, &t, cfa);
                diag::diagonal_refine(&mut s, &t, cfa, clip_point);
                assemble::finish_tile(band, w, &mut s, &t, cfa);
                left += BAND as isize;
            }
        });

    // Stage 6: false-colour suppression over the assembled frame, driven by
    // the final reconstructed green plane. `MAPLE_AMAZE_FCS` overrides the
    // strength for tuning sweeps.
    let fcs_strength = std::env::var("MAPLE_AMAZE_FCS")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(fcs::FALSE_COLOUR_SUPPRESS_STRENGTH);
    let green_plane: Vec<f32> = out.pixels.par_iter().map(|p| p[1]).collect();
    fcs::suppress_false_colour(&mut out, &cfa_flat, &green_plane, w, h, cfa, fcs_strength);

    for (i, pixel) in out.pixels.iter_mut().enumerate() {
        let gains = site_gains.map_or([1.0; 3], |g| quad_channel_gains(g, i, w, h, cfa));
        for c in 0..3 {
            pixel[c] = pixel[c] / scales[c] * gains[c];
        }
        let sampled = cfa.color_at((i % w) as u32, (i / w) as u32) as usize;
        pixel[sampled] = mosaic.pixels[i][sampled];
    }
    out
}

/// Per-channel gain at pixel `i`: the mean gain of that channel's sites in
/// the 2×2 Bayer quad containing `i`. Gain maps are smooth, so the quad
/// stands in for the gain the reconstructed channel would have measured.
fn quad_channel_gains(gains: &[f32], i: usize, w: usize, h: usize, cfa: CfaPattern) -> [f32; 3] {
    let (x0, y0) = ((i % w) & !1, (i / w) & !1);
    let sites = [(0, 0), (1, 0), (0, 1), (1, 1)]
        .map(|(dx, dy)| ((x0 + dx).min(w - 1), (y0 + dy).min(h - 1)));
    std::array::from_fn(|c| {
        let (sum, count) = sites
            .iter()
            .filter(|(x, y)| cfa.color_at(*x as u32, *y as u32) as usize == c)
            .fold((0.0, 0u32), |(sum, count), (x, y)| {
                (sum + gains[y * w + x], count + 1)
            });
        if count > 0 {
            sum / count as f32
        } else {
            1.0
        }
    })
}
