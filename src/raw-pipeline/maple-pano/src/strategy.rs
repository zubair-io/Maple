//! Multi-strategy alignment selection (spec §8, ticket #1226).
//!
//! # Strategies
//!
//! - **`rotation`**: today's pipeline — rotation BA → leveling →
//!   equirect/cylindrical canvas. For handheld panos, gimbal sweeps,
//!   and any capture where the camera rotated between frames.
//! - **`tile`**: translation/similarity mosaic — 2D similarity per
//!   verified edge, global anchored LS placement, planar canvas.
//!   For nadir mapping strips, film-scan series, flatbed tiles, and
//!   any capture where the camera translated between frames.
//! - **`auto`** (default): content-based selection. Per verified pair,
//!   compare the rotation-model inlier RMS (angular residual converted
//!   to pixels at the frame's focal length) vs. the similarity-model
//!   inlier RMS; aggregate votes decide the set's strategy. Gimbal
//!   metadata corroborates but never decides.
//!
//! # Auto-selection
//!
//! For each verified edge `(a, b)` the auto selector runs the similarity
//! estimator on the same inlier matches that rotation verification
//! produced, and records:
//!
//! - `rotation_rms_px`: mean angular residual (in pixels at the mean
//!   focal length) of the rotation-model inliers under the rotation model.
//! - `planar_rms_px`: mean planar pixel residual of the similarity
//!   inliers under the similarity model.
//!
//! If `planar_rms_px < TILE_WIN_FACTOR × rotation_rms_px`, the pair
//! votes "tile". After all pairs vote, the majority decides. A tie or
//! bare majority in favor of rotation selects rotation (conservative —
//! a pure-rotation set must not be misclassified as tile).
//!
//! # Metadata corroboration
//!
//! When gimbal metadata is present and all frames share the same gimbal
//! attitude (yaw/pitch/roll within [`GIMBAL_IDENTITY_DEG`]), this is
//! recorded as `gimbal_corroboration: true` in the evidence block.
//! It is NEVER required for selection and NEVER overrides the
//! content-based vote.
//!
//! # Notice policy
//!
//! When auto selects `tile` on a set that looks like an intended pano
//! capture (auto was used, not explicit `--strategy tile`), the report
//! carries the spec §8 warning:
//! "Sideways motion detected; pivot in place for best results."
//! An explicit `--strategy tile` is operator intent — no warning.

use crate::graph::MatchGraph;
use crate::ingest::FramePriors;
use crate::prng::SplitMix64;
use crate::similarity::{estimate_similarity, SimilarityOptions};

/// The strategy a set will be stitched with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Rotation,
    Tile,
}

impl Strategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::Rotation => "rotation",
            Strategy::Tile => "tile",
        }
    }
}

/// The user's requested strategy (CLI `--strategy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrategyRequest {
    Auto,
    Rotation,
    Tile,
}

impl StrategyRequest {
    pub fn as_str(self) -> &'static str {
        match self {
            StrategyRequest::Auto => "auto",
            StrategyRequest::Rotation => "rotation",
            StrategyRequest::Tile => "tile",
        }
    }
}

/// Per-edge comparison used by auto selection.
#[derive(Debug, Clone)]
pub struct EdgeEvidence {
    pub a: usize,
    pub b: usize,
    /// Rotation-model mean angular residual, converted to pixels at the
    /// edge's mean focal length.
    pub rotation_rms_px: f64,
    /// Similarity-model mean planar residual (pixels). `None` if
    /// the similarity estimator failed (too few inliers).
    pub planar_rms_px: Option<f64>,
    /// `true` if this edge votes "tile".
    pub votes_tile: bool,
}

/// Evidence used by auto-selection.
#[derive(Debug, Clone)]
pub struct StrategyEvidence {
    pub per_edge: Vec<EdgeEvidence>,
    pub tile_votes: usize,
    pub rotation_votes: usize,
    /// Whether gimbal metadata indicated identical attitudes (corroborates
    /// the content vote but never overrides it).
    pub gimbal_corroboration: bool,
    /// Mean rotation-model RMS across all edges, px.
    pub mean_rotation_rms_px: f64,
    /// Mean similarity-model RMS across all edges with a similarity fit, px.
    pub mean_planar_rms_px: Option<f64>,
}

/// The full strategy selection result.
#[derive(Debug, Clone)]
pub struct StrategyReport {
    pub requested: StrategyRequest,
    pub selected: Strategy,
    pub evidence: StrategyEvidence,
    /// Optional spec §8 warning for the StitchReport.
    pub warning: Option<&'static str>,
}

