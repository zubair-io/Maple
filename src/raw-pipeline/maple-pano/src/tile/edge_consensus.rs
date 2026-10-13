//! Parallax-consistent similarity selection for tile edges (#4553).
//!
//! A nadir strip over relief (a dune face, a street canyon between
//! rooftops) has no single planar similarity per pair: every depth band
//! moves by its own amount. The robust per-edge fit locks onto whichever
//! band is tightest, and when neighbouring edges lock onto different
//! bands the anchored solve spreads hundreds of pixels of contradiction
//! over every seam. So each edge keeps up to [`MAX_HYPOTHESES`] band
//! hypotheses (sequential robust fits on the remaining matches), and the
//! choice of one hypothesis per edge descends the graph's summed
//! contradiction one switch at a time, from the dominant fits and from
//! seeded random starts. An edge whose choice still
//! contradicts the placement by more than [`OUTLIER_EDGE_FACTOR`] × the
//! median contradiction (and more than the verifier's own inlier gate) is
//! then dropped, worst first, and selection reruns. The solve is weighted
//! by inlier count, so a conflict's blame lands on its weaker side, and a
//! bridge edge, whose far side nothing else places, is fitted to within
//! its own inlier spread, so it is never dropped.

use crate::graph::MatchGraph;
use crate::prng::SplitMix64;
use crate::similarity::{estimate_similarity, SimilarityOptions, TAU_SCALE};
use crate::twoview::PixelCorrespondence;

use super::placement::{solve_tile_poses, TileConstraint, TilePose};
use super::TileEdge;

const MAX_HYPOTHESES: usize = 5;
const MAX_SWITCHES: usize = 64;
const RANDOM_STARTS: usize = 16;
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
    prune_and_select(candidates, full_dims, gate_px, seed)
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
    seed: u64,
) -> Vec<TileEdge> {
    let mut choice = vec![0usize; candidates.len()];
    loop {
        choice = settle_choice(&candidates, choice, full_dims, seed);
        let Some(poses) = solve(&candidates, &choice, full_dims) else {
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

/// The best of [`descend`] runs from the given choice and from
/// [`RANDOM_STARTS`] seeded random choices. Over strong relief (a dune
/// strip carries five or more bands per pair) the contradiction landscape
/// has many local minima, and a single descent from the dominant fits
/// stops in one far from the consistent set.
fn settle_choice(
    candidates: &[Vec<TileEdge>],
    initial: Vec<usize>,
    full_dims: &[(u32, u32)],
    seed: u64,
) -> Vec<usize> {
    let mut rng = SplitMix64::new(seed);
    let random_starts: Vec<Vec<usize>> = (0..RANDOM_STARTS)
        .map(|_| {
            candidates
                .iter()
                .map(|h| (rng.next_u64() % h.len() as u64) as usize)
                .collect()
        })
        .collect();
    std::iter::once(initial)
        .chain(random_starts)
        .map(|start| descend(candidates, start, full_dims))
        .map(|choice| (summed_contradiction(candidates, &choice, full_dims), choice))
        .min_by(|x, y| x.0.total_cmp(&y.0))
        .map(|(_, choice)| choice)
        .unwrap_or_default()
}

/// Steepest single-switch descent on [`summed_contradiction`]: try every
/// edge on every one of its other hypotheses, take the switch that lowers
/// the sum most, and stop when none does. Each step strictly lowers the
/// objective, so unlike re-choosing every edge at once against the last
/// solve (where two edges of one cycle can trade bands back and forth
/// forever), it cannot cycle.
fn descend(
    candidates: &[Vec<TileEdge>],
    initial: Vec<usize>,
    full_dims: &[(u32, u32)],
) -> Vec<usize> {
    let score = |choice: &[usize]| summed_contradiction(candidates, choice, full_dims);
    std::iter::successors(Some((score(&initial), initial)), |(current, choice)| {
        candidates
            .iter()
            .enumerate()
            .flat_map(|(i, h)| (0..h.len()).map(move |k| (i, k)))
            .filter(|&(i, k)| k != choice[i])
            .map(|(i, k)| {
                let switched: Vec<usize> = choice
                    .iter()
                    .enumerate()
                    .map(|(j, &c)| if j == i { k } else { c })
                    .collect();
                (score(&switched), switched)
            })
            .min_by(|x, y| x.0.total_cmp(&y.0))
            .filter(|(next, _)| next < current)
    })
    .take(MAX_SWITCHES)
    .last()
    .map_or_else(Vec::new, |(_, choice)| choice)
}

/// Sum over edges of each chosen hypothesis's disagreement with the
/// placement solved from all chosen hypotheses. Every edge counts once
/// whichever hypothesis it holds, so a choice cannot score better just by
/// holding fewer inliers.
fn summed_contradiction(
    candidates: &[Vec<TileEdge>],
    choice: &[usize],
    full_dims: &[(u32, u32)],
) -> f64 {
    solve(candidates, choice, full_dims).map_or(f64::INFINITY, |poses| {
        candidates
            .iter()
            .zip(choice)
            .filter_map(|(h, &c)| disagreement(&h[c], &poses))
            .sum()
    })
}

fn solve(
    candidates: &[Vec<TileEdge>],
    choice: &[usize],
    full_dims: &[(u32, u32)],
) -> Option<Vec<TilePose>> {
    let constraints: Vec<TileConstraint> = candidates
        .iter()
        .zip(choice)
        .map(|(h, &c)| TileConstraint {
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
