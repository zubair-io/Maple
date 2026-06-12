//! Block assembly, statistics, finalization, and connectivity
//! helpers for [`super::solve`]. Split from `ba/mod.rs` for the
//! file-size budget.

use crate::camera::Camera;
use crate::graph::{GraphImage, MatchGraph};
use crate::math::{matrix_to_axis_angle, Mat3};

use super::lm::{minimize, LmOptions};
use super::residual::{
    eval_residual, Block, FrameMeta, ParamLayout, State, INVALID_BLOCK_RESIDUAL_PX,
};
use super::{BaOptions, BaSolution, FrameStats};

/// Stage-C detection floor: frames whose median residual is already
/// below this aren't candidates — there is nothing material to recover.
const PROBE_MEDIAN_FLOOR_PX: f64 = 0.3;
/// Cohort trigger: a frame is a fallback candidate when its median
/// residual exceeds this multiple of the cohort's median-of-medians. A
/// wrong per-frame focal concentrates error in that frame's blocks;
/// honest frames sit together at the shared noise floor.
const COHORT_MEDIAN_EXCESS_MIN: f64 = 2.0;
/// A freed focal must move away from the shared focal by at least this
/// relative amount — staying at the shared value means the extra
/// parameter merely fit noise and the frame keeps the shared focal.
const PROBE_FOCAL_SHIFT_MIN: f64 = 0.01;

/// Stage-C outcome bookkeeping for [`super::solve`].
pub(super) struct StageC {
    pub iterations: usize,
    pub converged: bool,
    pub final_cost: f64,
}

/// Decision §9.2: the per-image focal fallback.
///
/// The physical signature of a wrong per-frame focal is a radial
/// residual field, but by the time Stage B has converged the joint
/// rotations have absorbed its uniform component, and what is left is
/// neither radial about the principal point nor recoverable by a
/// frozen-neighbor single-frame probe (the probe LM stalls against the
/// compensated rotations — measured, not hypothesized). What works is
/// letting the *joint* stage test the candidates:
///
/// 1. Candidates = frames whose median residual stands ≥
///    [`COHORT_MEDIAN_EXCESS_MIN`] above the cohort median-of-medians.
/// 2. One joint re-solve with all candidate focals freed.
/// 3. A candidate's freed focal is kept only when it moved ≥
///    [`PROBE_FOCAL_SHIFT_MIN`] from the shared focal (else it fit
///    noise) **and** its frame rescued to within the acceptance budget
///    (else the frame's problem is not focal — e.g. an inconsistent
///    pose — and the §5.3 gate must drop it, not a fake focal absorb
///    it).
/// 4. When only a subset is kept, the state is restored and re-solved
///    with exactly that subset, so rejected candidates never leak into
///    the returned state. At most two extra joint solves, once per
///    [`super::solve`] call.
pub(super) fn focal_fallback(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &mut State,
    n_local: usize,
    gauge: usize,
    opts: &BaOptions,
    lm_opts: &LmOptions,
) -> Option<StageC> {
    let before = frame_stats(blocks, frames, state, n_local);
    let cohort = median(before.iter().filter(|s| s.blocks > 0).map(|s| s.median_px)).unwrap_or(0.0);
    let trigger = (cohort * COHORT_MEDIAN_EXCESS_MIN).max(PROBE_MEDIAN_FLOOR_PX);
    let candidates: Vec<usize> = (0..n_local)
        .filter(|&f| before[f].blocks > 0 && before[f].median_px >= trigger)
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let snapshot = state.clone();
    for &f in &candidates {
        state.focal_overrides[f] = Some(state.shared_focal);
    }
    let layout = ParamLayout::full(n_local, gauge, &candidates);
    let first = minimize(blocks, frames, state, &layout, opts.huber_delta_px, lm_opts);
    let after = frame_stats(blocks, frames, state, n_local);
    let kept: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&f| {
            let moved = (state.focal(f) - state.shared_focal).abs() / state.shared_focal
                >= PROBE_FOCAL_SHIFT_MIN;
            moved && after[f].median_px <= opts.mean_budget_px
        })
        .collect();

    if kept.len() == candidates.len() {
        return Some(StageC {
            iterations: first.iterations,
            converged: first.converged,
            final_cost: first.final_cost,
        });
    }

    *state = snapshot;
    if kept.is_empty() {
        // Nothing here is a focal problem — leave the elevated frames
        // to the acceptance gate.
        return None;
    }
    for &f in &kept {
        state.focal_overrides[f] = Some(state.shared_focal);
    }
    let layout = ParamLayout::full(n_local, gauge, &kept);
    let second = minimize(blocks, frames, state, &layout, opts.huber_delta_px, lm_opts);
    Some(StageC {
        iterations: first.iterations + second.iterations,
        converged: second.converged,
        final_cost: second.final_cost,
    })
}

