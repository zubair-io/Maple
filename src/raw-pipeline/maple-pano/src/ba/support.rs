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
/// below this aren't probed — there is nothing material to recover.
const PROBE_MEDIAN_FLOOR_PX: f64 = 0.3;
/// Minimum |mean signed radial residual| / mean residual norm for a
/// frame to count as "systematically radial" (decision §9.2).
const RADIAL_SIGNATURE_MIN: f64 = 0.4;
/// Required relative drop of the frame's median residual under the
/// one-parameter focal probe for the focal to actually be freed.
const PROBE_MEDIAN_DROP_MIN: f64 = 0.25;

/// Decision §9.2 detection. For each frame: measure the radial residual
/// signature in its pixel plane; when it is systematic, run a probe LM
/// that frees only this frame's focal (rotations and shared intrinsics
/// frozen) and keep the override exactly when the frame's median
/// residual drops by ≥ [`PROBE_MEDIAN_DROP_MIN`]. Probes that don't
/// qualify are rolled back, so the state leaves this function carrying
/// overrides only for the returned (freed) frames — a warm start for
/// the joint re-solve.
pub(super) fn focal_fallback_frames(
    blocks: &[Block],
    frames: &[FrameMeta],
    state: &mut State,
    n_local: usize,
    opts: &BaOptions,
    lm_opts: &LmOptions,
) -> Vec<usize> {
    let before = frame_stats(blocks, frames, state, n_local);
    let mut freed = Vec::new();
    for f in 0..n_local {
        if before[f].blocks == 0 || before[f].median_px < PROBE_MEDIAN_FLOOR_PX {
            continue;
        }
        let (mut radial, mut norm) = (0.0_f64, 0.0_f64);
        for block in blocks.iter().filter(|b| b.dst == f) {
            let Some(r) = eval_residual(state, frames, block) else {
                continue;
            };
            let (dx, dy) = (block.p_dst.0 - frames[f].cx, block.p_dst.1 - frames[f].cy);
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1.0 {
                continue;
            }
            radial += (r[0] * dx + r[1] * dy) / len;
            norm += (r[0] * r[0] + r[1] * r[1]).sqrt();
        }
        if norm <= 0.0 || (radial.abs() / norm) < RADIAL_SIGNATURE_MIN {
            continue;
        }
        let saved = state.focal_overrides[f];
        state.focal_overrides[f] = Some(state.focal(f));
        let layout = ParamLayout::focal_probe(n_local, f);
        let _ = minimize(blocks, frames, state, &layout, opts.huber_delta_px, lm_opts);
        let after = frame_stats(blocks, frames, state, n_local);
        if after[f].median_px <= before[f].median_px * (1.0 - PROBE_MEDIAN_DROP_MIN) {
            freed.push(f);
        } else {
            state.focal_overrides[f] = saved;
        }
    }
    freed
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
            Err(BaError::ImageCountMismatch { images: 2, graph: 3 })
        );
        let opts = BaOptions {
            initial_rotations: Some(vec![None; 2]),
            ..BaOptions::default()
        };
        assert_eq!(
            solve(&images(3), &graph, &opts),
            Err(BaError::InitialRotationsLength { given: 2, expected: 3 })
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
                DroppedFrame { index: 1, reason: DropReason::Disconnected },
                DroppedFrame { index: 2, reason: DropReason::Disconnected },
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
