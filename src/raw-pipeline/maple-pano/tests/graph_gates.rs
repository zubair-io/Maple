//! M1a acceptance gates (#1138) — match-graph construction on synthetic
//! camera sets: ring connectivity with verified edges, and the
//! deliberately disconnected set with orphan reporting.

use std::collections::BTreeSet;

use maple_pano::camera::{focal_px_for_hfov, Camera};
use maple_pano::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage, MatchGraph,
};
use maple_pano::math::{matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, CameraSetOptions, Pattern};
use maple_pano::robust::{RobustOptions, VerifyFailure};
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use maple_pano::twoview::{relative_rotation_ground_truth, rotation_angle_between};

fn realistic_matches() -> CorrespondenceOptions {
    CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 1.0,
        outlier_fraction: 0.3,
        ..Default::default()
    }
}

/// Build the graph with both M1a providers; matches come from the
/// testkit with a per-pair deterministic stream (independent of call
/// order).
fn build(images: &[GraphImage], cams: &[Camera]) -> MatchGraph {
    let corr = realistic_matches();
    build_match_graph(
        images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    )
}

fn images_with_perfect_priors(cams: &[Camera]) -> Vec<GraphImage> {
    cams.iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: Some(c.rotation),
        })
        .collect()
}

/// Gate: full 8-camera ring (45° apart, 60° FOV ⇒ 15° overlap bands).
/// Capture-order + gimbal-prior candidates must produce a connected
/// graph whose 8 ring-adjacent edges (incl. the 7–0 wrap) all verify
/// with ≥ 30 inliers and carry accurate relative rotations.
#[test]
fn gate_ring_full_eight_is_connected_with_all_edges_verified() {
    let opts = CameraSetOptions {
        count: 8,
        pattern: Pattern::Ring { full: true },
        fov_deg: 60.0,
        overlap: 0.5, // ignored by Ring{full}: spacing is 360°/8
        pitch_deg: 0.0,
        jitter_deg: 0.3,
        k1: -0.04,
        k2: 0.01,
        width: 640,
        height: 480,
    };
    let gt = build_camera_set(&opts, &mut SplitMix64::new(11)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|c| c.to_camera()).collect();
    let images = images_with_perfect_priors(&cams);

    let graph = build(&images, &cams);

    assert!(graph.is_connected(), "ring graph must be connected");
    assert!(graph.orphans.is_empty());
    assert_eq!(graph.components, vec![(0..8).collect::<Vec<_>>()]);

    let expected_edges: BTreeSet<(usize, usize)> = (0..8)
        .map(|i| {
            let j = (i + 1) % 8;
            (i.min(j), i.max(j))
        })
        .collect();
    let got_edges: BTreeSet<(usize, usize)> = graph.edges.iter().map(|e| (e.a, e.b)).collect();
    assert_eq!(
        got_edges, expected_edges,
        "exactly the 8 ring-adjacent pairs must verify (90°-separated pairs have no overlap)"
    );

    let mut min_inliers = usize::MAX;
    let mut worst_err = 0.0_f64;
    for e in &graph.edges {
        assert!(
            e.inlier_count >= 30,
            "edge ({},{}) verified with only {} inliers",
            e.a,
            e.b,
            e.inlier_count
        );
        let err = rotation_angle_between(
            &e.rotation,
            &relative_rotation_ground_truth(&cams[e.a], &cams[e.b]),
        )
        .to_degrees();
        assert!(err <= 0.3, "edge ({},{}) R_rel off by {err}°", e.a, e.b);
        eprintln!(
            "gate(ring) edge ({},{}): inliers={} mean_residual={:.4}° R_err={:.5}°",
            e.a,
            e.b,
            e.inlier_count,
            e.mean_residual_rad.to_degrees(),
            err
        );
        min_inliers = min_inliers.min(e.inlier_count);
        worst_err = worst_err.max(err);
    }
    eprintln!(
        "gate(ring): 8/8 edges verified, min inliers {min_inliers} (gate ≥ 30), worst R_rel \
         error {worst_err:.5}°"
    );
}

