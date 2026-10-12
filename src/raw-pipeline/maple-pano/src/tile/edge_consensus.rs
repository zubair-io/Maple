//! Parallax-consistent similarity selection for tile edges (#4553).
//!
//! A nadir strip over relief (a dune face, a street canyon between
//! rooftops) has no single planar similarity per pair: every depth band
//! moves by its own amount. The robust per-edge fit locks onto whichever
//! band is tightest, and when neighbouring edges lock onto different
//! bands the anchored solve spreads hundreds of pixels of contradiction
//! over every seam. So each edge keeps up to [`MAX_HYPOTHESES`] band
//! hypotheses (sequential robust fits on the remaining matches) and
//! switches to the one the placement solved from all *other* edges
//! agrees with best; the loop repeats until the choice settles. The
//! solve leaves the judged edge out so its own pull cannot vote for the
//! band it already holds. Then, under the full weighted solve, an edge
//! whose choice still contradicts the placement by more than
//! [`OUTLIER_EDGE_FACTOR`] × the median contradiction (and more than the
//! verifier's own inlier gate) is dropped, worst first, and selection
//! reruns. The weighting puts a conflict's blame on its weaker side, and
//! a bridge edge, whose far side nothing else places, is fitted to
//! within its own inlier spread, so it is never dropped.

use crate::graph::MatchGraph;
use crate::prng::SplitMix64;
use crate::similarity::{estimate_similarity, SimilarityOptions, TAU_SCALE};
use crate::twoview::PixelCorrespondence;

use super::placement::{solve_tile_poses, TileConstraint, TilePose};
use super::TileEdge;

const MAX_HYPOTHESES: usize = 5;
const MAX_SELECTION_ROUNDS: usize = 8;
const OUTLIER_EDGE_FACTOR: f64 = 3.0;

/// Verify every edge in `graph` with the similarity model, choosing per
/// edge the depth-band hypothesis the whole graph agrees on.
///
/// `seed` is mixed with each pair's indices so every edge's RANSAC is
/// independent and the result is deterministic.
pub fn verify_tile_edges(
    graph: &MatchGraph,
    seed: u64,
    opts: &SimilarityOptions,
    full_dims: &[(u32, u32)],
) -> Vec<TileEdge> {
    let candidates: Vec<Vec<TileEdge>> = graph
        .edges
        .iter()
        .map(|edge| {
            let pair_seed =
                SplitMix64::new(seed ^ ((edge.a as u64) << 32) ^ edge.b as u64).next_u64();
            band_hypotheses(
                edge.a,
                edge.b,
                &edge.inlier_matches,
                opts,
                &mut SplitMix64::new(pair_seed),
            )
        })
        .filter(|h| !h.is_empty())
        .collect();
    let gate_px = TAU_SCALE * opts.sigma_max_px;
    prune_and_select(candidates, full_dims, gate_px)
}

/// Sequential robust fits: each hypothesis is fitted on the matches no
/// earlier hypothesis claimed. The first is the plain dominant fit.
fn band_hypotheses(
    a: usize,
    b: usize,
    matches: &[PixelCorrespondence],
    opts: &SimilarityOptions,
    rng: &mut SplitMix64,
) -> Vec<TileEdge> {
    let mut hypotheses = Vec::new();
    let mut remaining = matches.to_vec();
    while hypotheses.len() < MAX_HYPOTHESES {
        let Ok(estimate) = estimate_similarity(&remaining, opts, rng) else {
            break;
        };
        let (inlier_matches, rest) = remaining.iter().zip(&estimate.inlier_mask).fold(
            (Vec::new(), Vec::new()),
            |(mut inliers, mut rest): (Vec<PixelCorrespondence>, Vec<PixelCorrespondence>),
             (&m, &keep)| {
                if keep {
                    inliers.push(m);
                } else {
                    rest.push(m);
                }
                (inliers, rest)
            },
        );
        hypotheses.push(TileEdge {
            a,
            b,
            estimate,
            inlier_matches,
        });
        remaining = rest;
    }
    hypotheses
}

