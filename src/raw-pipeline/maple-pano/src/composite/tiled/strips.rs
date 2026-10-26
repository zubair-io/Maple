//! Strip-streamed multi-band blending for the tiled rotation compositors
//! (#4524).
//!
//! The canvas is still produced `tile_rows` output rows at a time, but each
//! strip is blended inside a taller *window*: the strip widened by
//! [`halo_rows`] on both sides and snapped to the coarsest pyramid level's
//! sample grid. Every frame touching the window is warped into it, its
//! Laplacian pyramid folded into a window-sized [`BandAccumulator`] and
//! dropped; the collapsed window then contributes only its strip rows. The
//! halo covers the pyramid's full vertical reach, so the strip rows are
//! bit-identical to a whole-canvas [`crate::blend::blend_multiband`] and the
//! output does not depend on `tile_rows`. Peak blend memory is one window's
//! accumulator plus one frame's pyramid over its own column band — never a
//! canvas-sized pyramid.
//!
//! [`survey`] runs before the blend because the band count is a property of
//! the whole canvas (`log2` of the narrowest pairwise overlap), so it must be
//! known before the first window is accumulated.

use std::collections::BTreeSet;

use rayon::prelude::*;

use crate::blend::BandAccumulator;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::composite::{CanvasSink, OwnerRuns};
use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;

use super::{assign_owners, min_overlap_width, tile_depths};

/// Rows of context a strip needs on each side so its pixels match a
/// whole-canvas blend exactly. The measured reach of the `levels`-band
/// pyramid (taps + bilinear expands + collapse) is just under `1.5 · 2^levels`
/// rows; `2 · 2^levels` leaves margin.
pub(super) fn halo_rows(levels: usize) -> usize {
    if levels <= 1 {
        0
    } else {
        2 << levels
    }
}

/// Canvas-wide geometry the blend needs before it starts: the band-count
/// input and, per frame, the canvas rows its footprint spans.
pub(super) struct Survey {
    /// Voronoi owner per canvas pixel; kept only when the caller weights by
    /// hard ownership.
    pub(super) owner: Option<OwnerRuns>,
    pub(super) footprint_rows: Vec<Option<(u32, u32)>>,
    pub(super) min_overlap_px: usize,
}

impl Survey {
    pub(super) fn footprint_touches(&self, fi: usize, y0: u32, y1: u32) -> bool {
        self.footprint_rows[fi].is_some_and(|(a, b)| a < y1 && y0 < b)
    }
}

/// Rows per survey pass. Everything the survey records is per pixel or per
/// row, so the pass height changes only its transient memory: `k` depth
/// planes of this many canvas rows (#5452).
const SURVEY_ROWS: u32 = 64;

pub(super) fn survey(
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    keep_owner: bool,
) -> Survey {
    let k = cameras.len();
    let cw = canvas.width as usize;
    let tile_rows = SURVEY_ROWS.min(canvas.height).max(1);
    let mut owner = keep_owner.then(|| OwnerRuns::new(canvas.width));
    let mut footprint_rows: Vec<Option<(u32, u32)>> = vec![None; k];
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<BTreeSet<usize>>> = vec![vec![BTreeSet::new(); k]; k];

    for tile_y0 in (0..canvas.height).step_by(tile_rows as usize) {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let tile_n = cw * (tile_y1 - tile_y0) as usize;
        let depths = tile_depths(cameras, local_corrections, canvas, tile_y0, tile_y1);
        let strip_owner = assign_owners(
            &depths,
            tile_y0,
            cw,
            tile_n,
            k,
            &mut overlap_count,
            &mut overlap_rows,
        );
        for (span, depth) in footprint_rows.iter_mut().zip(&depths) {
            let covered_rows = depth
                .chunks_exact(cw)
                .enumerate()
                .filter(|(_, row)| row.iter().any(|&d| d >= 0.0))
                .map(|(y, _)| tile_y0 + y as u32);
            for y in covered_rows {
                let (a, b) = span.unwrap_or((y, y + 1));
                *span = Some((a.min(y), b.max(y + 1)));
            }
        }
        if let Some(owner) = owner.as_mut() {
            strip_owner
                .chunks_exact(cw)
                .for_each(|row| owner.push_row(row));
        }
    }

    Survey {
        owner,
        footprint_rows,
        min_overlap_px: min_overlap_width(k, &overlap_count, &overlap_rows),
    }
}

