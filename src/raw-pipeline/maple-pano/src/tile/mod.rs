//! Tile strategy: planar canvas compositing for translation/similarity
//! mosaics (spec §8, ticket #1226).
//!
//! When the match graph's edges are best explained by 2D similarity
//! transforms (translation + small rotation/scale) rather than camera
//! rotations — nadir mapping strips, film-scan series, flatbed tiles —
//! this module replaces the rotation BA with a **per-frame 2D similarity
//! placement** on a planar (rectilinear) canvas. The downstream gain,
//! Voronoi seam, and multi-band blend stages are geometry-agnostic and
//! reuse unchanged once each frame is warped to canvas with a validity
//! mask.
//!
//! # Placement algorithm
//!
//! 1. **Per-edge similarity estimate.** For each verified edge in the
//!    match graph, [`crate::similarity::estimate_similarity`] fits a 2D
//!    similarity from the inlier correspondences (already computed in
//!    proxy coordinates). The estimate is refined using the full-res
//!    inlier matches that graph reverification places on the edges. Since
//!    the tile strategy operates purely in pixel space (not bearing space),
//!    `sigma_max_px` in pixel units is the relevant noise model — no
//!    angular conversion needed.
//!
//! 2. **Global anchored least squares.** The per-edge similarities give
//!    pairwise offsets; [`solve_tile_poses`] converts these into absolute
//!    canvas-space similarity poses for every frame. Frame 0 is the anchor
//!    (identity transform on the canvas). All other frames are placed by
//!    minimizing the sum of squared pair-pose consistency errors over the
//!    graph edges — the analogue of the rotation-model BA but for 2D
//!    similarities.
//!
//!    For the strip case (nadir with pure translation, θ ≈ 0, s ≈ 1) the
//!    solve reduces to two independent 1-D weighted least squares problems
//!    (x and y offsets), which is exact. The general solve handles scale
//!    and rotation using log-domain decoupling: `ln(s)` and `θ` are linear
//!    in the pose graph, so the full 4-DOF problem separates into
//!    independent 1-D (or 2-D for tx/ty) linear systems.
//!
//! 3. **Canvas sizing.** The bounding box of all placed frame corners
//!    determines the canvas size (with a small margin). Each frame's
//!    absolute pose is a similarity from frame pixels to canvas pixels.
//!
//! 4. **Warp.** [`warp_to_tile_canvas`] warps each source frame to the
//!    canvas using bicubic Catmull-Rom with validity masking — identical
//!    to `warp.rs` but with a 2D affine inverse map instead of the
//!    rotation → projection → distortion chain.
//!
//! 5. **Gain / seam / blend.** The existing [`crate::composite`] gain,
//!    Voronoi seam, and multi-band blend stages reuse without modification:
//!    they operate on validity-masked [`crate::ingest::PlanarImage`]
//!    buffers, which `warp_to_tile_canvas` produces.
//!
//! # Pano report fields
//!
//! The tile strategy does not produce reprojection errors in the rotation
//! sense, nor leveling, nor wrap closure — those report keys are absent
//! (not zeroed). Instead the report carries `tile_placement` with
//! per-frame `{tx_px, ty_px, scale, theta_rad}` and the mean/max
//! *planar* residual over verified inlier pairs.

pub mod placement;
pub mod warp;

mod gain_solve;

pub use placement::{
    solve_tile_poses, TileCanvasSpec, TilePlacement, TilePlacementError, TilePose,
};
pub use warp::warp_to_tile_canvas;

use crate::blend::{blend_multiband, levels_for_overlap_width, MAX_LEVELS};
use crate::error::PanoError;
use crate::gain::GainOptions;
use crate::graph::MatchGraph;
use crate::ingest::PlanarImage;
use crate::similarity::{estimate_similarity, SimilarityEstimate, SimilarityOptions};
use crate::twoview::PixelCorrespondence;

use gain_solve::solve_gains_canvas_space;
use warp::warp_to_tile_region;

/// Spatial tile size (canvas pixels per side) used in the tiled multiband
/// composite. Must be a power of two; larger values use more memory but
/// fewer tiles.
const TILE_PX: usize = 1024;

