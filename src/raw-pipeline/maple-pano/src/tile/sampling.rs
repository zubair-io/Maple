//! The photometric sampling pass: one strided canvas scan that feeds
//! both correction layers (#350). Split from `photometry.rs` for the
//! file-size budget.
//!
//! Every canvas grid point is inverse-mapped into each frame that could
//! cover it (bbox-prefiltered), sampled with the same bicubic kernel the
//! warp uses, and every co-visible frame pair accumulates the log-ratio
//! of the two samples — globally, and per coarse field cell. Layer A
//! consumes the global sums, layer B the per-cell ones.
//!
//! ## Frame access (#3197)
//!
//! Frames are decoded on demand through [`super::frame_cache::TileFrameCache`],
//! bounded to a handful resident at once — not the whole input set. The
//! canvas is split into [`super::TILE_PX`]-sided spatial
//! cells, grouped into capacity-bounded "waves" (`frame_window`): each
//! wave pins its cells' frame set ONCE (not per sample point — the
//! earlier #3146 attempt did that and thrashed the cache, see
//! `frame_cache` module docs), processes those cells in parallel against
//! the pinned set, then moves to the next wave. Waves themselves run
//! strictly one after another.

use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::PanoError;
use crate::ingest::PlanarImage;

use super::frame_cache::TileFrameCache;
use super::frame_window::{self, Cell};
use super::photometry::{PairMap, PhotometryOptions, MIN_LUM};
use super::placement::{TileCanvasSpec, TilePose};
use super::warp::{inverse_similarity_with_offset, sample_bicubic};
use super::TILE_PX;

/// One strided canvas scan accumulating per-pair (and per-pair-per-cell)
/// log-ratio statistics.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `cache` and `poses[i].frame_idx`).
pub(super) fn sample_pairs(
    cache: &TileFrameCache,
    full_dims: &[(u32, u32)],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &PhotometryOptions,
) -> Result<PairMap, PanoError> {
    let k = poses.len();
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let ncx = cw.div_ceil(opts.field_cell_px);

    let inv_sims: Vec<_> = poses
        .iter()
        .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
        .collect();
    let frame_dims: Vec<(f64, f64)> = poses
        .iter()
        .map(|p| {
            let (w, h) = full_dims[p.frame_idx];
            (w as f64, h as f64)
        })
        .collect();
    // Canvas-space bboxes for the cheap per-sample prefilter AND for
    // deciding which frames each spatial cell/wave needs (#3197).
    let bboxes: Vec<(f64, f64, f64, f64)> = poses
        .iter()
        .zip(&frame_dims)
        .map(|(pose, &(fw, fh))| {
            [(0.0, 0.0), (fw, 0.0), (0.0, fh), (fw, fh)]
                .iter()
                .map(|&(x, y)| pose.sim.apply(x, y))
                .map(|(x, y)| (x + canvas.offset_x, y + canvas.offset_y))
                .fold(
                    (
                        f64::INFINITY,
                        f64::INFINITY,
                        f64::NEG_INFINITY,
                        f64::NEG_INFINITY,
                    ),
                    |(x0, y0, x1, y1), (x, y)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                )
        })
        .collect();

    let cells = frame_window::spatial_cells(cw, ch, TILE_PX);
    let waves = frame_window::group_into_waves(
        &cells,
        &bboxes,
        |local| poses[local].frame_idx,
        cache.capacity(),
    );

    // Waves run strictly sequentially (bounded residency); a wave's own
    // cells run in parallel once its frames are pinned. Merged in
    // canonical cell order (waves are consecutive slices of that order)
    // for deterministic float summation.
    let mut merged = PairMap::new();
    for wave in &waves {
        let pinned = frame_window::pin_wave(cache, wave)?;
        let cell_maps: Vec<PairMap> = wave
            .cells
            .par_iter()
            .map(|&cell| {
                sample_cell(
                    cell,
                    cw,
                    k,
                    ncx,
                    opts,
                    &bboxes,
                    &frame_dims,
                    &inv_sims,
                    poses,
                    &pinned,
                )
            })
            .collect();
        for map in cell_maps {
            merge_into(&mut merged, map);
        }
    }
    Ok(merged)
}

