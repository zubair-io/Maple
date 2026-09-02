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

/// One strided canvas scan accumulating per-pair (and per-pair-per-cell)
/// log-ratio statistics. Parallel over row bands; merged in band order
/// for determinism.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `cache` and `poses[i].frame_idx`) — #3090: frames are
/// decoded on demand through `cache`, bounded to a handful resident at
/// once, rather than requiring the whole set pre-decoded.
///
/// # Why a flat parallel pass is fine here (#3090)
///
/// An earlier version of this fix restricted parallelism to small
/// sequential groups of bands, reasoning that a flat `bands.par_iter()`
/// over the whole canvas would spread concurrently-active scan positions
/// across the entire canvas — each needing a different couple of frames,
/// for a combined working set that could exceed the cache capacity and
/// thrash. That reasoning targeted the wrong cost: `sample_band` below
/// resolves each relevant frame through `cache` **once per band**, not
/// once per pixel sample, so the number of cache accesses is already
/// tiny (bands × relevant-frames-per-band, not canvas-pixels ×
/// relevant-frames), and restricting parallelism on top of that only
/// threw away most of the machine's cores for no memory benefit —
/// measured as a large wall-clock regression on `pano_00` (too few
/// frames for the cache to ever evict anything, so the grouping bought
/// nothing there either). Left as a flat parallel pass; peak resident
/// frames is still bounded by `cache`'s capacity.
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

    let band_maps: Vec<PairMap> = bands
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
/// `sample_pairs` so `bands.par_iter()` there can call it directly.
///
/// Calls `cache.get()` fresh at point of use (inside the per-sample,
/// per-frame loop below), gated by the existing per-sample 2D bbox
/// check — not pre-resolved and held for the whole band. An earlier
/// version pre-fetched every frame whose bbox *Y-range* reached the
/// band and held an `Arc` for each for the band's whole duration, to
/// cut lock overhead; but a locally-held `Arc` keeps a frame's pixels
/// alive regardless of what the shared cache's own LRU does
/// internally, and for a typical strip pano (all frames sharing
/// similar vertical extent) that pre-fetch touched — and kept alive —
/// close to every frame per band, reintroducing the peak-RSS problem
/// this PR exists to eliminate (Copilot review on #3146). Calling
/// `cache.get()` per sample instead is a cheap hit (lock + short
/// linear scan + `Arc::clone`) after the decode-on-miss
/// lock-serialization fix elsewhere in this PR, and is *more*
/// selective than the Y-only pre-filter was (the 2D bbox check below
/// only calls it for a frame that actually covers this exact sample).
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