/// Compute the halo width (pixels) that covers the full influence radius of
/// a `levels`-deep pyramid using the `[1,4,6,4,1]` binomial kernel (radius
/// 2 per level-downsample). The influence radius at full resolution is
/// `2 * (2^levels - 1)`. We round up to the next power of two for alignment,
/// then add a safety factor of 2 to ensure boundary accuracy.
fn halo_for_levels(levels: usize) -> usize {
    let influence = 2 * ((1usize << levels).saturating_sub(1));
    let next_pow2 = influence.next_power_of_two().max(16);
    // Safety factor ×2 so boundary rows are well inside the valid halo zone.
    next_pow2 * 2
}

/// Per-edge similarity estimate — the payload the tile pipeline carries
/// forward (analogous to [`crate::graph::VerifiedEdge::rotation`]).
#[derive(Debug, Clone)]
pub struct TileEdge {
    pub a: usize,
    pub b: usize,
    pub estimate: SimilarityEstimate,
    /// Inlier matches (index-filtered from the graph edge).
    pub inlier_matches: Vec<PixelCorrespondence>,
}

/// Verify every edge in `graph` with the similarity model.
///
/// Uses the graph's existing inlier matches (from rotation verification
/// and full-res refinement) as the correspondence pool. A pair that
/// passes the rotation verifier typically has rich overlap even if the
/// rotation model badly fits it — the similarity verifier just fits a
/// different model to the same matches.
///
/// `seed`: base PRNG seed for the RANSAC (mixed with pair index for
/// independence, mirroring `graph.rs`'s `pair_seed`).
pub fn verify_tile_edges(graph: &MatchGraph, seed: u64, opts: &SimilarityOptions) -> Vec<TileEdge> {
    use crate::prng::SplitMix64;

    graph
        .edges
        .iter()
        .filter_map(|edge| {
            let pair_seed =
                SplitMix64::new(seed ^ ((edge.a as u64) << 32) ^ edge.b as u64).next_u64();
            let mut rng = SplitMix64::new(pair_seed);
            match estimate_similarity(&edge.inlier_matches, opts, &mut rng) {
                Ok(est) => {
                    let inlier_matches: Vec<PixelCorrespondence> = edge
                        .inlier_matches
                        .iter()
                        .zip(&est.inlier_mask)
                        .filter(|(_, &keep)| keep)
                        .map(|(&m, _)| m)
                        .collect();
                    Some(TileEdge {
                        a: edge.a,
                        b: edge.b,
                        estimate: est,
                        inlier_matches,
                    })
                }
                Err(_) => None,
            }
        })
        .collect()
}

/// Report from the tile composite pass.
#[derive(Debug, Clone)]
pub struct TileCompositeReport {
    pub canvas: TileCanvasSpec,
    pub placements: Vec<TilePose>,
    pub gains: Vec<[f32; 3]>,
    pub blend_levels: usize,
    pub min_overlap_width_px: usize,
    /// Mean planar residual over all verified inlier pairs (px).
    pub mean_planar_residual_px: f64,
    /// Max planar residual over verified inlier pairs (px).
    pub max_planar_residual_px: f64,
    /// Halo width used in the tiled multiband blend (px).
    pub halo_px: usize,
}