/// Accumulate one spatial cell's per-pair log-ratio statistics against an
/// already-pinned frame set (no cache access here — see module docs).
#[allow(clippy::too_many_arguments)]
fn sample_cell(
    cell: Cell,
    _cw: usize,
    k: usize,
    ncx: usize,
    opts: &PhotometryOptions,
    bboxes: &[(f64, f64, f64, f64)],
    frame_dims: &[(f64, f64)],
    inv_sims: &[crate::similarity::Similarity2d],
    poses: &[TilePose],
    pinned: &HashMap<usize, Arc<PlanarImage>>,
) -> PairMap {
    let mut map = PairMap::new();
    let mut hits: Vec<(usize, f64, [f64; 3], f64, f64)> = Vec::with_capacity(k);
    let stride = opts.stride;
    let first_ry = cell.y0.div_ceil(stride) * stride;
    let first_rx = cell.x0.div_ceil(stride) * stride;

    for ry in (first_ry..cell.y1).step_by(stride) {
        let cy = ry as f64 + 0.5;
        for rx in (first_rx..cell.x1).step_by(stride) {
            let cx = rx as f64 + 0.5;
            hits.clear();
            for i in 0..k {
                let (bx0, by0, bx1, by1) = bboxes[i];
                if cx < bx0 || cx > bx1 || cy < by0 || cy > by1 {
                    continue;
                }
                let (fw, fh) = frame_dims[i];
                let (fx, fy) = inv_sims[i].apply(cx, cy);
                if fx < 0.0 || fx > fw || fy < 0.0 || fy > fh {
                    continue;
                }
                // Invariant: the wave that owns this cell was pinned with
                // the union of every frame any of its cells' bboxes touch
                // (see `frame_window::group_into_waves`), so
                // `poses[i].frame_idx` is always present here. A debug
                // build catches a broken invariant loudly instead of
                // silently dropping samples and skewing the photometric
                // solve (Copilot review).
                let Some(frame) = pinned.get(&poses[i].frame_idx) else {
                    debug_assert!(
                        false,
                        "frame {} missing from pinned wave set",
                        poses[i].frame_idx
                    );
                    continue;
                };
                let Some(v) = sample_bicubic(frame, fx - 0.5, fy - 0.5) else {
                    continue;
                };
                let rgb = [
                    (v[0].max(0.0)) as f64,
                    (v[1].max(0.0)) as f64,
                    (v[2].max(0.0)) as f64,
                ];
                let lum = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
                if lum < MIN_LUM {
                    continue;
                }
                hits.push((i, lum, rgb, fx / fw - 0.5, fy / fh - 0.5));
            }
            if hits.len() < 2 {
                continue;
            }
            let cell_lin = ((ry / opts.field_cell_px) * ncx + (rx / opts.field_cell_px)) as u32;
            for a in 0..hits.len() {
                for b in (a + 1)..hits.len() {
                    let (i, lum_i, ch_i, xi_i, eta_i) = hits[a];
                    let (j, lum_j, ch_j, xi_j, eta_j) = hits[b];
                    let acc = map.entry((i, j)).or_default();
                    let lnr = (lum_i).ln() - (lum_j).ln();
                    acc.n += 1.0;
                    acc.s_lnr_lum += lnr;
                    acc.s_dxi += xi_i - xi_j;
                    acc.s_deta += eta_i - eta_j;
                    for c in 0..3 {
                        if ch_i[c] > MIN_LUM && ch_j[c] > MIN_LUM {
                            acc.s_lnr_ch[c] += ch_i[c].ln() - ch_j[c].ln();
                            acc.n_ch[c] += 1.0;
                        }
                    }
                    let cacc = acc.cells.entry(cell_lin).or_default();
                    cacc.n += 1.0;
                    cacc.s_lnr += lnr;
                    cacc.s_dxi += xi_i - xi_j;
                    cacc.s_deta += eta_i - eta_j;
                }
            }
        }
    }
    map
}

/// Fold `src` into `dst`, field by field (deterministic — see module
/// docs on merge order).
fn merge_into(dst: &mut PairMap, src: PairMap) {
    for (key, acc) in src {
        let d = dst.entry(key).or_default();
        d.n += acc.n;
        d.s_lnr_lum += acc.s_lnr_lum;
        d.s_dxi += acc.s_dxi;
        d.s_deta += acc.s_deta;
        for c in 0..3 {
            d.s_lnr_ch[c] += acc.s_lnr_ch[c];
            d.n_ch[c] += acc.n_ch[c];
        }
        for (cell, cacc) in acc.cells {
            let dc = d.cells.entry(cell).or_default();
            dc.n += cacc.n;
            dc.s_lnr += cacc.s_lnr;
            dc.s_dxi += cacc.s_dxi;
            dc.s_deta += cacc.s_deta;
        }
    }
}