/// Blend the whole canvas strip by strip, handing each finished strip to
/// `sink` as soon as it is collapsed (#5452).
///
/// - `touches(fi, y0, y1)`: may frame `fi` carry weight in canvas rows
///   `y0..y1`? `false` skips its decode for that window.
/// - `weight(fi, x, y)`: seam weight of frame `fi` at canvas pixel `(x, y)`.
/// - `warp_strip(fi, y0, y1)`: the frame warped into canvas rows `y0..y1`.
#[allow(clippy::too_many_arguments)]
pub(super) fn blend_strips(
    (width, height): (u32, u32),
    frame_count: usize,
    tile_rows: u32,
    levels: usize,
    touches: impl Fn(usize, u32, u32) -> bool,
    weight: impl Fn(usize, usize, usize) -> f32 + Sync,
    mut warp_strip: impl FnMut(usize, u32, u32) -> Result<PlanarImage, PanoError>,
    sink: &mut dyn CanvasSink,
) -> Result<(), PanoError> {
    let (cw, ch) = (width as usize, height as usize);
    let tile_rows = tile_rows.max(1).min(height) as usize;
    let halo = halo_rows(levels);
    let grid = 1usize << (levels.max(1) - 1);
    sink.begin(width, height)?;

    for ty0 in (0..ch).step_by(tile_rows) {
        let ty1 = (ty0 + tile_rows).min(ch);
        let wy0 = ty0.saturating_sub(halo) / grid * grid;
        let wy1 = (ty1 + halo).min(ch);
        let interior = (ty0 - wy0) * cw..(ty1 - wy0) * cw;
        let mut acc = BandAccumulator::new(cw, wy1 - wy0, levels);
        let mut covered = vec![false; (ty1 - ty0) * cw];

        for fi in 0..frame_count {
            if !touches(fi, wy0 as u32, wy1 as u32) {
                continue;
            }
            let strip = warp_strip(fi, wy0 as u32, wy1 as u32)?;
            let wt = window_weights(&strip, cw, wy0, |x, y| weight(fi, x, y));
            let Some((bx0, bx1)) = weighted_columns(&wt, cw) else {
                continue;
            };
            for (c, &w) in covered.iter_mut().zip(&wt[interior.clone()]) {
                *c |= w > 0.0;
            }
            // A frame's pyramid only reaches `halo` past its weighted
            // columns, and the band's own clipped edge corrupts at most
            // `halo` inward — two halos keep the two apart.
            let band = (bx0.saturating_sub(2 * halo) / grid * grid)..(bx1 + 2 * halo).min(cw);
            acc.add(&strip, &wt, band);
        }

        let [r, g, b] = acc.collapse().map(|plane| {
            plane[interior.clone()]
                .iter()
                .zip(&covered)
                .map(|(&v, &c)| if c { v } else { 0.0 })
                .collect::<Vec<_>>()
        });
        let rows = (ty1 - ty0) as u32;
        let mut validity = ValidityMask::new_filled(width, rows, false);
        for (i, _) in covered.iter().enumerate().filter(|(_, &c)| c) {
            validity.set((i % cw) as u32, (i / cw) as u32, true);
        }
        sink.rows(&PlanarImage::from_planes(width, rows, r, g, b, validity))?;
    }
    Ok(())
}

/// Seam weight × validity over one warped window, row-major.
fn window_weights(
    strip: &PlanarImage,
    cw: usize,
    wy0: usize,
    weight: impl Fn(usize, usize) -> f32 + Sync,
) -> Vec<f32> {
    let mut wt = vec![0.0_f32; strip.r.len()];
    wt.par_chunks_mut(cw).enumerate().for_each(|(y, row)| {
        for (x, slot) in row.iter_mut().enumerate() {
            if strip.validity.get(x as u32, y as u32) {
                *slot = weight(x, wy0 + y).max(0.0);
            }
        }
    });
    wt
}

