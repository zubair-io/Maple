//! Match-graph builder (spec §5.2: "match a graph, not a chain").
//!
//! Candidate image pairs come from pluggable [`CandidateProvider`]s; each
//! candidate is verified with the robust rotation estimator
//! ([`crate::robust::verify_pair`]) and becomes a [`VerifiedEdge`] only
//! with ≥ `min_inliers` support. The result reports connected components
//! and orphans — the groundwork for the spec's
//! `DropReason::Disconnected` ("stitch the largest component and report
//! the orphans — never silently drop or force-align").
//!
//! Providers:
//!
//! - [`CaptureOrderProvider`] — §5.2(a), consecutive frames in capture
//!   order (the input order of the image list).
//! - [`GimbalPriorProvider`] — §5.2(b), pairs whose *prior* view
//!   directions are closer than `1.5 ×` the per-image FOV (adapted from
//!   PR #17's `overlap_graph`/`gimbal_filter` angular-proximity logic;
//!   the prior is advisory — it nominates candidates, verification
//!   decides).
//! - [`descriptor_topk::DescriptorTopKProvider`] — §5.2(c), top-k
//!   retrieval by mean-descriptor similarity, for unordered /
//!   metadata-free input (film scans, mixed-shoot DSLR bursts) where
//!   neither capture order nor gimbal priors give a signal (ticket
//!   #1215). See that module for the similarity choice, its cost, and
//!   why it's a struct field rather than a trait-signature change.
//! - [`grid_prior::GridPriorProvider`] — declared `R × C` drone/array
//!   grids (#4519): O(N) neighbour nomination plus a post-verification
//!   footprint + triangle-consistency gate on loop closures.
//!
//! # Determinism
//!
//! Candidates are deduplicated into a sorted set and verified in
//! ascending `(a, b)` order; each pair's estimator seed is derived from
//! [`RobustOptions::seed`] and the pair indices via SplitMix64, so the
//! graph is bit-identical across runs regardless of provider order, and
//! adding a provider does not perturb the seeds of unrelated pairs.

// The descriptor top-k provider consumes `features::FeatureSet` — ALIKED
// output — so it lives behind the same `ml` gate as its only consumers
// (`stitch::*`); the crate builds bare without it (#3236).
#[cfg(any(feature = "ml", feature = "ml-static"))]
pub mod descriptor_topk;
pub mod grid_prior;

use std::collections::BTreeSet;

use crate::camera::Camera;
use crate::math::{Mat3, Vec3};
use crate::prng::SplitMix64;
use crate::robust::{verify_pair, RobustOptions, VerifyFailure};
use crate::twoview::PixelCorrespondence;

#[cfg(any(feature = "ml", feature = "ml-static"))]
pub use descriptor_topk::DescriptorTopKProvider;
pub use grid_prior::{
    GridLayout, GridOrder, GridPriorProvider, LOOP_CLOSURE_MAX_CELLS,
    LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG,
};

/// One image entering the graph build.
///
/// `camera.rotation` (the pose) is **ignored** by matching and
/// verification — poses are what later milestones solve for. Only the
/// intrinsics (`focal_px`, `k1`, `k2`, size) are read. The gimbal prior,
/// when present, is a separate camera-to-world rotation used solely for
/// candidate nomination.
#[derive(Debug, Clone)]
pub struct GraphImage {
    pub camera: Camera,
    /// Approximate camera-to-world rotation from capture metadata
    /// (gimbal yaw/pitch/roll). Advisory only.
    pub prior_rotation: Option<Mat3>,
}

/// Nominates candidate image pairs worth sending to the matcher +
/// verifier. Implementations must be pure functions of `images` (the
/// builder depends on that for determinism).
pub trait CandidateProvider {
    /// Provider name for diagnostics.
    fn name(&self) -> &'static str;
    /// Candidate `(i, j)` index pairs. Order, duplicates, and `i`/`j`
    /// ordering are all forgiven — the builder normalizes; out-of-range
    /// or self pairs are discarded.
    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)>;
}

/// §5.2(a): consecutive frames in capture order. The image list order is
/// the capture order.
#[derive(Debug, Clone, Copy, Default)]
pub struct CaptureOrderProvider;

impl CandidateProvider for CaptureOrderProvider {
    fn name(&self) -> &'static str {
        "capture-order"
    }

    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)> {
        (1..images.len()).map(|i| (i - 1, i)).collect()
    }
}

/// §5.2(b): pairs whose prior optical axes are separated by less than
/// `max_separation_factor ×` the per-image horizontal FOV (the mean of
/// the two images' FOVs, since they may differ). Pairs missing a prior
/// on either side are never nominated — that is [`CaptureOrderProvider`]'s
/// (and, per #1139, the retrieval provider's) job.
#[derive(Debug, Clone, Copy)]
pub struct GimbalPriorProvider {
    /// Spec §5.2 sets 1.5.
    pub max_separation_factor: f64,
}

impl Default for GimbalPriorProvider {
    fn default() -> Self {
        Self {
            max_separation_factor: 1.5,
        }
    }
}

