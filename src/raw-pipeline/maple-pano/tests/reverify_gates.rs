//! #1210 gate for [`MatchGraph::reverify`] — the coarse-to-fine second
//! verification pass. Exercises the public contract: payload
//! re-estimation on a geometrically consistent edge, removal + honest
//! reporting of an edge whose matches no longer verify, and the
//! connectivity recompute. (Lives as an integration test, not a
//! `graph.rs` unit test, for the file-size budget.)

use maple_pano::camera::focal_px_for_hfov;
use maple_pano::graph::{GraphImage, MatchGraph, VerifiedEdge};
use maple_pano::math::{matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::robust::RobustOptions;
use maple_pano::twoview::PixelCorrespondence;
use maple_pano::Camera;

fn image_at(yaw_deg: f64) -> GraphImage {
    let r = Mat3::rotation_y(yaw_deg.to_radians());
    GraphImage {
        camera: Camera::new(
            matrix_to_axis_angle(&r),
            focal_px_for_hfov(60.0, 640),
            0.0,
            0.0,
            640,
            480,
        ),
        prior_rotation: None,
    }
}

#[test]
fn reverify_reestimates_good_edges_and_drops_garbage_ones() {
    let images: Vec<GraphImage> = [0.0, 30.0, 60.0].map(image_at).into_iter().collect();

    // Edge (0,1): geometrically consistent matches — every grid pixel
    // of image 0 reprojected into image 1 through the true poses.
    let (cam0, cam1) = (&images[0].camera, &images[1].camera);
    let mut consistent = Vec::new();
    for iy in (32..480).step_by(32) {
        for ix in (32..640).step_by(32) {
            let a = (ix as f64 + 0.5, iy as f64 + 0.5);
            let Some(dir) = cam0.pixel_to_world_dir(a.0, a.1) else {
                continue;
            };
            let Some(b) = cam1.world_dir_to_pixel(dir) else {
                continue;
            };
            if cam1.pixel_in_bounds(b.0, b.1, 8.0) {
                consistent.push(PixelCorrespondence { a, b });
            }
        }
    }
    assert!(
        consistent.len() >= 40,
        "need support, got {}",
        consistent.len()
    );

    // Edge (1,2): garbage — random uncorrelated coordinates (the kind
    // of edge a looser first verification could have admitted).
    let mut rng = SplitMix64::new(42);
    let garbage: Vec<PixelCorrespondence> = (0..40)
        .map(|_| PixelCorrespondence {
            a: (rng.next_range(8.0, 632.0), rng.next_range(8.0, 472.0)),
            b: (rng.next_range(8.0, 632.0), rng.next_range(8.0, 472.0)),
        })
        .collect();

    let n_consistent = consistent.len();
    let mut graph = MatchGraph {
        image_count: 3,
        edges: vec![
            VerifiedEdge {
                a: 0,
                b: 1,
                rotation: Mat3::identity(), // stale on purpose
                inlier_count: n_consistent,
                mean_residual_rad: 1.0,
                inlier_matches: consistent,
            },
            VerifiedEdge {
                a: 1,
                b: 2,
                rotation: Mat3::identity(),
                inlier_count: garbage.len(),
                mean_residual_rad: 1.0,
                inlier_matches: garbage,
            },
        ],
        rejected: Vec::new(),
        components: vec![vec![0, 1, 2]],
        orphans: Vec::new(),
    };

    let summary = graph.reverify(&images, &RobustOptions::default());

    // The garbage edge is gone (reported, not silently dropped) and
    // connectivity reflects it.
    assert_eq!(summary.edges_dropped, 1);
    assert!(summary.matches_dropped >= 40);
    assert_eq!(graph.edges.len(), 1);
    assert_eq!((graph.edges[0].a, graph.edges[0].b), (0, 1));
    assert_eq!(graph.rejected.len(), 1);
    assert_eq!((graph.rejected[0].a, graph.rejected[0].b), (1, 2));
    assert_eq!(graph.components, vec![vec![0, 1], vec![2]]);
    assert_eq!(graph.orphans, vec![2]);

    // The surviving edge's payload was re-estimated: rotation moved
    // off the stale identity onto the true relative rotation
    // R_ab = R_bᵀ·R_a (a −30° yaw), with near-zero residual and the
    // consistent matches retained.
    let expected = images[1]
        .camera
        .rotation
        .transpose()
        .mul_mat(&images[0].camera.rotation);
    assert!(
        graph.edges[0].rotation.max_abs_diff(&expected) < 1e-6,
        "rotation must be re-estimated"
    );
    assert!(graph.edges[0].mean_residual_rad < 1e-9);
    assert_eq!(graph.edges[0].inlier_count, n_consistent);
    assert_eq!(graph.edges[0].inlier_matches.len(), n_consistent);
}