/// Column extent `[x0, x1)` holding any positive weight, or `None`.
fn weighted_columns(wt: &[f32], cw: usize) -> Option<(usize, usize)> {
    wt.chunks_exact(cw)
        .filter_map(|row| {
            let first = row.iter().position(|&w| w > 0.0)?;
            let last = row.iter().rposition(|&w| w > 0.0)?;
            Some((first, last + 1))
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::blend_multiband;
    use crate::composite::CanvasCollector;
    use crate::prng::SplitMix64;

    const W: usize = 400;
    const H: usize = 300;

    /// Three frames with ragged, partly overlapping column footprints in a
    /// canvas wide enough that low band counts crop each frame's pyramid to
    /// its own column band.
    fn scene() -> (Vec<PlanarImage>, Vec<Vec<f32>>) {
        let mut rng = SplitMix64::new(4524);
        [(0usize, 150usize), (120, 280), (250, 400)]
            .into_iter()
            .map(|(x0, x1)| {
                let mut validity = ValidityMask::new_filled(W as u32, H as u32, false);
                let mut planes = [vec![0.0_f32; W * H], vec![0.0; W * H], vec![0.0; W * H]];
                let mut weight = vec![0.0_f32; W * H];
                for y in 0..H {
                    let lo = x0 + (y * 7) % 11;
                    let hi = x1.saturating_sub((y * 5) % 13).max(lo + 1);
                    for x in lo..hi {
                        let i = y * W + x;
                        validity.set(x as u32, y as u32, true);
                        let v = rng.next_range(0.0, 4.0) as f32;
                        planes[0][i] = v;
                        planes[1][i] = 0.5 * v;
                        planes[2][i] = 0.25 * v + 0.01;
                        weight[i] = if (x - lo) < (hi - lo) / 2 { 1.0 } else { 0.5 };
                    }
                }
                let [r, g, b] = planes;
                (
                    PlanarImage::from_planes(W as u32, H as u32, r, g, b, validity),
                    weight,
                )
            })
            .unzip()
    }

    fn rows(layer: &PlanarImage, y0: u32, y1: u32) -> PlanarImage {
        let (a, b) = (y0 as usize * W, y1 as usize * W);
        let mut validity = ValidityMask::new_filled(W as u32, y1 - y0, false);
        for y in y0..y1 {
            for x in 0..W as u32 {
                validity.set(x, y - y0, layer.validity.get(x, y));
            }
        }
        PlanarImage::from_planes(
            W as u32,
            y1 - y0,
            layer.r[a..b].to_vec(),
            layer.g[a..b].to_vec(),
            layer.b[a..b].to_vec(),
            validity,
        )
    }

    #[test]
    fn strips_reproduce_whole_canvas_blend_at_any_height() {
        let (layers, weights) = scene();
        for levels in [1, 3, 5, 7] {
            let whole = blend_multiband(&layers, &weights, levels);
            for tile_rows in [23, 96] {
                let mut collector = CanvasCollector::default();
                blend_strips(
                    (W as u32, H as u32),
                    layers.len(),
                    tile_rows,
                    levels,
                    |_, _, _| true,
                    |fi, x, y| weights[fi][y * W + x],
                    |fi, y0, y1| Ok(rows(&layers[fi], y0, y1)),
                    &mut collector,
                )
                .expect("blend");
                let strips = collector.into_image();
                let ctx = format!("levels={levels} tile_rows={tile_rows}");
                for i in 0..W * H {
                    let (x, y) = ((i % W) as u32, (i / W) as u32);
                    assert_eq!(strips.validity.get(x, y), whole.validity.get(x, y), "{ctx}");
                    assert_eq!(strips.r[i], whole.r[i], "{ctx} r at ({x},{y})");
                    assert_eq!(strips.g[i], whole.g[i], "{ctx} g at ({x},{y})");
                    assert_eq!(strips.b[i], whole.b[i], "{ctx} b at ({x},{y})");
                }
            }
        }
    }
}
