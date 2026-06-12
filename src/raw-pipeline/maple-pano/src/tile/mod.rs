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

pub use placement::{
    solve_tile_poses, TileCanvasSpec, TilePlacement, TilePlacementError, TilePose,
};
pub use warp::warp_to_tile_canvas;

use crate::blend::{blend_multiband, levels_for_overlap_width};
use crate::error::PanoError;
use crate::gain::{solve_gains_tile, GainOptions};
use crate::graph::MatchGraph;
use crate::ingest::PlanarImage;
use crate::similarity::{estimate_similarity, SimilarityEstimate, SimilarityOptions};
use crate::twoview::PixelCorrespondence;

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
}

/// End-to-end tile composite.
///
/// 1. Verify edges with the similarity model.
/// 2. Solve global placement (anchor = frame 0).
/// 3. Size the canvas from placed corners.
/// 4. Warp each frame to canvas.
/// 5. Solve gains (tile-space overlap sampling).
/// 6. Voronoi seam + multi-band blend.
///
/// # Frame / pose alignment contract
///
/// `frames` must be the **filtered** frame list: only frames whose global
/// index appears in `poses` (i.e. the reachable component from `anchor`),
/// in the same order as `poses`. Each `TilePose::frame_idx` names the
/// global index that `frames[local_i]` corresponds to.
///
/// `tile_edges` must also be filtered to the reachable component — edges
/// referencing orphan frames are silently ignored (they have no pose
/// entry and are skipped in the residual loop). The caller (the CLI) is
/// responsible for this filtering, mirroring the rotation path's
/// `solution.cameras` filter.
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

    // Build a global-frame-index → local-pose-index map so edge residual
    // computation never misaligns when orphans have been filtered out.
    // Edges referencing frames not in the map (orphans) are skipped.
    let max_frame_idx = poses.iter().map(|p| p.frame_idx).max().unwrap_or(0);
    let mut frame_to_local = vec![usize::MAX; max_frame_idx + 1];
    for (li, pose) in poses.iter().enumerate() {
        frame_to_local[pose.frame_idx] = li;
    }

    // Planar residuals across all edges (only edges within the component).
    let mut residual_sum = 0.0_f64;
    let mut residual_max = 0.0_f64;
    let mut residual_count = 0usize;
    for edge in tile_edges {
        let la = frame_to_local.get(edge.a).copied().unwrap_or(usize::MAX);
        let lb = frame_to_local.get(edge.b).copied().unwrap_or(usize::MAX);
        if la == usize::MAX || lb == usize::MAX {
            // Edge spans an orphan; skip — no pose exists for it.
            continue;
        }
        let pa = &poses[la];
        let pb = &poses[lb];
        for m in &edge.inlier_matches {
            // Transform: canvas(a) = pa(a_px), canvas(b) = pb(b_px).
            // Consistency: pa(a_px) ≈ pb(b_px) at overlap.
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

    // Warp each frame.
    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(poses)
        .map(|(f, pose)| warp_to_tile_canvas(f, pose, canvas, [1.0, 1.0, 1.0]))
        .collect();

    // Gain compensation in tile space (overlap means in canvas coords).
    let gains = solve_gains_tile(&layers, gain_opts)?;

    // Re-warp with gains folded in (or just fold into a single pass).
    let layers_gained: Vec<PlanarImage> = frames
        .iter()
        .zip(poses)
        .zip(&gains)
        .map(|((f, pose), &g)| warp_to_tile_canvas(f, pose, canvas, g))
        .collect();

    // Voronoi seam masks.
    let (masks, min_overlap) = voronoi_masks_tile(&layers_gained);
    let levels = levels_override.unwrap_or_else(|| levels_for_overlap_width(min_overlap));
    let blended = blend_multiband(&layers_gained, &masks, levels);

    Ok((
        blended,
        TileCompositeReport {
            canvas: canvas.clone(),
            placements: poses.to_vec(),
            gains,
            blend_levels: levels,
            min_overlap_width_px: min_overlap,
            mean_planar_residual_px: mean_planar,
            max_planar_residual_px: residual_max,
        },
    ))
}

/// Voronoi masks for the tile canvas: each covered pixel is owned by the
/// frame whose placed footprint it lies deepest inside.
fn voronoi_masks_tile(layers: &[PlanarImage]) -> (Vec<Vec<f32>>, usize) {
    let Some(first) = layers.first() else {
        return (vec![], 0);
    };
    let cw = first.width() as usize;
    let ch = first.height() as usize;
    let n = cw * ch;
    let k = layers.len();

    // Validity-based depth: for tile canvas, use border distance (same
    // metric as composite.rs's voronoi_masks).
    let depths: Vec<Vec<f32>> = layers
        .iter()
        .map(|layer| {
            let mut d = vec![-1.0_f32; n];
            for py in 0..ch {
                for px in 0..cw {
                    if !layer.validity.get(px as u32, py as u32) {
                        continue;
                    }
                    // Border distance in canvas pixels.
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