/// End-to-end tile composite with spatial tiling + multiband blend.
///
/// This is the memory-bounded replacement for the old full-canvas
/// `composite_tile` (#1291). Instead of warping all K frames to the
/// full canvas and running multiband over the full-canvas pyramids,
/// the canvas is processed as a grid of `TILE_PX × TILE_PX` spatial
/// tiles, each expanded by a `halo` wide enough to cover the pyramid's
/// influence radius. Peak memory scales with `(TILE + 2·HALO)² × K ×
/// pyramid_depth`, not with canvas area.
///
/// ## Algorithm
///
/// 1. **Gains (memory-light, once):** solved via canvas-space inverse-
///    similarity sampling — no full-canvas warp needed.
/// 2. **Pyramid level count:** determined from minimum overlap width,
///    same as the former code.
/// 3. **Halo width:** `halo_for_levels(levels)` — covers the binomial
///    kernel influence radius at full resolution, rounded up to the next
///    power of two with a ×2 safety factor.
/// 4. **Per output tile** `[tx0, ty0)–(tx1, ty1)`: expand by halo on
///    each side (clamped to canvas). Warp each frame into the haloed
///    region only (`warp_to_tile_region`). Compute Voronoi masks for
///    the haloed region. Run `blend_multiband` on the haloed layers +
///    masks + gains. Copy only the interior (drop halo border) into the
///    output canvas. Drop tile buffers before the next tile.
///
/// ## Output
///
/// The result is **not** byte-identical to the old full-canvas path:
/// seam transitions at tile boundaries are computed with different
/// pyramid context. Interiors of tiles are identical; boundaries are
/// approximate. Visible seams are prevented by the halo being large
/// enough that the seam blending zone is always fully within a single
/// tile's interior relative to any adjacent tile.
///
/// # Frame / pose alignment contract
///
/// Same contract as the former `composite_tile`:
/// `frames` must be the filtered frame list (same order as `poses`),
/// `tile_edges` filtered to the reachable component.
pub fn composite_tile(
    frames: &[PlanarImage],
    _frame_count: usize,
    tile_edges: &[TileEdge],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    gain_opts: &GainOptions,
    levels_override: Option<usize>,
) -> Result<(PlanarImage, TileCompositeReport), PanoError> {
    if frames.len() != poses.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tile: {} frames vs {} poses",
            frames.len(),
            poses.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tile: no frames".into(),
        ));
    }

    // ── planar residuals ─────────────────────────────────────────────────────
    let max_frame_idx = poses.iter().map(|p| p.frame_idx).max().unwrap_or(0);
    let mut frame_to_local = vec![usize::MAX; max_frame_idx + 1];
    for (li, pose) in poses.iter().enumerate() {
        frame_to_local[pose.frame_idx] = li;
    }
    let mut residual_sum = 0.0_f64;
    let mut residual_max = 0.0_f64;
    let mut residual_count = 0usize;
    for edge in tile_edges {
        let la = frame_to_local.get(edge.a).copied().unwrap_or(usize::MAX);
        let lb = frame_to_local.get(edge.b).copied().unwrap_or(usize::MAX);
        if la == usize::MAX || lb == usize::MAX {
            continue;
        }
        let pa = &poses[la];
        let pb = &poses[lb];
        for m in &edge.inlier_matches {
            let (cax, cay) = pa.sim.apply(m.a.0, m.a.1);
            let (cbx, cby) = pb.sim.apply(m.b.0, m.b.1);
            let res = ((cax - cbx).powi(2) + (cay - cby).powi(2)).sqrt();
            residual_sum += res;
            if res > residual_max {
                residual_max = res;
            }
            residual_count += 1;
        }
    }
    let mean_planar = if residual_count > 0 {
        residual_sum / residual_count as f64
    } else {
        0.0
    };

    // ── gain solve (no full-canvas warps) ────────────────────────────────────
    let gains = solve_gains_canvas_space(frames, poses, canvas, gain_opts)?;

    // ── determine pyramid level count ────────────────────────────────────────
    // We need the min overlap width for level selection. Compute cheaply via
    // a canvas-space scan at a coarse stride (same approach as voronoi_masks_tile
    // but just for overlap width stats, no actual masking needed here).
    let min_overlap = estimate_min_overlap_width(frames, poses, canvas);
    let levels = levels_override
        .unwrap_or_else(|| levels_for_overlap_width(min_overlap))
        .clamp(1, MAX_LEVELS);
    let halo = halo_for_levels(levels);

    // ── canvas output buffers ────────────────────────────────────────────────
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let n = cw * ch;
    let mut out_r = vec![0.0_f32; n];
    let mut out_g = vec![0.0_f32; n];
    let mut out_b = vec![0.0_f32; n];
    let mut out_valid = vec![false; n];

    // ── spatial tile loop ────────────────────────────────────────────────────
    let mut ty0 = 0usize;
    while ty0 < ch {
        let ty1 = (ty0 + TILE_PX).min(ch);
        let mut tx0 = 0usize;
        while tx0 < cw {
            let tx1 = (tx0 + TILE_PX).min(cw);

            // Expand by halo on each side (clamp to canvas).
            let hx0 = tx0.saturating_sub(halo);
            let hy0 = ty0.saturating_sub(halo);
            let hx1 = (tx1 + halo).min(cw);
            let hy1 = (ty1 + halo).min(ch);

            // Warp each frame into the haloed region only.
            let haloed_layers: Vec<PlanarImage> = frames
                .iter()
                .zip(poses)
                .zip(&gains)
                .map(|((f, pose), &g)| warp_to_tile_region(f, pose, canvas, g, hx0, hy0, hx1, hy1))
                .collect();

            // Skip tile if no frame covers any pixel in the haloed region.
            let any_valid = haloed_layers.iter().any(|l| l.validity.count_valid() > 0);
            if !any_valid {
                tx0 = tx1;
                continue;
            }

            // Voronoi masks over the haloed region.
            let (masks, _) = voronoi_masks_region(&haloed_layers);

            // Multiband blend of haloed region.
            let blended = blend_multiband(&haloed_layers, &masks, levels);

            // Copy only the interior (drop halo border) into the output.
            // Interior in haloed-region coordinates:
            let ix0 = tx0 - hx0; // left interior offset inside blended
            let iy0 = ty0 - hy0; // top interior offset inside blended
            let bw = blended.width() as usize; // = hx1 - hx0

            for oy in ty0..ty1 {
                let by = iy0 + (oy - ty0);
                for ox in tx0..tx1 {
                    let bx = ix0 + (ox - tx0);
                    if !blended.validity.get(bx as u32, by as u32) {
                        continue;
                    }
                    let bi = by * bw + bx;
                    let oi = oy * cw + ox;
                    out_r[oi] = blended.r[bi];
                    out_g[oi] = blended.g[bi];
                    out_b[oi] = blended.b[bi];
                    out_valid[oi] = true;
                }
            }

            // haloed_layers, masks, blended drop here — freeing memory before
            // the next tile iteration.
            tx0 = tx1;
        }
        ty0 = ty1;
    }

    // Build output validity mask.
    let mut validity = crate::ingest::ValidityMask::new_filled(canvas.width, canvas.height, false);
    for (i, &v) in out_valid.iter().enumerate() {
        if v {
            validity.set((i % cw) as u32, (i / cw) as u32, true);
        }
    }
    let output =
        PlanarImage::from_planes(canvas.width, canvas.height, out_r, out_g, out_b, validity);

    Ok((
        output,
        TileCompositeReport {
            canvas: canvas.clone(),
            placements: poses.to_vec(),
            gains,
            blend_levels: levels,
            min_overlap_width_px: min_overlap,
            mean_planar_residual_px: mean_planar,
            max_planar_residual_px: residual_max,
            halo_px: halo,
        },
    ))
}