/// Two directed blocks per inlier correspondence of every edge whose
/// endpoints are both active.
pub(super) fn build_blocks(graph: &MatchGraph, local_of: &[usize]) -> Vec<Block> {
    let mut blocks = Vec::new();
    for e in &graph.edges {
        let (a, b) = (local_of[e.a], local_of[e.b]);
        if a == usize::MAX || b == usize::MAX {
            continue;
        }
        for m in &e.inlier_matches {
            blocks.push(Block {
                src: a,
                dst: b,
                p_src: m.a,
                p_dst: m.b,
            });
            blocks.push(Block {
                src: b,
                dst: a,
                p_src: m.b,
                p_dst: m.a,
            });
        }
    }
    blocks
}

/// Residual summaries per local frame, attributing each block to the
/// frame whose pixel plane it is measured in (`dst`).
pub(super) fn frame_stats(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    n_local: usize,
) -> Vec<FrameStats> {
    let mut per_frame: Vec<Vec<f64>> = vec![Vec::new(); n_local];
    for block in blocks {
        let s = match eval_residual(state, frames, block) {
            Some(r) => (r[0] * r[0] + r[1] * r[1]).sqrt(),
            None => INVALID_BLOCK_RESIDUAL_PX,
        };
        per_frame[block.dst].push(s);
    }
    per_frame
        .into_iter()
        .map(|mut v| {
            if v.is_empty() {
                return FrameStats {
                    mean_px: 0.0,
                    max_px: 0.0,
                    median_px: 0.0,
                    blocks: 0,
                };
            }
            v.sort_by(f64::total_cmp);
            let n = v.len();
            FrameStats {
                mean_px: v.iter().sum::<f64>() / n as f64,
                max_px: v[n - 1],
                median_px: if n % 2 == 1 {
                    v[n / 2]
                } else {
                    0.5 * (v[n / 2 - 1] + v[n / 2])
                },
                blocks: n,
            }
        })
        .collect()
}

/// Write the converged state into the solution shape.
pub(super) fn finalize(
    solution: &mut BaSolution,
    images: &[GraphImage],
    active: &[usize],
    state: &State,
    stats: &[FrameStats],
    blocks: &[Block],
    frames: &[FrameMeta],
) {
    solution.shared_focal_px = state.shared_focal;
    solution.k1 = state.k1;
    solution.k2 = state.k2;
    for (local, &global) in active.iter().enumerate() {
        let img = &images[global].camera;
        solution.cameras[global] = Some(Camera::new(
            matrix_to_axis_angle(&state.rotations[local]),
            state.focal(local),
            state.k1,
            state.k2,
            img.width,
            img.height,
        ));
        solution.frame_stats[global] = Some(stats[local].clone());
    }
    let (mut sum, mut max, mut count) = (0.0_f64, 0.0_f64, 0usize);
    for block in blocks {
        let s = match eval_residual(state, frames, block) {
            Some(r) => (r[0] * r[0] + r[1] * r[1]).sqrt(),
            None => INVALID_BLOCK_RESIDUAL_PX,
        };
        sum += s;
        max = max.max(s);
        count += 1;
    }
    solution.mean_reproj_px = if count > 0 { sum / count as f64 } else { 0.0 };
    solution.max_reproj_px = max;
}

/// Finalize a ≤ 1-frame remainder: no blocks, no stats — the surviving
/// frame keeps its last solved pose and the shared intrinsics.
pub(super) fn finalize_trivial(
    solution: &mut BaSolution,
    images: &[GraphImage],
    active: &[usize],
    rotations: &[Option<Mat3>],
    state: &State,
) {
    solution.shared_focal_px = state.shared_focal;
    solution.k1 = state.k1;
    solution.k2 = state.k2;
    for &global in active {
        let img = &images[global].camera;
        let r = rotations[global].expect("active frames are initialized");
        solution.cameras[global] = Some(Camera::new(
            matrix_to_axis_angle(&r),
            state.shared_focal,
            state.k1,
            state.k2,
            img.width,
            img.height,
        ));
        solution.frame_stats[global] = Some(FrameStats {
            mean_px: 0.0,
            max_px: 0.0,
            median_px: 0.0,
            blocks: 0,
        });
    }
    solution.mean_reproj_px = 0.0;
    solution.max_reproj_px = 0.0;
}