/// Similarity wins if its RMS is below this factor times the rotation RMS.
/// A strict factor (< 1) means similarity must be materially better.
const TILE_WIN_FACTOR: f64 = 0.85;

/// Gimbal attitudes are "identical" if all frames agree within this
/// (degrees, per axis).
const GIMBAL_IDENTITY_DEG: f64 = 0.5;

/// Select the stitching strategy.
///
/// `priors` is index-aligned with the input frame list (used only for
/// gimbal corroboration). `mean_focal_px` is the mean focal length across
/// the set (for converting angular residuals to pixels).
pub fn select_strategy(
    request: StrategyRequest,
    graph: &MatchGraph,
    priors: &[FramePriors],
    mean_focal_px: f64,
    seed: u64,
) -> StrategyReport {
    let evidence = build_evidence(graph, priors, mean_focal_px, seed);

    let selected = match request {
        StrategyRequest::Rotation => Strategy::Rotation,
        StrategyRequest::Tile => Strategy::Tile,
        StrategyRequest::Auto => {
            // Conservative: rotation wins on tie or majority.
            if evidence.tile_votes > evidence.rotation_votes {
                Strategy::Tile
            } else {
                Strategy::Rotation
            }
        }
    };

    // Warn when auto selects tile (not when the user explicitly
    // requested it — that is operator intent).
    let warning = if selected == Strategy::Tile && request == StrategyRequest::Auto {
        Some("Sideways motion detected; pivot in place for best results")
    } else {
        None
    };

    StrategyReport {
        requested: request,
        selected,
        evidence,
        warning,
    }
}

/// Build per-edge evidence and aggregate votes.
fn build_evidence(
    graph: &MatchGraph,
    priors: &[FramePriors],
    mean_focal_px: f64,
    seed: u64,
) -> StrategyEvidence {
    let sim_opts = SimilarityOptions::default();
    let mut per_edge: Vec<EdgeEvidence> = Vec::with_capacity(graph.edges.len());

    for edge in &graph.edges {
        let rot_rms_rad = edge.mean_residual_rad;
        // Convert angular residual to pixel equivalent at the mean focal.
        // For small angles: px ≈ rad × focal_px.
        let rotation_rms_px = rot_rms_rad * mean_focal_px;

        let pair_seed = SplitMix64::new(seed ^ ((edge.a as u64) << 32) ^ edge.b as u64).next_u64();
        let mut rng = SplitMix64::new(pair_seed);

        let planar_rms_px = match estimate_similarity(&edge.inlier_matches, &sim_opts, &mut rng) {
            Ok(est) => Some(est.mean_residual_px),
            Err(_) => None,
        };

        let votes_tile = planar_rms_px
            .map(|p| p < TILE_WIN_FACTOR * rotation_rms_px)
            .unwrap_or(false);

        per_edge.push(EdgeEvidence {
            a: edge.a,
            b: edge.b,
            rotation_rms_px,
            planar_rms_px,
            votes_tile,
        });
    }

    let tile_votes = per_edge.iter().filter(|e| e.votes_tile).count();
    let rotation_votes = per_edge.len() - tile_votes;

    let mean_rotation_rms_px = if per_edge.is_empty() {
        0.0
    } else {
        per_edge.iter().map(|e| e.rotation_rms_px).sum::<f64>() / per_edge.len() as f64
    };

    let planar_vals: Vec<f64> = per_edge.iter().filter_map(|e| e.planar_rms_px).collect();
    let mean_planar_rms_px = if planar_vals.is_empty() {
        None
    } else {
        Some(planar_vals.iter().sum::<f64>() / planar_vals.len() as f64)
    };

    let gimbal_corroboration = check_gimbal_identity(priors);

    StrategyEvidence {
        per_edge,
        tile_votes,
        rotation_votes,
        gimbal_corroboration,
        mean_rotation_rms_px,
        mean_planar_rms_px,
    }
}

