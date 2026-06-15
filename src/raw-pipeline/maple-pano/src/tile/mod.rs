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

pub mod gain_solve;
pub mod placement;
pub mod streaming;
pub mod warp;

pub use placement::{
    solve_tile_poses, TileCanvasSpec, TilePlacement, TilePlacementError, TilePose,
};
pub use streaming::{composite_tile_streaming, DEFAULT_TILE_STRIP_ROWS};
pub use warp::warp_to_tile_canvas;

use crate::error::PanoError;
use crate::gain::GainOptions;
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

/// End-to-end tile composite (strip-streaming, memory-bounded).
///
/// Delegates to [`composite_tile_streaming`] with the default strip height
/// ([`DEFAULT_TILE_STRIP_ROWS`] = 512).  Output is byte-identical to the
/// former full-canvas implementation; peak memory is bounded to one strip
/// × K source frames instead of full-canvas × K × 2 + K Voronoi planes.
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
    composite_tile_streaming(
        frames,
        tile_edges,
        poses,
        canvas,
        gain_opts,
        levels_override,
        DEFAULT_TILE_STRIP_ROWS,
    )
}
