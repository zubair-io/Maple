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
    GroundFootprint, LoopClosureCheck, LoopClosureGate, MatchGraph,
};
use maple_pano::math::{matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::robust::{RobustOptions, VerifyFailure};
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use maple_pano::twoview::{
    relative_rotation_ground_truth, rotation_angle_between, PixelCorrespondence,
};

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

fn graph_images(cams: &[Camera]) -> Vec<GraphImage> {
    cams.iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: None,
        })
        .collect()
}

fn build(cams: &[Camera], layout: &GridLayout) -> MatchGraph {
    let images = graph_images(cams);
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
    let rejected = graph.admit_grid_loop_closures(
        &graph_images(&cams),
        &LoopClosureGate {
            layout,
            check: LoopClosureCheck::Rotation,
            ground: &[],
        },
    );

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
    let images = graph_images(&vec![camera_with(Mat3::identity()); 400]);
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

// ── Tile path: translation-dominant nadir survey ─────────────────────────

const STEP_X_PX: f64 = 300.0;
const STEP_Y_PX: f64 = 220.0;
const METRES_PER_PX: f64 = 0.1;
const NEAR_FALSE_PLANAR: (usize, usize) = (0, 6);
const PERIOD_SHIFT_PX: f64 = 60.0;

/// Ground-plane origin (px) of each frame: a pure translation grid with
/// a little flight jitter, the shape the tile strategy serves.
fn ground_origins(layout: &GridLayout) -> Vec<(f64, f64)> {
    let mut rng = SplitMix64::new(0x4519_7117);
    (0..FRAMES)
        .map(|i| {
            let (row, col) = layout.cell(i).expect("index inside the grid");
            (
                col as f64 * STEP_X_PX + rng.next_range(-6.0, 6.0),
                row as f64 * STEP_Y_PX + rng.next_range(-6.0, 6.0),
            )
        })
        .collect()
}

/// Correspondences for a ground translation `offset = origin_b − origin_a`:
/// `b = a − offset`, 0.5 px noise, 25 % outliers.
fn translation_matches(offset: (f64, f64), seed: u64) -> Vec<PixelCorrespondence> {
    let mut rng = SplitMix64::new(seed);
    let (w, h) = (640.0, 480.0);
    let inside = |x: f64, y: f64| (8.0..w - 8.0).contains(&x) && (8.0..h - 8.0).contains(&y);
    let supports: Vec<(f64, f64)> = (0..4000)
        .map(|_| (rng.next_range(8.0, w - 8.0), rng.next_range(8.0, h - 8.0)))
        .filter(|&(x, y)| inside(x - offset.0, y - offset.1))
        .take(200)
        .collect();
    supports
        .into_iter()
        .map(|(x, y)| {
            let b = if rng.next_range(0.0, 1.0) < 0.25 {
                (rng.next_range(8.0, w - 8.0), rng.next_range(8.0, h - 8.0))
            } else {
                (
                    x - offset.0 + rng.next_range(-0.5, 0.5),
                    y - offset.1 + rng.next_range(-0.5, 0.5),
                )
            };
            PixelCorrespondence { a: (x, y), b }
        })
        .collect()
}

fn build_translation_grid(
    layout: &GridLayout,
    origins: &[(f64, f64)],
) -> (Vec<GraphImage>, MatchGraph) {
    let unit_focal = Camera::new([0.0; 3], 1.0, 0.0, 0.0, 640, 480);
    let images = graph_images(&vec![unit_focal; FRAMES]);
    let graph = build_match_graph(
        &images,
        &[
            &GridPriorProvider { layout: *layout },
            &Planted(vec![FAR_FALSE]),
        ],
        |a, b| {
            let truth = (origins[b].0 - origins[a].0, origins[b].1 - origins[a].1);
            let offset = match (a, b) {
                FAR_FALSE => (100.0, 50.0),
                NEAR_FALSE_PLANAR => (truth.0 + PERIOD_SHIFT_PX, truth.1),
                _ => truth,
            };
            translation_matches(offset, 0x4519 ^ ((a as u64) << 32) ^ b as u64)
        },
        &RobustOptions::default(),
    );
    (images, graph)
}

fn ground(origins: &[(f64, f64)]) -> Vec<Option<GroundFootprint>> {
    const EARTH_RADIUS_M: f64 = 6_371_008.8;
    let (lat0, lon0) = (48.8694_f64, 2.3386_f64);
    origins
        .iter()
        .map(|&(x, y)| {
            let (east_m, north_m) = (x * METRES_PER_PX, -y * METRES_PER_PX);
            Some(GroundFootprint {
                lat_deg: lat0 + (north_m / EARTH_RADIUS_M).to_degrees(),
                lon_deg: lon0 + (east_m / (EARTH_RADIUS_M * lat0.to_radians().cos())).to_degrees(),
                diagonal_m: 640.0_f64.hypot(480.0) * METRES_PER_PX,
            })
        })
        .collect()
}

#[test]
fn gate_translation_grid_planar_check_keeps_true_closures_and_rejects_false_ones() {
    let layout = layout();
    let origins = ground_origins(&layout);
    let (images, mut graph) = build_translation_grid(&layout, &origins);
    let before = edge_set(&graph);
    assert!(
        before.contains(&FAR_FALSE) && before.contains(&NEAR_FALSE_PLANAR),
        "both planted edges must pass unit-focal verification, got {before:?}"
    );
    let footprints = ground(&origins);
    let rejected = graph.admit_grid_loop_closures(
        &images,
        &LoopClosureGate {
            layout,
            check: LoopClosureCheck::Planar,
            ground: &footprints,
        },
    );

    let edges = edge_set(&graph);
    let neighbours: BTreeSet<(usize, usize)> = (0..FRAMES)
        .flat_map(|a| ((a + 1)..FRAMES).map(move |b| (a, b)))
        .filter(|&(a, b)| layout.is_neighbour(a, b))
        .collect();
    let missing: Vec<_> = neighbours.difference(&edges).collect();
    assert!(missing.is_empty(), "true neighbour edges lost: {missing:?}");

    let reason = |pair: (usize, usize)| {
        graph
            .rejected
            .iter()
            .find(|r| (r.a, r.b) == pair)
            .map(|r| r.reason.clone())
            .expect("planted edge must be reported as rejected")
    };
    let far = reason(FAR_FALSE);
    assert!(
        matches!(far, VerifyFailure::LoopClosureBeyondGroundFootprint { distance_m, limit_m } if distance_m > limit_m),
        "far false edge rejected for the wrong reason: {far:?}"
    );
    let near = reason(NEAR_FALSE_PLANAR);
    let VerifyFailure::LoopClosurePlacementUnconfirmed {
        best_corner_error_px: Some(err_px),
    } = near
    else {
        panic!("near false edge rejected for the wrong reason: {near:?}");
    };
    assert!(
        err_px > 40.0,
        "planted {PERIOD_SHIFT_PX} px shift measured as {err_px:.2} px"
    );

    let closures: Vec<(usize, usize)> = edges
        .iter()
        .copied()
        .filter(|&(a, b)| !layout.is_neighbour(a, b))
        .collect();
    let true_closure_candidates = before
        .iter()
        .filter(|&&(a, b)| {
            !layout.is_neighbour(a, b) && (a, b) != FAR_FALSE && (a, b) != NEAR_FALSE_PLANAR
        })
        .count();
    assert_eq!(
        closures.len(),
        true_closure_candidates,
        "every verified true loop closure must survive the planar gate"
    );
    assert!(
        closures.len() >= 8,
        "only {} closures verified",
        closures.len()
    );
    assert!(graph.is_connected());
    eprintln!(
        "gate(grid, tile): {} neighbours kept, {} true loop closures admitted, {rejected} \
         rejected; far false edge {far}; near false edge corner error {err_px:.2} px",
        neighbours.len(),
        closures.len(),
    );
}

#[test]
fn translation_grid_without_gps_falls_back_to_grid_cells() {
    let layout = layout();
    let origins = ground_origins(&layout);
    let (images, mut graph) = build_translation_grid(&layout, &origins);
    graph.admit_grid_loop_closures(
        &images,
        &LoopClosureGate {
            layout,
            check: LoopClosureCheck::Planar,
            ground: &[],
        },
    );
    let far = graph
        .rejected
        .iter()
        .find(|r| (r.a, r.b) == FAR_FALSE)
        .map(|r| r.reason.clone());
    assert_eq!(
        far,
        Some(VerifyFailure::LoopClosureOutsideFootprint { cells: 3 })
    );
    assert!(!edge_set(&graph).contains(&NEAR_FALSE_PLANAR));
}