/// Components of the verified graph restricted to `keep`, as
/// `(largest, rest)` — same size-desc/smallest-member ordering as the
/// graph builder.
pub(super) fn largest_subcomponent(graph: &MatchGraph, keep: &[usize]) -> (Vec<usize>, Vec<usize>) {
    let keep_set: std::collections::BTreeSet<usize> = keep.iter().copied().collect();
    let mut adjacency: std::collections::BTreeMap<usize, Vec<usize>> =
        keep.iter().map(|&k| (k, Vec::new())).collect();
    for e in &graph.edges {
        if keep_set.contains(&e.a) && keep_set.contains(&e.b) {
            adjacency.get_mut(&e.a).unwrap().push(e.b);
            adjacency.get_mut(&e.b).unwrap().push(e.a);
        }
    }
    let mut seen: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    let mut components: Vec<Vec<usize>> = Vec::new();
    for &start in keep {
        if seen.contains(&start) {
            continue;
        }
        seen.insert(start);
        let mut queue = std::collections::VecDeque::from([start]);
        let mut comp = Vec::new();
        while let Some(node) = queue.pop_front() {
            comp.push(node);
            for &next in &adjacency[&node] {
                if seen.insert(next) {
                    queue.push_back(next);
                }
            }
        }
        comp.sort_unstable();
        components.push(comp);
    }
    components.sort_by(|x, y| y.len().cmp(&x.len()).then_with(|| x[0].cmp(&y[0])));
    let largest = components.first().cloned().unwrap_or_default();
    let rest = components
        .iter()
        .skip(1)
        .flatten()
        .copied()
        .collect::<Vec<usize>>();
    (largest, rest)
}

pub(super) fn median(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut v: Vec<f64> = values.collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ba::{solve, BaError, BaOptions, DropReason, DroppedFrame};
    use crate::graph::VerifiedEdge;
    use crate::twoview::PixelCorrespondence;

    fn camera() -> Camera {
        Camera::new([0.0; 3], 500.0, 0.0, 0.0, 640, 480)
    }

    fn images(n: usize) -> Vec<GraphImage> {
        (0..n)
            .map(|_| GraphImage {
                camera: camera(),
                prior_rotation: None,
            })
            .collect()
    }

    fn empty_graph(n: usize) -> MatchGraph {
        MatchGraph {
            image_count: n,
            edges: vec![],
            rejected: vec![],
            components: (0..n).map(|i| vec![i]).collect(),
            orphans: (1..n).collect(),
        }
    }

    #[test]
    fn input_validation_errors() {
        let graph = empty_graph(3);
        assert_eq!(
            solve(&images(2), &graph, &BaOptions::default()),
            Err(BaError::ImageCountMismatch {
                images: 2,
                graph: 3
            })
        );
        let opts = BaOptions {
            initial_rotations: Some(vec![None; 2]),
            ..BaOptions::default()
        };
        assert_eq!(
            solve(&images(3), &graph, &opts),
            Err(BaError::InitialRotationsLength {
                given: 2,
                expected: 3
            })
        );
    }

    impl PartialEq for BaSolution {
        fn eq(&self, _: &Self) -> bool {
            unreachable!("BaSolution equality is not meaningful; compare fields")
        }
    }

    #[test]
    fn edgeless_graph_reports_orphans_and_solves_the_root_trivially() {
        let graph = empty_graph(3);
        let solution = solve(&images(3), &graph, &BaOptions::default()).unwrap();
        assert!(solution.cameras[0].is_some(), "largest component survives");
        assert!(solution.cameras[1].is_none() && solution.cameras[2].is_none());
        assert_eq!(
            solution.dropped,
            vec![
                DroppedFrame {
                    index: 1,
                    reason: DropReason::Disconnected
                },
                DroppedFrame {
                    index: 2,
                    reason: DropReason::Disconnected
                },
            ]
        );
        assert_eq!(solution.frame_stats[0].as_ref().unwrap().blocks, 0);
        assert_eq!(solution.mean_reproj_px, 0.0);
        assert!(solution.converged);
    }

    #[test]
    fn empty_input_yields_an_empty_solution() {
        let graph = MatchGraph {
            image_count: 0,
            edges: vec![],
            rejected: vec![],
            components: vec![],
            orphans: vec![],
        };
        let solution = solve(&[], &graph, &BaOptions::default()).unwrap();
        assert!(solution.cameras.is_empty());
        assert!(solution.dropped.is_empty());
    }

    #[test]
    fn largest_subcomponent_splits_and_orders() {
        let mk_edge = |a: usize, b: usize| VerifiedEdge {
            a,
            b,
            rotation: Mat3::identity(),
            inlier_count: 30,
            mean_residual_rad: 0.0,
            inlier_matches: vec![PixelCorrespondence {
                a: (1.0, 1.0),
                b: (2.0, 2.0),
            }],
        };
        // 0–1–2–3 chain plus 4–5; removing 1 splits {0} from {2,3}.
        let graph = MatchGraph {
            image_count: 6,
            edges: vec![mk_edge(0, 1), mk_edge(1, 2), mk_edge(2, 3), mk_edge(4, 5)],
            rejected: vec![],
            components: vec![vec![0, 1, 2, 3], vec![4, 5]],
            orphans: vec![4, 5],
        };
        let (largest, rest) = largest_subcomponent(&graph, &[0, 2, 3]);
        assert_eq!(largest, vec![2, 3]);
        assert_eq!(rest, vec![0]);
        // Blocks: both directions per inlier match of active edges.
        let mut local_of = vec![usize::MAX; 6];
        local_of[2] = 0;
        local_of[3] = 1;
        let blocks = build_blocks(&graph, &local_of);
        assert_eq!(blocks.len(), 2);
        assert_eq!((blocks[0].src, blocks[0].dst), (0, 1));
        assert_eq!((blocks[1].src, blocks[1].dst), (1, 0));
        assert_eq!(blocks[1].p_src, (2.0, 2.0));
    }
}