impl CandidateProvider for GimbalPriorProvider {
    fn name(&self) -> &'static str {
        "gimbal-prior"
    }

    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)> {
        let axes: Vec<Option<Vec3>> = images
            .iter()
            .map(|img| {
                img.prior_rotation
                    .as_ref()
                    .map(|r| r.mul_vec(Vec3::new(0.0, 0.0, 1.0)))
            })
            .collect();
        let mut out = Vec::new();
        for i in 0..images.len() {
            let Some(ai) = axes[i] else { continue };
            for j in (i + 1)..images.len() {
                let Some(aj) = axes[j] else { continue };
                let separation = ai.cross(aj).norm().atan2(ai.dot(aj));
                let limit = self.max_separation_factor
                    * 0.5
                    * (images[i].camera.hfov_deg() + images[j].camera.hfov_deg()).to_radians();
                if separation < limit {
                    out.push((i, j));
                }
            }
        }
        out
    }
}

/// A robustly verified pair: the spec's per-edge payload
/// `{R_rel, inlier count, mean angular residual}` plus the inlier
/// correspondences themselves.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedEdge {
    pub a: usize,
    pub b: usize,
    /// Relative rotation in the [`crate::twoview`] convention:
    /// `d_b ≈ rotation · d_a` for camera-frame bearings of images
    /// `a` and `b` (`a < b`).
    pub rotation: Mat3,
    pub inlier_count: usize,
    pub mean_residual_rad: f64,
    /// The verified inlier correspondences (the input matches with the
    /// estimator's inlier mask applied; `len() == inlier_count`). Kept on
    /// the edge because the graph is the hand-off to global bundle
    /// adjustment, which minimizes reprojection error over exactly "all
    /// inlier matches in the graph" (spec §5.3) — without the payload
    /// every consumer would have to re-run verification to recover the
    /// masks.
    pub inlier_matches: Vec<PixelCorrespondence>,
}

/// A candidate pair that failed verification — kept for diagnostics
/// (the spec's "report, never silently drop" stance).
#[derive(Debug, Clone, PartialEq)]
pub struct RejectedPair {
    pub a: usize,
    pub b: usize,
    pub reason: VerifyFailure,
}

/// The verified match graph plus connectivity diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchGraph {
    pub image_count: usize,
    /// Verified edges, ascending `(a, b)`.
    pub edges: Vec<VerifiedEdge>,
    /// Candidates that failed verification, ascending `(a, b)`.
    pub rejected: Vec<RejectedPair>,
    /// Connected components over the verified edges; every image appears
    /// in exactly one. Sorted by size descending, ties by smallest
    /// member; members sorted ascending.
    pub components: Vec<Vec<usize>>,
    /// Images outside the largest component (`components[0]`), ascending
    /// — the candidates for the spec's `DropReason::Disconnected`.
    /// Empty when the graph is connected or has ≤ 1 image.
    pub orphans: Vec<usize>,
}

/// What [`MatchGraph::reverify`] changed — surfaced in the stitch report
/// ("report, never silently drop").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReverifySummary {
    /// Edges that no longer verified (estimator failure or fewer than
    /// `min_inliers` surviving matches) and were removed.
    pub edges_dropped: usize,
    /// Matches shed from surviving edges by the re-estimated inlier
    /// masks.
    pub matches_dropped: usize,
}

impl MatchGraph {
    /// `true` when every image is reachable from every other (vacuously
    /// true for 0 or 1 images).
    pub fn is_connected(&self) -> bool {
        self.components.len() <= 1
    }

    /// Re-verify every edge against `images` — the coarse-to-fine second
    /// pass (#1210). The first verification runs at proxy scale, where
    /// its noise model (`sigma_max_px`) tolerates ~`proxy_factor ×`
    /// more *full-resolution* error than the spec budgets allow; after
    /// full-res refinement lifts the matches, this pass re-estimates
    /// each edge at the resolution BA will solve at, shedding matches
    /// that only passed at proxy tolerance (moving content, refinement
    /// fallbacks) before they pollute the joint solve. Edge payloads
    /// (`rotation`, `inlier_count`, `mean_residual_rad`,
    /// `inlier_matches`) are replaced by the re-estimates; edges that no
    /// longer verify move to `rejected`, and components/orphans are
    /// recomputed. Per-pair seeds use the same derivation as the
    /// builder, so the pass is deterministic.
    pub fn reverify(
        &mut self,
        images: &[GraphImage],
        opts: &RobustOptions,
    ) -> Result<ReverifySummary, crate::error::PanoError> {
        if images.len() != self.image_count {
            return Err(crate::error::PanoError::InvalidOptions(format!(
                "reverify: {} images vs a graph built over {}",
                images.len(),
                self.image_count
            )));
        }
        let mut summary = ReverifySummary {
            edges_dropped: 0,
            matches_dropped: 0,
        };
        let mut kept = Vec::with_capacity(self.edges.len());
        for mut edge in std::mem::take(&mut self.edges) {
            let pair_opts = RobustOptions {
                seed: pair_seed(opts.seed, edge.a, edge.b),
                ..opts.clone()
            };
            match verify_pair(
                &images[edge.a].camera,
                &images[edge.b].camera,
                &edge.inlier_matches,
                &pair_opts,
            ) {
                Ok(est) => {
                    summary.matches_dropped += edge.inlier_matches.len() - est.inlier_count;
                    edge.inlier_matches = edge
                        .inlier_matches
                        .iter()
                        .zip(&est.inlier_mask)
                        .filter(|(_, &keep)| keep)
                        .map(|(&m, _)| m)
                        .collect();
                    debug_assert_eq!(edge.inlier_matches.len(), est.inlier_count);
                    edge.rotation = est.rotation;
                    edge.inlier_count = est.inlier_count;
                    edge.mean_residual_rad = est.mean_residual_rad;
                    kept.push(edge);
                }
                Err(reason) => {
                    summary.edges_dropped += 1;
                    summary.matches_dropped += edge.inlier_matches.len();
                    self.rejected.push(RejectedPair {
                        a: edge.a,
                        b: edge.b,
                        reason,
                    });
                }
            }
        }
        self.rejected.sort_by_key(|r| (r.a, r.b));
        self.edges = kept;
        self.components = connected_components(self.image_count, &self.edges);
        self.orphans = orphans_of(&self.components);
        Ok(summary)
    }
}

