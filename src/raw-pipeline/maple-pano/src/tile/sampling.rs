//! The photometric sampling pass: one strided canvas scan that feeds
//! both correction layers (#350). Split from `photometry.rs` for the
//! file-size budget.
//!
//! Every canvas grid point is inverse-mapped into each frame that could
//! cover it (bbox-prefiltered), sampled with the same bicubic kernel the
//! warp uses, and every co-visible frame pair accumulates the log-ratio
//! of the two samples — globally, and per coarse field cell. Layer A
//! consumes the global sums, layer B the per-cell ones.

use rayon::prelude::*;

use crate::error::PanoError;
use crate::similarity::Similarity2d;

use super::frame_cache::TileFrameCache;
use super::photometry::{PairMap, PhotometryOptions, MIN_LUM};
use super::placement::{TileCanvasSpec, TilePose};
use super::warp::{inverse_similarity_with_offset, sample_bicubic};

/// Row-bands processed with bounded local parallelism per group; groups
/// run sequentially so the on-demand decode cache's working set stays
/// spatially local to a small slice of canvas rows (#3090). See
/// `sample_pairs` for why a single flat parallel pass over the whole
/// canvas would defeat a capacity-bounded cache.
const SAMPLING_GROUP_BANDS: usize = 4;

/// One strided canvas scan accumulating per-pair (and per-pair-per-cell)
/// log-ratio statistics. Parallel *within* small groups of row-bands;
/// groups run sequentially, and every group's results are merged in
/// original band order for determinism.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `cache` and `poses[i].frame_idx`) — #3090: frames are
/// decoded on demand through `cache`, bounded to a handful resident at
/// once, rather than requiring the whole set pre-decoded.
///
/// # Why groups, not one flat parallel pass (#3090)
///
/// `cache` bounds how many decoded frames stay resident at once. A flat
/// `bands.par_iter()` over every row-band in the canvas defeats that:
/// rayon's work-stealing scheduler hands each thread a large contiguous
/// SLICE of the bands array up front, so with `P` threads the `P`
/// concurrently-active scan positions end up spread roughly evenly
/// across the *entire* canvas rather than clustered together — each
/// needing a different couple of frames, for a combined working set
/// that can exceed the cache capacity and thrash (repeatedly evicting
/// and re-decoding the same frames; measured as a large wall-clock
/// regression on the 23-frame `pano_03` strip during development).
/// Chunking into `SAMPLING_GROUP_BANDS`-sized groups and running groups
/// sequentially keeps every concurrently-active band within one small,
/// contiguous slice of canvas rows, so the frames they need overlap
/// heavily — matching the "tile sweep moves monotonically along the
/// strip" assumption the cache capacity is sized against.
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

    let inv_sims: Vec<Similarity2d> = poses
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
    // Canvas-space bboxes for the cheap per-sample prefilter.
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

    let rows: Vec<usize> = (0..ch).step_by(opts.stride).collect();
    let bands: Vec<&[usize]> = rows.chunks(64).collect();

    let mut band_maps: Vec<PairMap> = Vec::with_capacity(bands.len());
    for group in bands.chunks(SAMPLING_GROUP_BANDS) {
        let group_maps: Vec<PairMap> = group
            .par_iter()
            .map(|band| {
                sample_band(
                    band,
                    cw,
                    k,
                    ncx,
                    opts,
                    &bboxes,
                    &frame_dims,
                    &inv_sims,
                    poses,
                    cache,
                )
            })
            .collect::<Result<Vec<PairMap>, PanoError>>()?;
        band_maps.extend(group_maps);
    }

    // Sequential band-order merge (deterministic float summation order).
    let mut merged = PairMap::new();
    for band in band_maps {
        for (key, acc) in band {
            let dst = merged.entry(key).or_default();
            dst.n += acc.n;
            dst.s_lnr_lum += acc.s_lnr_lum;
            dst.s_dxi += acc.s_dxi;
            dst.s_deta += acc.s_deta;
            for c in 0..3 {
                dst.s_lnr_ch[c] += acc.s_lnr_ch[c];
                dst.n_ch[c] += acc.n_ch[c];
            }
            for (cell, cacc) in acc.cells {
                let d = dst.cells.entry(cell).or_default();
                d.n += cacc.n;
                d.s_lnr += cacc.s_lnr;
                d.s_dxi += cacc.s_dxi;
                d.s_deta += cacc.s_deta;
            }
        }
    }
    Ok(merged)
}

/// Accumulate one row-band's per-pair log-ratio statistics. Split out of
/// `sample_pairs` so the group-chunked driver there can run it via
/// `par_iter()` *within* a small group of bands, rather than over the
/// whole canvas at once (#3090 — see `sample_pairs` docs).
#[allow(clippy::too_many_arguments)]
fn sample_band(
    band: &[usize],
    cw: usize,
    k: usize,
    ncx: usize,
    opts: &PhotometryOptions,
    bboxes: &[(f64, f64, f64, f64)],
    frame_dims: &[(f64, f64)],
    inv_sims: &[Similarity2d],
    poses: &[TilePose],
    cache: &TileFrameCache,
) -> Result<PairMap, PanoError> {
    let mut map = PairMap::new();
    let mut hits: Vec<(usize, f64, [f64; 3], f64, f64)> = Vec::with_capacity(k);
    for &ry in band.iter() {
        let cy = ry as f64 + 0.5;
        for rx in (0..cw).step_by(opts.stride) {
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
                let frame = cache.get(poses[i].frame_idx)?;
                let Some(v) = sample_bicubic(&frame, fx - 0.5, fy - 0.5) else {
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
            let cell = ((ry / opts.field_cell_px) * ncx + (rx / opts.field_cell_px)) as u32;
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
                    let cacc = acc.cells.entry(cell).or_default();
                    cacc.n += 1.0;
                    cacc.s_lnr += lnr;
                    cacc.s_dxi += xi_i - xi_j;
                    cacc.s_deta += eta_i - eta_j;
                }
            }
        }
    }
    Ok(map)
}