/// Gate: two angularly distant clusters (4 cameras around yaw 0–90°,
/// 2 cameras around yaw 200–230°) must come back as two components with
/// the smaller cluster reported as orphans — and the capture-order
/// bridge candidate between the clusters rejected for lack of matches,
/// not silently dropped.
#[test]
fn gate_disconnected_clusters_report_components_and_orphans() {
    let cam_at = |yaw_deg: f64| {
        let r = Mat3::rotation_y(yaw_deg.to_radians());
        Camera::new(
            matrix_to_axis_angle(&r),
            focal_px_for_hfov(60.0, 640),
            0.0,
            0.0,
            640,
            480,
        )
    };
    let cams: Vec<Camera> = [0.0, 30.0, 60.0, 90.0, 200.0, 230.0]
        .iter()
        .map(|&y| cam_at(y))
        .collect();
    let images = images_with_perfect_priors(&cams);

    let graph = build(&images, &cams);

    assert!(!graph.is_connected());
    assert_eq!(
        graph.components,
        vec![vec![0, 1, 2, 3], vec![4, 5]],
        "components must split exactly at the cluster boundary"
    );
    assert_eq!(
        graph.orphans,
        vec![4, 5],
        "smaller cluster is the orphan set"
    );

    let got_edges: BTreeSet<(usize, usize)> = graph.edges.iter().map(|e| (e.a, e.b)).collect();
    let expected_edges: BTreeSet<(usize, usize)> =
        [(0, 1), (1, 2), (2, 3), (4, 5)].into_iter().collect();
    assert_eq!(got_edges, expected_edges);
    for e in &graph.edges {
        assert!(
            e.inlier_count >= 30,
            "edge ({},{}) under-supported",
            e.a,
            e.b
        );
    }

    // The capture-order bridge (3,4) spans 110° with 60° FOV — no
    // overlap, no matches — and must be reported as rejected.
    let bridge = graph
        .rejected
        .iter()
        .find(|r| (r.a, r.b) == (3, 4))
        .expect("bridge candidate must be reported, not dropped");
    assert!(matches!(
        bridge.reason,
        VerifyFailure::TooFewCorrespondences { have: 0, .. }
    ));
    eprintln!(
        "gate(disconnected): components {:?}, orphans {:?}, bridge rejected: {}",
        graph.components, graph.orphans, bridge.reason
    );
}

/// Same inputs ⇒ bit-identical graph (edges, rotations, rejections,
/// components), regardless of being built twice. The 60 %-overlap chain
/// (24° steps) also exercises gimbal-nominated skip edges: adjacent
/// pairs overlap by ~36°, one-apart pairs by ~12°, two-apart pairs not
/// at all — so the expected verified set is the 4 adjacency edges plus
/// the 3 skip edges.
#[test]
fn gate_graph_build_is_deterministic() {
    let opts = CameraSetOptions {
        count: 5,
        pattern: Pattern::Ring { full: false },
        fov_deg: 60.0,
        overlap: 0.6,
        pitch_deg: 4.0,
        jitter_deg: 0.5,
        k1: -0.06,
        k2: 0.025,
        width: 640,
        height: 480,
    };
    let gt = build_camera_set(&opts, &mut SplitMix64::new(3)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|c| c.to_camera()).collect();
    let images = images_with_perfect_priors(&cams);

    let g1 = build(&images, &cams);
    let g2 = build(&images, &cams);
    assert_eq!(g1, g2, "graph build must be deterministic");
    assert!(g1.is_connected());
    let got_edges: BTreeSet<(usize, usize)> = g1.edges.iter().map(|e| (e.a, e.b)).collect();
    let expected_edges: BTreeSet<(usize, usize)> =
        [(0, 1), (1, 2), (2, 3), (3, 4), (0, 2), (1, 3), (2, 4)]
            .into_iter()
            .collect();
    assert_eq!(
        got_edges, expected_edges,
        "adjacency + skip edges must verify"
    );
}
