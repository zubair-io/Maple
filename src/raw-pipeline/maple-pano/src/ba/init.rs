//! Rotation/focal initialization for the global BA (spec §5.3
//! "Initialization").
//!
//! Three pieces, all advisory in the sense that the LM solve is free to
//! move away from every one of them:
//!
//! - **Spanning-tree propagation**: a maximum-inlier-weight spanning
//!   tree over the verified match graph, relative rotations composed
//!   outward from the root. The tree maximizes total inlier support, so
//!   each propagation hop uses the best-verified relative rotation
//!   available — accumulated drift is what the global solve then
//!   distributes around loop closures.
//! - **Gimbal prior seeding hook**: [`rotation_from_gimbal`] maps the
//!   ingest stage's DJI angles ([`crate::ingest::GimbalPrior`]) into the
//!   crate world frame, and [`align_gauge_to_priors`] applies the single
//!   global rotation best aligning the tree-propagated poses with the
//!   per-frame priors. That is a pure **gauge** transform — relative
//!   geometry is untouched, so the prior can never constrain the
//!   solution (spec §5.1: "advisory: … never constrains") — but it
//!   lands the solve in the prior's (level) world frame, which is what
//!   the leveling stage and human-readable diagnostics want.
//! - **Focal seed**: [`focal_seed_px`] reduces per-frame EXIF-derived
//!   priors ([`crate::ingest::FramePriors::focal_px`]) to one shared
//!   seed (median — robust to a stray wrong EXIF entry). When no frame
//!   in the set carries one, [`crate::ba::focal::homography_focal_seed_px`]
//!   is the fallback (spec §5.3, ticket #1214): [`stitch`](crate::stitch::stitch)
//!   bootstraps cameras from an assumed FOV through
//!   [`crate::camera::focal_px_for_hfov`] just far enough to verify a
//!   match graph, then re-seeds and re-verifies with the
//!   homography-decomposition estimate.
//!
//! # DJI gimbal → world frame mapping
//!
//! The crate world frame is +X east, +Y down, +Z forward (crate docs).
//! DJI writes yaw 0 = North, clockwise-positive seen from above; pitch
//! 0 = level, positive up (−90 = nadir); roll positive = clockwise seen
//! from behind the camera, normally ≈ 0 on a stabilized gimbal. Taking
//! world +Z = North and +X = East, all three map directly onto the
//! crate's rotation generators:
//!
//! ```text
//! R = R_y(yaw) · R_x(pitch) · R_z(roll)
//! ```
//!
//! (`R_y(+90°)` turns +Z to +X — North to East, i.e. clockwise from
//! above — and `R_x(+90°)` tilts +Z to −Y, i.e. up; both match the DJI
//! sign conventions. The roll sign is asserted from the right-hand rule
//! about +Z; it is unconfirmed against hardware with non-zero gimbal
//! roll, which DJI does not produce in normal operation — and the prior
//! is advisory, so a wrong roll sign costs initialization quality, not
//! correctness.)

use crate::graph::MatchGraph;
use crate::ingest::{FramePriors, GimbalPrior};
use crate::math::{Mat3, Vec3};
use crate::twoview::solve_rotation;

/// Map a DJI gimbal attitude into the crate world frame (module docs).
pub fn rotation_from_gimbal(g: &GimbalPrior) -> Mat3 {
    Mat3::rotation_y(g.yaw_deg.to_radians())
        .mul_mat(&Mat3::rotation_x(g.pitch_deg.to_radians()))
        .mul_mat(&Mat3::rotation_z(g.roll_deg.to_radians()))
}

/// Shared focal seed from per-frame ingest priors: the median of the
/// available EXIF-derived `focal_px` values. `None` when no frame
/// carries one.
pub fn focal_seed_px(priors: &[FramePriors]) -> Option<f64> {
    let mut focals: Vec<f64> = priors.iter().filter_map(|p| p.focal_px).collect();
    if focals.is_empty() {
        return None;
    }
    focals.sort_by(f64::total_cmp);
    let n = focals.len();
    Some(if n % 2 == 1 {
        focals[n / 2]
    } else {
        0.5 * (focals[n / 2 - 1] + focals[n / 2])
    })
}