fn prune_and_select(
    mut candidates: Vec<Vec<TileEdge>>,
    full_dims: &[(u32, u32)],
    gate_px: f64,
) -> Vec<TileEdge> {
    let mut choice = vec![0usize; candidates.len()];
    loop {
        choice = settle_choice(&candidates, choice, full_dims);
        let Some(poses) = solve_without(&candidates, &choice, usize::MAX, full_dims) else {
            break;
        };
        let contradiction: Vec<f64> = candidates
            .iter()
            .zip(&choice)
            .map(|(h, &c)| disagreement(&h[c], &poses).unwrap_or(0.0))
            .collect();
        let limit = (OUTLIER_EDGE_FACTOR * median(&contradiction)).max(gate_px);
        let worst = (0..candidates.len())
            .filter(|&i| contradiction[i] > limit)
            .max_by(|&x, &y| contradiction[x].total_cmp(&contradiction[y]));
        let Some(drop) = worst else {
            break;
        };
        candidates.remove(drop);
        choice.remove(drop);
    }
    candidates
        .into_iter()
        .zip(choice)
        .map(|(mut h, c)| h.swap_remove(c))
        .collect()
}

/// Switch every edge to the hypothesis the *other* edges' solve agrees
/// with best, until the choice is stable (or the round budget runs out).
/// A bridge edge (nothing else places its far side) keeps its choice.
fn settle_choice(
    candidates: &[Vec<TileEdge>],
    initial: Vec<usize>,
    full_dims: &[(u32, u32)],
) -> Vec<usize> {
    (0..MAX_SELECTION_ROUNDS)
        .try_fold(initial, |choice, _| {
            let next: Vec<usize> = (0..candidates.len())
                .map(|i| {
                    solve_without(candidates, &choice, i, full_dims)
                        .and_then(|poses| {
                            candidates[i]
                                .iter()
                                .enumerate()
                                .filter_map(|(h, e)| Some((h, disagreement(e, &poses)?)))
                                .min_by(|x, y| x.1.total_cmp(&y.1).then(x.0.cmp(&y.0)))
                        })
                        .map_or(choice[i], |(h, _)| h)
                })
                .collect();
            if next == choice {
                Err(next)
            } else {
                Ok(next)
            }
        })
        .unwrap_or_else(|settled| settled)
}

/// Placement from every chosen hypothesis except edge `skip`'s (pass an
/// out-of-range index to keep them all).
fn solve_without(
    candidates: &[Vec<TileEdge>],
    choice: &[usize],
    skip: usize,
    full_dims: &[(u32, u32)],
) -> Option<Vec<TilePose>> {
    let constraints: Vec<TileConstraint> = candidates
        .iter()
        .zip(choice)
        .enumerate()
        .filter(|&(i, _)| i != skip)
        .map(|(_, (h, &c))| TileConstraint {
            a: h[c].a,
            b: h[c].b,
            sim_ab: h[c].estimate.transform,
            weight: h[c].inlier_matches.len() as f64,
        })
        .collect();
    solve_tile_poses(full_dims.len(), &constraints, 0, full_dims)
        .ok()
        .map(|(poses, _, _)| poses)
}

/// Mean canvas distance between the two ends of the edge's inliers under
/// the solved poses; `None` when either frame is unplaced.
fn disagreement(edge: &TileEdge, poses: &[TilePose]) -> Option<f64> {
    let pose = |i: usize| poses.iter().find(|p| p.frame_idx == i).map(|p| p.sim);
    let (pa, pb) = (pose(edge.a)?, pose(edge.b)?);
    let total: f64 = edge
        .inlier_matches
        .iter()
        .map(|m| {
            let (ax, ay) = pa.apply(m.a.0, m.a.1);
            let (bx, by) = pb.apply(m.b.0, m.b.1);
            (ax - bx).hypot(ay - by)
        })
        .sum();
    Some(total / edge.inlier_matches.len().max(1) as f64)
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
}

#[cfg(test)]
#[path = "edge_consensus_tests.rs"]
mod tests;