/// Stage-D cap on prune-and-resolve iterations per gate round. Two
/// passes catch outliers unmasked by the first re-solve; beyond that
/// the working set is as clean as pruning can honestly make it.
pub(super) const PRUNE_ROUNDS_MAX: usize = 2;
/// Per-frame guard: when more than this fraction of a frame's blocks
/// are over the prune threshold, the frame is misaligned rather than
/// polluted — NONE of its correspondences are pruned, so the §5.3 gate
/// judges it on its real residuals instead of a self-cleaned set.
const PRUNE_MAX_FRACTION: f64 = 0.3;

/// Stage-D outlier rejection: identify correspondences whose residual
/// exceeds `threshold_px` in **either** direction and drop both of
/// their directed blocks, honoring the per-frame
/// [`PRUNE_MAX_FRACTION`] guard on both endpoint frames.
///
/// Relies on [`build_blocks`]'s layout: the two directed blocks of one
/// correspondence are adjacent (forward at even index, reverse at odd).
/// Returns `None` when nothing qualifies (the common case after the
/// first pass); otherwise the retained blocks and the number of pruned
/// correspondences.
pub(super) fn prune_outlier_blocks(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &State,
    n_local: usize,
    threshold_px: f64,
) -> Option<(Vec<Block>, usize)> {
    debug_assert_eq!(blocks.len() % 2, 0, "blocks come in directed pairs");
    let n_pairs = blocks.len() / 2;
    let mut over = vec![false; n_pairs];
    let mut blocks_of = vec![0usize; n_local];
    let mut candidates_of = vec![0usize; n_local];
    for pair in 0..n_pairs {
        let fwd = &blocks[pair * 2];
        let rev = &blocks[pair * 2 + 1];
        debug_assert_eq!((fwd.src, fwd.dst), (rev.dst, rev.src));
        blocks_of[fwd.src] += 1;
        blocks_of[fwd.dst] += 1;
        let res = |b: &Block| -> f64 {
            match eval_residual(state, frames, b) {
                Some(r) => (r[0] * r[0] + r[1] * r[1]).sqrt(),
                None => INVALID_BLOCK_RESIDUAL_PX,
            }
        };
        if res(fwd) > threshold_px || res(rev) > threshold_px {
            over[pair] = true;
            candidates_of[fwd.src] += 1;
            candidates_of[fwd.dst] += 1;
        }
    }
    if !over.iter().any(|&o| o) {
        return None;
    }
    // Frames over the fraction guard keep everything.
    let guarded: Vec<bool> = (0..n_local)
        .map(|f| {
            blocks_of[f] > 0
                && (candidates_of[f] as f64) > PRUNE_MAX_FRACTION * (blocks_of[f] as f64)
        })
        .collect();
    let mut retained = Vec::with_capacity(blocks.len());
    let mut pruned = 0usize;
    for pair in 0..n_pairs {
        let fwd = &blocks[pair * 2];
        let keep = !over[pair] || guarded[fwd.src] || guarded[fwd.dst];
        if keep {
            retained.push(blocks[pair * 2]);
            retained.push(blocks[pair * 2 + 1]);
        } else {
            pruned += 1;
        }
    }
    if pruned == 0 {
        return None;
    }
    Some((retained, pruned))
}