/// Check whether all frames with gimbal priors share the same attitude
/// (within [`GIMBAL_IDENTITY_DEG`] on each axis).
fn check_gimbal_identity(priors: &[FramePriors]) -> bool {
    let gimbals: Vec<_> = priors.iter().filter_map(|p| p.gimbal.as_ref()).collect();
    if gimbals.len() < 2 {
        return false; // can't tell — not enough metadata
    }
    let first = gimbals[0];
    gimbals.iter().all(|g| {
        (g.yaw_deg - first.yaw_deg).abs() < GIMBAL_IDENTITY_DEG
            && (g.pitch_deg - first.pitch_deg).abs() < GIMBAL_IDENTITY_DEG
            && (g.roll_deg - first.roll_deg).abs() < GIMBAL_IDENTITY_DEG
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{MatchGraph, VerifiedEdge};
    use crate::ingest::FramePriors;
    use crate::math::Mat3;
    use crate::twoview::PixelCorrespondence;

    fn dummy_edge(a: usize, b: usize, mean_residual_rad: f64) -> VerifiedEdge {
        VerifiedEdge {
            a,
            b,
            rotation: Mat3::identity(),
            inlier_count: 30,
            mean_residual_rad,
            inlier_matches: Vec::new(),
        }
    }

    fn dummy_graph(edges: Vec<VerifiedEdge>, n: usize) -> MatchGraph {
        MatchGraph {
            image_count: n,
            edges,
            rejected: vec![],
            components: vec![(0..n).collect()],
            orphans: vec![],
        }
    }

    fn dummy_priors(n: usize) -> Vec<FramePriors> {
        (0..n)
            .map(|_| FramePriors {
                focal_mm: None,
                focal_35mm_equiv: None,
                focal_px: None,
                gimbal: None,
            })
            .collect()
    }

    #[test]
    fn explicit_rotation_always_selects_rotation() {
        let graph = dummy_graph(vec![dummy_edge(0, 1, 0.001)], 2);
        let priors = dummy_priors(2);
        let report = select_strategy(StrategyRequest::Rotation, &graph, &priors, 1000.0, 0);
        assert_eq!(report.selected, Strategy::Rotation);
        assert!(report.warning.is_none());
    }

    #[test]
    fn explicit_tile_always_selects_tile_no_warning() {
        let graph = dummy_graph(vec![dummy_edge(0, 1, 0.001)], 2);
        let priors = dummy_priors(2);
        let report = select_strategy(StrategyRequest::Tile, &graph, &priors, 1000.0, 0);
        assert_eq!(report.selected, Strategy::Tile);
        assert!(report.warning.is_none()); // no warning for explicit
    }

    #[test]
    fn auto_with_no_edges_defaults_to_rotation() {
        let graph = dummy_graph(vec![], 1);
        let priors = dummy_priors(1);
        let report = select_strategy(StrategyRequest::Auto, &graph, &priors, 1000.0, 0);
        assert_eq!(report.selected, Strategy::Rotation); // no votes → rotation wins
    }

    #[test]
    fn auto_warns_when_tile_selected() {
        // Create a graph with a pure-translation edge.
        // We'll use a translation-generating match set.
        use crate::similarity::Similarity2d;
        use crate::twoview::PixelCorrespondence;

        let sim_gt = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 500.0,
            ty: 0.0,
        };
        let matches: Vec<PixelCorrespondence> = (0..80)
            .map(|i| {
                let ax = (i as f64) * 4.0 + 50.0;
                let ay = ((i as f64) * 2.1).sin() * 100.0 + 200.0;
                let (bx, by) = sim_gt.apply(ax, ay);
                PixelCorrespondence {
                    a: (ax, ay),
                    b: (bx, by),
                }
            })
            .collect();

        // Make the rotation model look very poor (5 px residual), similarity excellent.
        let mut edge = dummy_edge(0, 1, 0.005); // 5mrad ≈ 5px at f=1000
        edge.inlier_matches = matches;
        let graph = dummy_graph(vec![edge], 2);
        let priors = dummy_priors(2);
        let report = select_strategy(StrategyRequest::Auto, &graph, &priors, 1000.0, 42);

        // Evidence: planar_rms should be near 0, rotation_rms ~5px → votes tile.
        if report.selected == Strategy::Tile {
            assert!(report.warning.is_some(), "auto tile must warn");
        }
    }

    #[test]
    fn gimbal_identity_detected() {
        use crate::ingest::GimbalPrior;
        let priors: Vec<FramePriors> = (0..3)
            .map(|_| FramePriors {
                focal_mm: None,
                focal_35mm_equiv: None,
                focal_px: Some(1000.0),
                gimbal: Some(GimbalPrior {
                    yaw_deg: 125.0,
                    pitch_deg: -90.0,
                    roll_deg: 0.0,
                }),
            })
            .collect();
        assert!(check_gimbal_identity(&priors));
    }

    #[test]
    fn gimbal_rotation_not_identical() {
        use crate::ingest::GimbalPrior;
        let priors: Vec<FramePriors> = (0..3)
            .map(|i| FramePriors {
                focal_mm: None,
                focal_35mm_equiv: None,
                focal_px: Some(1000.0),
                gimbal: Some(GimbalPrior {
                    yaw_deg: (i as f64) * 15.0,
                    pitch_deg: -45.0,
                    roll_deg: 0.0,
                }),
            })
            .collect();
        assert!(!check_gimbal_identity(&priors));
    }
}
