//! #4519 acceptance gate — structured grid prior on a synthetic
//! serpentine capture with planted false loop closures.
//!
//! A 4 × 4 serpentine grid holds 14 frames (ragged, reversed last row).
//! Two false edges are planted with fabricated correspondences that
//! verify cleanly in isolation: one long-range (outside the grid
//! footprint) and one short-range whose relative rotation disagrees
//! with the two neighbour edges that close a triangle with it. The grid
//! gate must reject both and keep every true neighbour edge.

use std::collections::BTreeSet;

use maple_pano::camera::{focal_px_for_hfov, Camera};
use maple_pano::graph::{
    build_match_graph, CandidateProvider, GraphImage, GridLayout, GridOrder, GridPriorProvider,
    MatchGraph,
};
use maple_pano::math::{matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::robust::{RobustOptions, VerifyFailure};
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use maple_pano::twoview::{relative_rotation_ground_truth, rotation_angle_between};

const FRAMES: usize = 14;
const FAR_FALSE: (usize, usize) = (0, 12);
const NEAR_FALSE: (usize, usize) = (0, 2);

fn layout() -> GridLayout {
    GridLayout {
        rows: 4,
        cols: 4,
        order: GridOrder::Serpentine,
        diagonals: false,
    }
}

fn camera_with(rotation: Mat3) -> Camera {
    Camera::new(
        matrix_to_axis_angle(&rotation),
        focal_px_for_hfov(60.0, 640),
        0.0,
        0.0,
        640,
        480,
    )
}

fn grid_cameras(layout: &GridLayout) -> Vec<Camera> {
    (0..FRAMES)
        .map(|i| {
            let (row, col) = layout.cell(i).expect("index inside the grid");
            camera_with(
                Mat3::rotation_y((col as f64 * 20.0).to_radians())
                    .mul_mat(&Mat3::rotation_x((row as f64 * 15.0).to_radians())),
            )
        })
        .collect()
}

fn perturbed(base: &Camera, yaw_deg: f64) -> Camera {
    camera_with(
        base.rotation
            .mul_mat(&Mat3::rotation_y(yaw_deg.to_radians())),
    )
}

struct Planted(Vec<(usize, usize)>);

impl CandidateProvider for Planted {
    fn name(&self) -> &'static str {
        "planted"
    }
    fn candidates(&self, _: &[GraphImage]) -> Vec<(usize, usize)> {
        self.0.clone()
    }
}

fn build(cams: &[Camera], layout: &GridLayout) -> MatchGraph {
    let images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: None,
        })
        .collect();
    let corr = CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 1.0,
        outlier_fraction: 0.3,
        ..Default::default()
    };
    build_match_graph(
        &images,
        &[
            &GridPriorProvider { layout: *layout },
            &Planted(vec![FAR_FALSE]),
        ],
        |a, b| {
            let mut rng = SplitMix64::new(0x4519 ^ ((a as u64) << 32) ^ b as u64);
            let target = match (a, b) {
                FAR_FALSE => perturbed(&cams[a], 12.0),
                NEAR_FALSE => perturbed(&cams[b], 8.0),
                _ => cams[b].clone(),
            };
            generate_pair_correspondences(&cams[a], &target, &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    )
}

fn edge_set(graph: &MatchGraph) -> BTreeSet<(usize, usize)> {
    graph.edges.iter().map(|e| (e.a, e.b)).collect()
}

#[test]
fn planted_false_edges_verify_before_the_grid_gate() {
    let layout = layout();
    let graph = build(&grid_cameras(&layout), &layout);
    let edges = edge_set(&graph);
    assert!(
        edges.contains(&FAR_FALSE) && edges.contains(&NEAR_FALSE),
        "both planted edges must pass two-view verification on their own, got {edges:?}"
    );
}

#[test]
fn gate_serpentine_grid_rejects_false_loop_closures_and_keeps_neighbours() {
    let layout = layout();
    let cams = grid_cameras(&layout);
    let mut graph = build(&cams, &layout);
    let rejected = graph.admit_grid_loop_closures(&layout);

    let edges = edge_set(&graph);
    let neighbours: BTreeSet<(usize, usize)> = (0..FRAMES)
        .flat_map(|a| ((a + 1)..FRAMES).map(move |b| (a, b)))
        .filter(|&(a, b)| layout.is_neighbour(a, b))
        .collect();
    assert_eq!(neighbours.len(), 20, "4×4 grid minus two cells");
    let missing: Vec<_> = neighbours.difference(&edges).collect();
    assert!(missing.is_empty(), "true neighbour edges lost: {missing:?}");

    assert!(!edges.contains(&FAR_FALSE) && !edges.contains(&NEAR_FALSE));
    let reason = |pair: (usize, usize)| {
        graph
            .rejected
            .iter()
            .find(|r| (r.a, r.b) == pair)
            .map(|r| r.reason.clone())
            .expect("planted edge must be reported as rejected")
    };
    assert_eq!(
        reason(FAR_FALSE),
        VerifyFailure::LoopClosureOutsideFootprint { cells: 3 }
    );
    let near = reason(NEAR_FALSE);
    let VerifyFailure::LoopClosureUnconfirmed {
        best_triangle_error_deg: Some(err),
    } = near
    else {
        panic!("near false edge rejected for the wrong reason: {near:?}");
    };
    assert!(err > 5.0, "planted 8° error measured as {err:.3}°");

    let loop_closures: Vec<_> = graph
        .edges
        .iter()
        .filter(|e| !layout.is_neighbour(e.a, e.b))
        .collect();
    assert!(
        loop_closures.len() >= 10,
        "true loop closures must survive the gate, kept {}",
        loop_closures.len()
    );
    let worst_closure_err = loop_closures
        .iter()
        .map(|e| {
            rotation_angle_between(
                &e.rotation,
                &relative_rotation_ground_truth(&cams[e.a], &cams[e.b]),
            )
            .to_degrees()
        })
        .fold(0.0_f64, f64::max);
    assert!(
        worst_closure_err < 0.5,
        "admitted closure off by {worst_closure_err}°"
    );
    assert!(graph.is_connected());
    eprintln!(
        "gate(grid): {} neighbour edges kept, {} loop closures admitted (worst R err \
         {worst_closure_err:.4}°), {rejected} rejected; near false edge triangle error {err:.3}°",
        neighbours.len(),
        loop_closures.len(),
    );
}

#[test]
fn grid_provider_nominates_linearly_many_pairs() {
    let layout = GridLayout {
        rows: 20,
        cols: 20,
        order: GridOrder::Serpentine,
        diagonals: true,
    };
    let images: Vec<GraphImage> = (0..400)
        .map(|_| GraphImage {
            camera: camera_with(Mat3::identity()),
            prior_rotation: None,
        })
        .collect();
    let pairs = GridPriorProvider { layout }.candidates(&images);
    let unique: BTreeSet<(usize, usize)> =
        pairs.iter().map(|&(i, j)| (i.min(j), i.max(j))).collect();
    assert!(
        unique.len() <= 12 * images.len(),
        "{} candidates for {} frames",
        unique.len(),
        images.len()
    );
}