/// Propagate camera-to-world rotations over a maximum-inlier-weight
/// spanning tree of the verified graph, rooted at the smallest member
/// of the **largest component** (`R_root = I`).
///
/// Returns one entry per image: `Some(R)` for members of the largest
/// component, `None` for everything else (the orphans the caller drops
/// as `Disconnected`). Edge rotations follow the [`crate::twoview`]
/// convention `d_b = R_ab · d_a`, so a child `b` of parent `a` gets
/// `R_b = R_a · R_abᵀ` (and `R_a = R_b · R_ab` walking the other way).
///
/// Deterministic: Kruskal over edges sorted by `(inlier_count desc, a,
/// b)`, then BFS in sorted adjacency order.
pub fn spanning_tree_rotations(graph: &MatchGraph) -> Vec<Option<Mat3>> {
    let n = graph.image_count;
    let mut out = vec![None; n];
    let Some(component) = graph.components.first() else {
        return out;
    };
    let root = component[0];

    // Kruskal on (inlier_count desc, a, b asc).
    let mut order: Vec<usize> = (0..graph.edges.len()).collect();
    order.sort_by(|&x, &y| {
        let (ex, ey) = (&graph.edges[x], &graph.edges[y]);
        ey.inlier_count
            .cmp(&ex.inlier_count)
            .then(ex.a.cmp(&ey.a))
            .then(ex.b.cmp(&ey.b))
    });
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut Vec<usize>, mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    // Tree adjacency: (neighbor, edge index).
    let mut adjacency: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n];
    for idx in order {
        let e = &graph.edges[idx];
        let (ra, rb) = (find(&mut parent, e.a), find(&mut parent, e.b));
        if ra != rb {
            parent[ra] = rb;
            adjacency[e.a].push((e.b, idx));
            adjacency[e.b].push((e.a, idx));
        }
    }
    for nbrs in &mut adjacency {
        nbrs.sort_unstable();
    }

    // BFS propagation from the root.
    out[root] = Some(Mat3::identity());
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(node) = queue.pop_front() {
        let r_node = out[node].expect("visited nodes have rotations");
        for &(next, edge_idx) in &adjacency[node] {
            if out[next].is_some() {
                continue;
            }
            let e = &graph.edges[edge_idx];
            // R_ab = R_bᵀ·R_a  ⇒  R_b = R_a·R_abᵀ,  R_a = R_b·R_ab.
            let r_next = if node == e.a {
                r_node.mul_mat(&e.rotation.transpose())
            } else {
                r_node.mul_mat(&e.rotation)
            };
            out[next] = Some(r_next);
            queue.push_back(next);
        }
    }
    out
}

