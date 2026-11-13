use super::*;
use crate::camera::focal_px_for_hfov;
use crate::math::matrix_to_axis_angle;

fn image_at(yaw_deg: f64, hfov_deg: f64, with_prior: bool) -> GraphImage {
    let r = Mat3::rotation_y(yaw_deg.to_radians());
    let camera = Camera::new(
        matrix_to_axis_angle(&r),
        focal_px_for_hfov(hfov_deg, 640),
        0.0,
        0.0,
        640,
        480,
    );
    GraphImage {
        prior_rotation: with_prior.then_some(r),
        camera,
    }
}

fn edge(a: usize, b: usize) -> VerifiedEdge {
    VerifiedEdge {
        a,
        b,
        rotation: Mat3::identity(),
        inlier_count: 30,
        mean_residual_rad: 0.0,
        inlier_matches: Vec::new(),
    }
}

#[test]
fn capture_order_links_consecutive_frames() {
    let images: Vec<GraphImage> = [0.0, 30.0, 60.0]
        .iter()
        .map(|&y| image_at(y, 60.0, false))
        .collect();
    assert_eq!(
        CaptureOrderProvider.candidates(&images),
        vec![(0, 1), (1, 2)]
    );
    assert!(CaptureOrderProvider.candidates(&images[..1]).is_empty());
    assert!(CaptureOrderProvider.candidates(&[]).is_empty());
}

#[test]
fn gimbal_provider_applies_the_fov_factor_limit() {
    // 60° FOV ⇒ limit 1.5·60° = 90°. Separations: 40°, 40°, 80° —
    // all nominated. With factor 0.5 (limit 30°) none pass.
    let images: Vec<GraphImage> = [0.0, 40.0, 80.0]
        .iter()
        .map(|&y| image_at(y, 60.0, true))
        .collect();
    let full = GimbalPriorProvider::default().candidates(&images);
    assert_eq!(full, vec![(0, 1), (0, 2), (1, 2)]);
    let tight = GimbalPriorProvider {
        max_separation_factor: 0.5,
    }
    .candidates(&images);
    assert!(tight.is_empty());
}

#[test]
fn gimbal_provider_skips_images_without_priors() {
    let images = vec![
        image_at(0.0, 60.0, true),
        image_at(20.0, 60.0, false),
        image_at(40.0, 60.0, true),
    ];
    assert_eq!(
        GimbalPriorProvider::default().candidates(&images),
        vec![(0, 2)]
    );
}

#[test]
fn components_split_sort_and_tiebreak() {
    // 6 nodes: {0,1,2} chained, {3,5} linked, {4} isolated.
    let comps = connected_components(6, &[edge(0, 1), edge(1, 2), edge(3, 5)]);
    assert_eq!(comps, vec![vec![0, 1, 2], vec![3, 5], vec![4]]);
    // Size tie: the component containing the smallest index leads.
    let tied = connected_components(4, &[edge(2, 3), edge(0, 1)]);
    assert_eq!(tied, vec![vec![0, 1], vec![2, 3]]);
    // Empty and single-node graphs.
    assert!(connected_components(0, &[]).is_empty());
    assert_eq!(connected_components(1, &[]), vec![vec![0]]);
}

#[test]
fn builder_dedupes_and_normalizes_provider_output() {
    struct Noisy;
    impl CandidateProvider for Noisy {
        fn name(&self) -> &'static str {
            "noisy"
        }
        fn candidates(&self, _: &[GraphImage]) -> Vec<(usize, usize)> {
            // Duplicates, swapped order, self pair, out of range.
            vec![(1, 0), (0, 1), (2, 2), (0, 9)]
        }
    }
    let images: Vec<GraphImage> = [0.0, 30.0, 60.0]
        .iter()
        .map(|&y| image_at(y, 60.0, false))
        .collect();
    let mut fetched = Vec::new();
    let graph = build_match_graph(
        &images,
        &[&Noisy],
        |a, b| {
            fetched.push((a, b));
            Vec::new()
        },
        &RobustOptions::default(),
    );
    // Only the one valid normalized pair was fetched (once) — and it
    // failed verification with an honest reason.
    assert_eq!(fetched, vec![(0, 1)]);
    assert_eq!(graph.edges, vec![]);
    assert_eq!(graph.rejected.len(), 1);
    assert!(matches!(
        graph.rejected[0].reason,
        VerifyFailure::TooFewCorrespondences { have: 0, .. }
    ));
    // No edges: every image is its own component.
    assert_eq!(graph.components.len(), 3);
    assert_eq!(graph.orphans, vec![1, 2]);
    assert!(!graph.is_connected());
}

#[test]
fn empty_and_single_image_graphs_are_connected() {
    let none: Vec<GraphImage> = Vec::new();
    let g = build_match_graph(
        &none,
        &[&CaptureOrderProvider],
        |_, _| Vec::new(),
        &RobustOptions::default(),
    );
    assert!(g.is_connected() && g.orphans.is_empty() && g.edges.is_empty());

    let one = vec![image_at(0.0, 60.0, true)];
    let g1 = build_match_graph(
        &one,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |_, _| Vec::new(),
        &RobustOptions::default(),
    );
    assert!(g1.is_connected());
    assert_eq!(g1.components, vec![vec![0]]);
    assert!(g1.orphans.is_empty());
}

#[test]
fn pair_seeds_are_stable_and_distinct() {
    assert_eq!(pair_seed(7, 2, 5), pair_seed(7, 2, 5));
    assert_ne!(pair_seed(7, 2, 5), pair_seed(7, 2, 6));
    assert_ne!(pair_seed(7, 2, 5), pair_seed(8, 2, 5));
}
