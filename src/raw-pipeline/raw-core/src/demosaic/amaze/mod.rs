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
//!                  (619–682).
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

use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

use super::hamilton_adams::hamilton_adams;
use scratch::{Scratch, Tile, BAND, TS};

/// AMaZE demosaic. `mosaic` must be `CameraNativeMosaic` produced by
/// `sensor_linearize` (single channel populated per pixel, normalised to
/// `[0, 1]`). Output is `CameraNativeLinearRgb`.
pub fn amaze(mosaic: &Image, cfa: CfaPattern) -> Image {
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
    let cfa_flat = flatten_mosaic(mosaic, cfa);

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
                green::interpolate_green_diffs(&mut s, &t, cfa);
                green::refine_by_variance(&mut s, &t);
                green::median_bound(&mut s, &t, cfa);
                green::adaptive_hvwt(&mut s, &t, cfa);
                nyquist::reconstruct_green(&mut s, &t, cfa);
                diag::diagonal_refine(&mut s, &t, cfa);
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

    out
}

/// Flatten the sparse 3-channel mosaic to a single float per CFA position.
fn flatten_mosaic(mosaic: &Image, cfa: CfaPattern) -> Vec<f32> {
    let w = mosaic.width as usize;
    // Read whichever of [r, g, b] the CFA position says is populated; the
    // others are zero per the `sensor_linearize` contract.
    mosaic
        .pixels
        .par_iter()
        .enumerate()
        .map(|(i, p)| {
            let x = (i % w) as u32;
            let y = (i / w) as u32;
            p[cfa.color_at(x, y) as usize]
        })
        .collect()
}
