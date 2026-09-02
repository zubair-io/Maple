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
//! A second, distinct gimbal signal is the attitude **spread** across
//! the set (`gimbal_rotation_spread_deg`): when readings vary by
//! [`GIMBAL_SWEEP_DEG`] or more — the camera measurably pivoted between
//! frames, as opposed to holding one attitude — that is affirmative
//! evidence for a rotation-modeled capture, not mere corroboration of
//! an already-identical attitude. It still never *decides* on its own:
//! an edge with no similarity fit still votes rotation, and an
//! explicit `--strategy tile` still wins outright regardless of
//! gimbal readings. What it does is raise the bar the content vote
//! must clear to select tile, from a bare majority to
//! [`TILE_SUPERMAJORITY_WITH_GIMBAL_SWEEP`], because a knife-edge vote
//! plus independent evidence of a rotation sweep is exactly the
//! failure mode in #3087: small angular steps between frames let a 2D
//! similarity fit adjacent pairs almost as well as the rotation model,
//! producing a near-tie vote share (39–36 on the `pano_01` acceptance
//! set) that the content evidence alone cannot resolve reliably.
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
    /// Maximum pairwise gimbal attitude difference across the set, in
    /// degrees (`None` when fewer than two frames carry gimbal metadata).
    /// A large spread is affirmative evidence of a rotation sweep — see
    /// the module docs' "Metadata corroboration" section.
    pub gimbal_rotation_spread_deg: Option<f64>,
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

/// A gimbal attitude spread at or above this (degrees, max pairwise
/// difference on any axis) is affirmative evidence the camera pivoted
/// between frames — a tens-of-degrees sweep, not attitude-hold jitter.
const GIMBAL_SWEEP_DEG: f64 = 10.0;

/// When [`GIMBAL_SWEEP_DEG`] evidence is present, tile must clear this
/// share of the vote (instead of a bare majority) to be selected. Set
/// comfortably above the 39/75 ≈ 0.52 knife-edge vote share recorded on
/// the `pano_01` acceptance set (#3087).
const TILE_SUPERMAJORITY_WITH_GIMBAL_SWEEP: f64 = 0.65;

/// Select the stitching strategy.
///
/// `priors` is index-aligned with the input frame list (used for gimbal
/// corroboration and sweep-spread evidence). `mean_focal_px` is the mean
/// focal length across the set (for converting angular residuals to
/// pixels).
pub fn select_strategy(
    request: StrategyRequest,
    graph: &MatchGraph,
    priors: &[FramePriors],
    mean_focal_px: f64,
    seed: u64,
) -> StrategyReport {
    let evidence = build_evidence(graph, priors, mean_focal_px, seed);
    let selected = decide(request, &evidence);

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

/// Decide the strategy from already-built evidence. Split out from
/// [`select_strategy`] so the vote-arbitration logic is unit-testable
/// directly on recorded vote/prior numbers, without needing real match
/// geometry to reproduce a specific vote split.
fn decide(request: StrategyRequest, evidence: &StrategyEvidence) -> Strategy {
    match request {
        StrategyRequest::Rotation => Strategy::Rotation,
        StrategyRequest::Tile => Strategy::Tile,
        StrategyRequest::Auto => {
            let total = evidence.tile_votes + evidence.rotation_votes;
            let tile_share = if total == 0 {
                0.0
            } else {
                evidence.tile_votes as f64 / total as f64
            };
            let strong_gimbal_rotation_evidence = evidence
                .gimbal_rotation_spread_deg
                .is_some_and(|spread| spread >= GIMBAL_SWEEP_DEG);
            // With a real gimbal sweep tile must reach the supermajority bar
            // (inclusive: 65% *is* the bar); without one the strict-majority
            // rule stands — rotation wins on a tie or a bare majority.
            let tile_wins = if strong_gimbal_rotation_evidence {
                tile_share >= TILE_SUPERMAJORITY_WITH_GIMBAL_SWEEP
            } else {
                tile_share > 0.5
            };
            if tile_wins {
                Strategy::Tile
            } else {
                Strategy::Rotation
            }
        }
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
    let gimbal_rotation_spread_deg = gimbal_rotation_spread(priors);

    StrategyEvidence {
        per_edge,
        tile_votes,
        rotation_votes,
        gimbal_corroboration,
        gimbal_rotation_spread_deg,
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

/// Maximum pairwise gimbal attitude difference across the set, in degrees
/// — the largest wrap-aware difference found on any single axis (yaw,
/// pitch, or roll) between any two frames. `None` when fewer than two
/// frames carry gimbal metadata, matching [`check_gimbal_identity`]'s
/// "can't tell" convention.
fn gimbal_rotation_spread(priors: &[FramePriors]) -> Option<f64> {
    let gimbals: Vec<_> = priors.iter().filter_map(|p| p.gimbal.as_ref()).collect();
    if gimbals.len() < 2 {
        return None;
    }
    let yaw: Vec<f64> = gimbals.iter().map(|g| g.yaw_deg).collect();
    let pitch: Vec<f64> = gimbals.iter().map(|g| g.pitch_deg).collect();
    let roll: Vec<f64> = gimbals.iter().map(|g| g.roll_deg).collect();
    Some(
        max_pairwise_spread_deg(&yaw)
            .max(max_pairwise_spread_deg(&pitch))
            .max(max_pairwise_spread_deg(&roll)),
    )
}

/// Largest wrap-aware pairwise difference within a set of degree values
/// on a ±180° circular axis (DJI yaw is signed ±180°; pitch/roll don't
/// wrap in practice, but the circular distance is exact for them too).
fn max_pairwise_spread_deg(vals: &[f64]) -> f64 {
    let circular_diff = |a: f64, b: f64| -> f64 {
        let raw = (a - b).rem_euclid(360.0);
        if raw > 180.0 {
            360.0 - raw
        } else {
            raw
        }
    };
    vals.iter()
        .enumerate()
        .flat_map(|(i, &a)| vals[i + 1..].iter().map(move |&b| circular_diff(a, b)))
        .fold(0.0_f64, f64::max)
}
#[cfg(test)]
#[path = "strategy_tests.rs"]
mod tests;