/// Build the verified match graph.
///
/// `fetch_matches(a, b)` supplies pixel correspondences for a candidate
/// pair (`a < b`; correspondence `.a` pixels live in image `a`'s frame).
/// In production that is the #1139 feature-matching stack; tests use the
/// `testkit` generator. It is called exactly once per deduplicated
/// candidate, in ascending order.
pub fn build_match_graph(
    images: &[GraphImage],
    providers: &[&dyn CandidateProvider],
    mut fetch_matches: impl FnMut(usize, usize) -> Vec<PixelCorrespondence>,
    opts: &RobustOptions,
) -> MatchGraph {
    let n = images.len();
    let mut candidates: BTreeSet<(usize, usize)> = BTreeSet::new();
    for provider in providers {
        for (i, j) in provider.candidates(images) {
            let (a, b) = if i < j { (i, j) } else { (j, i) };
            if a != b && b < n {
                candidates.insert((a, b));
            }
        }
    }

    let mut edges = Vec::new();
    let mut rejected = Vec::new();
    for &(a, b) in &candidates {
        let matches = fetch_matches(a, b);
        let pair_opts = RobustOptions {
            seed: pair_seed(opts.seed, a, b),
            ..opts.clone()
        };
        match verify_pair(&images[a].camera, &images[b].camera, &matches, &pair_opts) {
            Ok(est) => {
                let inlier_matches: Vec<PixelCorrespondence> = matches
                    .iter()
                    .zip(&est.inlier_mask)
                    .filter(|(_, &keep)| keep)
                    .map(|(&m, _)| m)
                    .collect();
                debug_assert_eq!(inlier_matches.len(), est.inlier_count);
                edges.push(VerifiedEdge {
                    a,
                    b,
                    rotation: est.rotation,
                    inlier_count: est.inlier_count,
                    mean_residual_rad: est.mean_residual_rad,
                    inlier_matches,
                });
            }
            Err(reason) => rejected.push(RejectedPair { a, b, reason }),
        }
    }

    let components = connected_components(n, &edges);
    let orphans = orphans_of(&components);

    MatchGraph {
        image_count: n,
        edges,
        rejected,
        components,
        orphans,
    }
}

/// Images outside the largest component, ascending (see
/// [`MatchGraph::orphans`]).
fn orphans_of(components: &[Vec<usize>]) -> Vec<usize> {
    if components.len() > 1 {
        let mut o: Vec<usize> = components[1..].iter().flatten().copied().collect();
        o.sort_unstable();
        o
    } else {
        Vec::new()
    }
}

/// Per-pair estimator seed: mixes the base seed with the pair indices so
/// every pair gets an independent, order-stable stream.
fn pair_seed(base: u64, a: usize, b: usize) -> u64 {
    SplitMix64::new(base ^ ((a as u64) << 32) ^ b as u64).next_u64()
}

/// BFS connected components over the verified edges. Components sorted
/// by size descending, ties broken by smallest member; members ascending.
fn connected_components(n: usize, edges: &[VerifiedEdge]) -> Vec<Vec<usize>> {
    let mut adjacency = vec![Vec::<usize>::new(); n];
    for e in edges {
        adjacency[e.a].push(e.b);
        adjacency[e.b].push(e.a);
    }
    let mut seen = vec![false; n];
    let mut components = Vec::new();
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut queue = std::collections::VecDeque::from([start]);
        let mut component = Vec::new();
        while let Some(node) = queue.pop_front() {
            component.push(node);
            for &next in &adjacency[node] {
                if !seen[next] {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
        component.sort_unstable();
        components.push(component);
    }
    components.sort_by(|x, y| y.len().cmp(&x.len()).then_with(|| x[0].cmp(&y[0])));
    components
}

#[cfg(test)]
mod tests;