/// Apply the single global rotation `G` minimizing
/// `Σᵢ ‖prior_i − G·R_i‖²` over frames carrying both a solved rotation
/// and a prior (Wahba on the matrix columns, reusing the q-method
/// solver), then return it. Pure gauge transform — see module docs.
/// `None` (and no change) when fewer than one frame has both, or the
/// alignment is degenerate.
pub fn align_gauge_to_priors(
    rotations: &mut [Option<Mat3>],
    priors: &[Option<Mat3>],
) -> Option<Mat3> {
    assert_eq!(rotations.len(), priors.len());
    let mut pairs: Vec<(Vec3, Vec3)> = Vec::new();
    for (r, p) in rotations.iter().zip(priors) {
        let (Some(r), Some(p)) = (r, p) else { continue };
        for col in 0..3 {
            pairs.push((
                Vec3::new(r.0[0][col], r.0[1][col], r.0[2][col]),
                Vec3::new(p.0[0][col], p.0[1][col], p.0[2][col]),
            ));
        }
    }
    let g = solve_rotation(&pairs, None)?;
    for r in rotations.iter_mut().flatten() {
        *r = g.mul_mat(r);
    }
    Some(g)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{MatchGraph, VerifiedEdge};
    use crate::math::{axis_angle_to_matrix, matrix_to_axis_angle};
    use crate::twoview::rotation_angle_between;

    fn edge(a: usize, b: usize, r_a: &Mat3, r_b: &Mat3, inliers: usize) -> VerifiedEdge {
        VerifiedEdge {
            a,
            b,
            rotation: r_b.transpose().mul_mat(r_a),
            inlier_count: inliers,
            mean_residual_rad: 0.0,
            inlier_matches: Vec::new(),
        }
    }

    fn graph_of(n: usize, edges: Vec<VerifiedEdge>) -> MatchGraph {
        // Recompute components the same way the builder sorts them:
        // size desc, smallest member tiebreak.
        let mut adjacency = vec![Vec::new(); n];
        for e in &edges {
            adjacency[e.a].push(e.b);
            adjacency[e.b].push(e.a);
        }
        let mut seen = vec![false; n];
        let mut components: Vec<Vec<usize>> = Vec::new();
        for start in 0..n {
            if seen[start] {
                continue;
            }
            seen[start] = true;
            let mut queue = std::collections::VecDeque::from([start]);
            let mut comp = vec![];
            while let Some(x) = queue.pop_front() {
                comp.push(x);
                for &y in &adjacency[x] {
                    if !seen[y] {
                        seen[y] = true;
                        queue.push_back(y);
                    }
                }
            }
            comp.sort_unstable();
            components.push(comp);
        }
        components.sort_by(|x, y| y.len().cmp(&x.len()).then_with(|| x[0].cmp(&y[0])));
        let orphans = if components.len() > 1 {
            let mut o: Vec<usize> = components[1..].iter().flatten().copied().collect();
            o.sort_unstable();
            o
        } else {
            Vec::new()
        };
        MatchGraph {
            image_count: n,
            edges,
            rejected: Vec::new(),
            components,
            orphans,
        }
    }

    fn gt_rotations(n: usize) -> Vec<Mat3> {
        (0..n)
            .map(|i| {
                axis_angle_to_matrix([0.02 * i as f64, 0.4 * i as f64, -0.03 * (i % 3) as f64])
            })
            .collect()
    }

    #[test]
    fn tree_propagation_reproduces_exact_relative_geometry() {
        // Chain 0–1–2–3 plus a redundant low-weight 0–3 edge that must
        // not enter the tree (its rotation is corrupted to prove it).
        let gt = gt_rotations(4);
        let mut bad = edge(0, 3, &gt[0], &gt[3], 10);
        bad.rotation = axis_angle_to_matrix([0.5, 0.5, 0.5]);
        let graph = graph_of(
            4,
            vec![
                edge(0, 1, &gt[0], &gt[1], 100),
                edge(1, 2, &gt[1], &gt[2], 90),
                edge(2, 3, &gt[2], &gt[3], 80),
                bad,
            ],
        );
        let init = spanning_tree_rotations(&graph);
        // Root gauge: init_0 = I, so expected_i = R_0ᵀ·... composed in
        // the root frame: init_i = gauge·gt_i with gauge = gt_0⁻¹.
        let gauge = gt[0].transpose();
        for i in 0..4 {
            let r = init[i].expect("all frames in one component");
            let expected = gauge.mul_mat(&gt[i]);
            assert!(
                rotation_angle_between(&r, &expected) < 1e-12,
                "frame {i} off by {} rad",
                rotation_angle_between(&r, &expected)
            );
        }
    }

    #[test]
    fn max_weight_edges_win_the_tree() {
        // Triangle 0–1–2: the (0,2) edge is corrupted but has the LOWEST
        // weight, so propagation must go 0→1→2 and stay exact.
        let gt = gt_rotations(3);
        let mut weak = edge(0, 2, &gt[0], &gt[2], 31);
        weak.rotation = axis_angle_to_matrix([0.3, -0.2, 0.1]);
        let graph = graph_of(
            3,
            vec![
                edge(0, 1, &gt[0], &gt[1], 200),
                edge(1, 2, &gt[1], &gt[2], 150),
                weak,
            ],
        );
        let init = spanning_tree_rotations(&graph);
        let gauge = gt[0].transpose();
        let r2 = init[2].unwrap();
        assert!(rotation_angle_between(&r2, &gauge.mul_mat(&gt[2])) < 1e-12);
    }

    #[test]
    fn orphans_get_no_rotation() {
        let gt = gt_rotations(5);
        let graph = graph_of(
            5,
            vec![
                edge(0, 1, &gt[0], &gt[1], 100),
                edge(1, 2, &gt[1], &gt[2], 90),
                edge(3, 4, &gt[3], &gt[4], 100),
            ],
        );
        let init = spanning_tree_rotations(&graph);
        assert!(init[0].is_some() && init[1].is_some() && init[2].is_some());
        assert!(init[3].is_none() && init[4].is_none());
        // Empty graph: nothing solved.
        let empty = graph_of(0, vec![]);
        assert!(spanning_tree_rotations(&empty).is_empty());
    }

    #[test]
    fn gauge_alignment_recovers_the_prior_frame() {
        // Tree init lives in the root frame; priors are the ground truth.
        // After alignment the rotations must match the priors exactly
        // (exact inputs), even with priors missing on some frames.
        let gt = gt_rotations(4);
        let gauge = gt[0].transpose();
        let mut rotations: Vec<Option<Mat3>> = gt.iter().map(|r| Some(gauge.mul_mat(r))).collect();
        let priors = vec![Some(gt[0]), None, Some(gt[2]), None];
        let g = align_gauge_to_priors(&mut rotations, &priors).expect("well-posed");
        // G must invert the gauge.
        assert!(rotation_angle_between(&g, &gt[0]) < 1e-9);
        for i in 0..4 {
            assert!(
                rotation_angle_between(&rotations[i].unwrap(), &gt[i]) < 1e-9,
                "frame {i} not back in the prior frame"
            );
        }
    }

    #[test]
    fn gauge_alignment_without_priors_is_a_no_op() {
        let gt = gt_rotations(2);
        let mut rotations: Vec<Option<Mat3>> = gt.iter().copied().map(Some).collect();
        let before = rotations.clone();
        assert!(align_gauge_to_priors(&mut rotations, &[None, None]).is_none());
        for (a, b) in rotations.iter().zip(&before) {
            assert_eq!(a.unwrap().0, b.unwrap().0);
        }
    }

    #[test]
    fn gimbal_mapping_matches_the_documented_conventions() {
        // Yaw 90° (East): optical axis +Z → +X.
        let east = rotation_from_gimbal(&GimbalPrior {
            yaw_deg: 90.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
        });
        let axis = east.mul_vec(Vec3::new(0.0, 0.0, 1.0));
        assert!((axis - Vec3::new(1.0, 0.0, 0.0)).norm() < 1e-12);

        // Pitch −90° (nadir): optical axis → +Y (down).
        let nadir = rotation_from_gimbal(&GimbalPrior {
            yaw_deg: 0.0,
            pitch_deg: -90.0,
            roll_deg: 0.0,
        });
        let axis = nadir.mul_vec(Vec3::new(0.0, 0.0, 1.0));
        assert!((axis - Vec3::new(0.0, 1.0, 0.0)).norm() < 1e-12);

        // Roll leaves the optical axis alone and tilts the x-axis.
        let rolled = rotation_from_gimbal(&GimbalPrior {
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 30.0,
        });
        let fwd = rolled.mul_vec(Vec3::new(0.0, 0.0, 1.0));
        assert!((fwd - Vec3::new(0.0, 0.0, 1.0)).norm() < 1e-12);
        let x_axis = rolled.mul_vec(Vec3::new(1.0, 0.0, 0.0));
        assert!((x_axis.y - 0.5).abs() < 1e-12, "30° roll ⇒ x_y = sin 30°");
    }

    #[test]
    fn focal_seed_is_the_median_of_available_priors() {
        let p = |f: Option<f64>| FramePriors {
            focal_px: f,
            ..Default::default()
        };
        assert_eq!(focal_seed_px(&[]), None);
        assert_eq!(focal_seed_px(&[p(None), p(None)]), None);
        assert_eq!(focal_seed_px(&[p(Some(3650.0))]), Some(3650.0));
        // Median is robust to one wrong EXIF entry.
        assert_eq!(
            focal_seed_px(&[p(Some(3650.0)), p(Some(3652.0)), p(Some(9999.0))]),
            Some(3652.0)
        );
        assert_eq!(
            focal_seed_px(&[p(Some(100.0)), p(Some(200.0))]),
            Some(150.0)
        );
    }

    #[test]
    fn tree_init_then_alignment_threads_through_matrix_to_axis_angle() {
        // Smoke the full init path the solver uses: tree → align →
        // axis-angle round trip stays on the same rotations.
        let gt = gt_rotations(3);
        let graph = graph_of(
            3,
            vec![
                edge(0, 1, &gt[0], &gt[1], 50),
                edge(1, 2, &gt[1], &gt[2], 50),
            ],
        );
        let mut init = spanning_tree_rotations(&graph);
        let priors: Vec<Option<Mat3>> = gt.iter().copied().map(Some).collect();
        align_gauge_to_priors(&mut init, &priors).unwrap();
        for (r, want) in init.iter().zip(&gt) {
            let r = r.unwrap();
            let round = axis_angle_to_matrix(matrix_to_axis_angle(&r));
            assert!(rotation_angle_between(&round, want) < 1e-9);
        }
    }
}