/// Estimate minimum overlap width for pyramid level selection, using a
/// coarse canvas-space scan (stride 8) to find pairwise overlap pixels.
/// This is cheaper than a full voronoi pass and gives a good enough
/// estimate for `levels_for_overlap_width`.
fn estimate_min_overlap_width(
    frames: &[PlanarImage],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
) -> usize {
    use warp::inverse_similarity_with_offset;

    let k = frames.len();
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let stride = 8usize;

    // Pre-compute inverse similarities.
    let inv_sims: Vec<_> = poses
        .iter()
        .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
        .collect();
    let frame_dims: Vec<(f64, f64)> = frames
        .iter()
        .map(|f| (f.width() as f64, f.height() as f64))
        .collect();

    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows = vec![vec![std::collections::BTreeSet::<usize>::new(); k]; k];

    for ry in (0..ch).step_by(stride) {
        for rx in (0..cw).step_by(stride) {
            let cx = rx as f64 + 0.5;
            let cy = ry as f64 + 0.5;
            // Which frames cover this canvas point?
            let covered: Vec<bool> = (0..k)
                .map(|i| {
                    let (fw, fh) = frame_dims[i];
                    let (fx, fy) = inv_sims[i].apply(cx, cy);
                    fx >= 0.0
                        && fx <= fw
                        && fy >= 0.0
                        && fy <= fh
                        && frames[i].validity.get(
                            fx.min(frames[i].width() as f64 - 1.0).max(0.0) as u32,
                            fy.min(frames[i].height() as f64 - 1.0).max(0.0) as u32,
                        )
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
    if min_w == usize::MAX {
        0
    } else {
        min_w
    }
}

/// Voronoi masks for a (possibly haloed) region.
/// Identical logic to the former `voronoi_masks_tile` but operates on an
/// arbitrary region-sized `PlanarImage`.
fn voronoi_masks_region(layers: &[PlanarImage]) -> (Vec<Vec<f32>>, usize) {
    let Some(first) = layers.first() else {
        return (vec![], 0);
    };
    let cw = first.width() as usize;
    let ch = first.height() as usize;
    let n = cw * ch;
    let k = layers.len();

    let depths: Vec<Vec<f32>> = layers
        .iter()
        .map(|layer| {
            let mut d = vec![-1.0_f32; n];
            for py in 0..ch {
                for px in 0..cw {
                    if !layer.validity.get(px as u32, py as u32) {
                        continue;
                    }
                    let border = (px as f64)
                        .min(cw as f64 - 1.0 - px as f64)
                        .min(py as f64)
                        .min(ch as f64 - 1.0 - py as f64);
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
