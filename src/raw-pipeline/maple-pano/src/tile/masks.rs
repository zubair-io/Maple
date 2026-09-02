//! Voronoi ownership masks + overlap-width estimation for the tile
//! composite. Split from `tile/mod.rs` for the file-size budget (#3086).

use crate::error::PanoError;
use crate::ingest::PlanarImage;

use super::frame_cache::TileFrameCache;
use super::frame_window;
use super::placement::{TileCanvasSpec, TilePose};
use super::warp;
use super::TILE_PX;

/// Estimate minimum overlap width for pyramid level selection, using a
/// coarse canvas-space scan (stride 8) to find pairwise overlap pixels.
/// This is cheaper than a full voronoi pass and gives a good enough
/// estimate for `levels_for_overlap_width`.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `cache` and `poses[i].frame_idx`) — #3197: frames are
/// decoded on demand through `cache`, pinned once per spatial cell
/// (`frame_window`), never per sample point — see `sampling.rs` and
/// `frame_cache` module docs for why per-sample cache access is the bug
/// this exists to avoid.
pub(super) fn estimate_min_overlap_width(
    cache: &TileFrameCache,
    full_dims: &[(u32, u32)],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
) -> Result<usize, PanoError> {
    use warp::inverse_similarity_with_offset;

    let k = poses.len();
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let stride = 8usize;

    // Pre-compute inverse similarities.
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

    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows = vec![vec![std::collections::BTreeSet::<usize>::new(); k]; k];

    let cells = frame_window::spatial_cells(cw, ch, TILE_PX);
    let waves = frame_window::group_into_waves(
        &cells,
        &bboxes,
        |local| poses[local].frame_idx,
        cache.capacity(),
    );

    for wave in &waves {
        let pinned = frame_window::pin_wave(cache, wave)?;
        for &cell in &wave.cells {
            let first_ry = cell.y0.div_ceil(stride) * stride;
            let first_rx = cell.x0.div_ceil(stride) * stride;
            for ry in (first_ry..cell.y1).step_by(stride) {
                for rx in (first_rx..cell.x1).step_by(stride) {
                    let cx = rx as f64 + 0.5;
                    let cy = ry as f64 + 0.5;
                    // Which frames cover this canvas point? Use
                    // sample_bicubic to match the actual warp gate: a
                    // canvas pixel is only produced when the bicubic
                    // kernel has sufficient valid-pixel support (weight
                    // threshold 0.01). The simpler nearest-neighbour
                    // check overestimates overlap near validity
                    // boundaries.
                    let covered: Vec<bool> = (0..k)
                        .map(|i| {
                            let (fw, fh) = frame_dims[i];
                            let (fx, fy) = inv_sims[i].apply(cx, cy);
                            if fx < 0.0 || fx > fw || fy < 0.0 || fy > fh {
                                return false;
                            }
                            // Invariant: the wave that owns this cell was
                            // pinned with the union of every frame any of
                            // its cells' bboxes touch (see
                            // `frame_window::group_into_waves`), so this
                            // lookup should never miss. A debug build
                            // catches a broken invariant loudly instead of
                            // silently undercounting overlap and skewing
                            // pyramid level selection (Copilot review).
                            let Some(frame) = pinned.get(&poses[i].frame_idx) else {
                                debug_assert!(
                                    false,
                                    "frame {} missing from pinned wave set",
                                    poses[i].frame_idx
                                );
                                return false;
                            };
                            warp::sample_bicubic(frame, fx - 0.5, fy - 0.5).is_some()
                        })
                        .collect();
                    for a in 0..k {
                        if !covered[a] {
                            continue;
                        }
                        for b in (a + 1)..k {
                            if covered[b] {
                                overlap_count[a][b] += 1;
                                overlap_rows[a][b].insert(ry);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut min_w = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows == 0 {
                continue;
            }
            min_w = min_w.min(overlap_count[a][b] / rows);
        }
    }
    Ok(if min_w == usize::MAX { 0 } else { min_w })
}

/// Voronoi masks for a (possibly haloed) region.
///
/// Ownership score for a covered pixel = how deep its inverse projection
/// sits inside the owning **source frame** (min distance to that frame's
/// nearest edge, in source pixels) — the same semantics as the rotation
/// path's `voronoi_masks`, so seams land mid-overlap. Ties break to the
/// lower frame index (determinism). The pre-#3086 region variant scored
/// distance to the region rectangle instead, which is identical for every
/// layer at a pixel — every tie broke to the lowest index and seams sat
/// on frame validity borders, where parallax misalignment peaks.
///
/// `(rx0, ry0)` is the region's origin in canvas pixels; `poses` and
/// `frame_dims` are parallel to `layers`.
pub(super) fn voronoi_masks_region(
    layers: &[PlanarImage],
    poses: &[TilePose],
    frame_dims: &[(u32, u32)],
    canvas: &TileCanvasSpec,
    rx0: usize,
    ry0: usize,
) -> (Vec<Vec<f32>>, usize) {
    let Some(first) = layers.first() else {
        return (vec![], 0);
    };
    debug_assert_eq!(layers.len(), poses.len());
    debug_assert_eq!(layers.len(), frame_dims.len());
    let cw = first.width() as usize;
    let ch = first.height() as usize;
    let n = cw * ch;
    let k = layers.len();

    let depths: Vec<Vec<f32>> = layers
        .iter()
        .zip(poses)
        .zip(frame_dims)
        .map(|((layer, pose), &(fw, fh))| {
            let inv =
                warp::inverse_similarity_with_offset(&pose.sim, canvas.offset_x, canvas.offset_y);
            let (fw, fh) = (fw as f64, fh as f64);
            let mut d = vec![-1.0_f32; n];
            for py in 0..ch {
                for px in 0..cw {
                    if !layer.validity.get(px as u32, py as u32) {
                        continue;
                    }
                    let cx = (rx0 + px) as f64 + 0.5;
                    let cy = (ry0 + py) as f64 + 0.5;
                    let (sx, sy) = inv.apply(cx, cy);
                    let border = sx.min(fw - sx).min(sy).min(fh - sy);
                    d[py * cw + px] = border.max(0.0) as f32;
                }
            }
            d
        })
        .collect();

    let mut masks = vec![vec![0.0_f32; n]; k];
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    for i in 0..n {
        let mut best: Option<(usize, f32)> = None;
        for (f, depth) in depths.iter().enumerate() {
            let d = depth[i];
            if d < 0.0 {
                continue;
            }
            if best.is_none_or(|(_, bd)| d > bd) {
                best = Some((f, d));
            }
        }
        if let Some((f, _)) = best {
            masks[f][i] = 1.0;
        }
        for a in 0..k {
            if depths[a][i] < 0.0 {
                continue;
            }
            for b in (a + 1)..k {
                if depths[b][i] >= 0.0 {
                    overlap_count[a][b] += 1;
                    overlap_rows[a][b].insert(i / cw);
                }
            }
        }
    }

    let mut min_width = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows == 0 {
                continue;
            }
            min_width = min_width.min(overlap_count[a][b] / rows);
        }
    }
    if min_width == usize::MAX {
        min_width = 0;
    }
    (masks, min_width)
}
