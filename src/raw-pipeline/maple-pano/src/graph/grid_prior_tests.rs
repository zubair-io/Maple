use super::*;
use crate::camera::Camera;
use crate::graph::{MatchGraph, VerifiedEdge};
use crate::math::Mat3;
use crate::robust::VerifyFailure;

fn grid(rows: usize, cols: usize, order: GridOrder) -> GridLayout {
    GridLayout {
        rows,
        cols,
        order,
        diagonals: false,
    }
}

fn images(n: usize) -> Vec<GraphImage> {
    (0..n)
        .map(|_| GraphImage {
            camera: Camera::new([0.0; 3], 500.0, 0.0, 0.0, 640, 480),
            prior_rotation: None,
        })
        .collect()
}

fn cells(layout: &GridLayout, n: usize) -> Vec<(usize, usize)> {
    (0..n)
        .map(|i| layout.cell(i).expect("inside grid"))
        .collect()
}

#[test]
fn raster_maps_row_major_including_a_ragged_last_row() {
    let layout = grid(3, 3, GridOrder::Raster);
    assert_eq!(
        cells(&layout, 8),
        vec![
            (0, 0),
            (0, 1),
            (0, 2),
            (1, 0),
            (1, 1),
            (1, 2),
            (2, 0),
            (2, 1)
        ]
    );
    assert_eq!(layout.cell(9), None);
}

#[test]
fn serpentine_reverses_odd_passes_and_fills_a_ragged_reversed_pass_from_the_far_end() {
    let layout = grid(2, 4, GridOrder::Serpentine);
    assert_eq!(
        cells(&layout, 6),
        vec![(0, 0), (0, 1), (0, 2), (0, 3), (1, 3), (1, 2)]
    );
    let even_ragged = grid(3, 2, GridOrder::Serpentine);
    assert_eq!(
        cells(&even_ragged, 5),
        vec![(0, 0), (0, 1), (1, 1), (1, 0), (2, 0)]
    );
}

#[test]
fn index_inverts_cell_for_both_orders() {
    for order in [GridOrder::Raster, GridOrder::Serpentine] {
        let layout = grid(4, 5, order);
        for i in 0..18 {
            let (r, c) = layout.cell(i).expect("inside grid");
            assert_eq!(layout.index(r, c, 18), Some(i), "{order:?} index {i}");
        }
        let filled = (0..4)
            .flat_map(|r| (0..5).map(move |c| (r, c)))
            .filter(|&(r, c)| layout.index(r, c, 18).is_some())
            .count();
        assert_eq!(filled, 18, "{order:?} must leave exactly two cells empty");
    }
}

#[test]
fn validate_requires_every_pass_but_the_last_to_be_full() {
    let layout = grid(3, 4, GridOrder::Serpentine);
    assert!(layout.validate(12).is_ok());
    assert!(layout.validate(9).is_ok());
    assert!(layout.validate(8).is_err());
    assert!(layout.validate(13).is_err());
    assert!(grid(0, 4, GridOrder::Raster).validate(0).is_err());
}

#[test]
fn serpentine_neighbours_follow_cells_not_capture_order() {
    let layout = grid(2, 3, GridOrder::Serpentine);
    // Cells: 0 1 2 / 5 4 3 — vertical neighbours are (0,5), (1,4), (2,3).
    assert!(layout.is_neighbour(0, 5) && layout.is_neighbour(2, 3));
    assert!(!layout.is_neighbour(0, 3));
    let raster = grid(2, 3, GridOrder::Raster);
    // The raster pass wrap (2 → 3) is a long jump, not a neighbour.
    assert!(!raster.is_neighbour(2, 3) && raster.is_neighbour(0, 3));
}

#[test]
fn provider_emits_neighbours_and_shared_neighbour_closures() {
    let layout = grid(2, 3, GridOrder::Raster);
    let mut got = GridPriorProvider { layout }.candidates(&images(6));
    got.sort_unstable();
    got.dedup();
    assert_eq!(
        got,
        vec![
            (0, 1),
            (0, 2),
            (0, 3),
            (0, 4),
            (1, 2),
            (1, 3),
            (1, 4),
            (1, 5),
            (2, 4),
            (2, 5),
            (3, 4),
            (3, 5),
            (4, 5)
        ]
    );
}

#[test]
fn diagonals_become_neighbours_when_enabled() {
    let layout = GridLayout {
        diagonals: true,
        ..grid(2, 2, GridOrder::Raster)
    };
    assert!(layout.is_neighbour(0, 3) && layout.is_neighbour(1, 2));
    assert_eq!(layout.neighbours(0, 4), vec![1, 2, 3]);
}

#[test]
fn ground_distance_is_haversine_metres() {
    use crate::graph::GroundFootprint;
    let at = |lat_deg, lon_deg| GroundFootprint {
        lat_deg,
        lon_deg,
        diagonal_m: 0.0,
    };
    let one_milli_degree_north = at(48.0, 2.0).distance_m(&at(48.001, 2.0));
    assert!((one_milli_degree_north - 111.195).abs() < 0.01);
    let east = at(48.0, 2.0).distance_m(&at(48.0, 2.001));
    assert!((east - 111.195 * 48.0_f64.to_radians().cos()).abs() < 0.01);
}

#[test]
fn closure_without_a_verified_triangle_is_unconfirmed() {
    let layout = grid(1, 3, GridOrder::Raster);
    let edge = |a, b| VerifiedEdge {
        a,
        b,
        rotation: Mat3::identity(),
        inlier_count: 30,
        mean_residual_rad: 0.0,
        inlier_matches: Vec::new(),
    };
    let mut graph = MatchGraph {
        image_count: 3,
        edges: vec![edge(0, 1), edge(0, 2)],
        rejected: Vec::new(),
        components: vec![vec![0, 1, 2]],
        orphans: Vec::new(),
    };
    let gate = crate::graph::LoopClosureGate {
        layout,
        check: crate::graph::LoopClosureCheck::Rotation,
        ground: &[],
        gps: &[],
    };
    assert_eq!(graph.admit_grid_loop_closures(&images(3), &gate), 1);
    assert_eq!(
        graph.rejected[0].reason,
        VerifyFailure::LoopClosureUnconfirmed {
            best_triangle_error_deg: None
        }
    );
    assert_eq!(graph.components, vec![vec![0, 1], vec![2]]);
    assert_eq!(graph.orphans, vec![2]);
}

#[test]
fn refined_rotation_closure_is_demoted_even_when_each_pair_reverifies() {
    let imgs = images(3);
    let edge = |a: usize, b: usize, degrees: f64| {
        let rotation = Mat3::rotation_y(degrees.to_radians());
        let mut inlier_matches = Vec::new();
        for y in 0..8 {
            for x in 0..10 {
                let pixel = (80.0 + x as f64 * 45.0, 60.0 + y as f64 * 40.0);
                let ray = imgs[a]
                    .camera
                    .pixel_to_camera_dir(pixel.0, pixel.1)
                    .unwrap();
                let target = imgs[b]
                    .camera
                    .world_dir_to_pixel(rotation.mul_vec(ray))
                    .unwrap();
                inlier_matches.push(crate::twoview::PixelCorrespondence {
                    a: pixel,
                    b: target,
                });
            }
        }
        VerifiedEdge {
            a,
            b,
            rotation: Mat3::identity(),
            inlier_count: inlier_matches.len(),
            mean_residual_rad: 0.0,
            inlier_matches,
        }
    };
    let mut graph = MatchGraph {
        image_count: 3,
        edges: vec![edge(0, 1, 0.0), edge(0, 2, 8.0), edge(1, 2, 0.0)],
        rejected: Vec::new(),
        components: vec![vec![0, 1, 2]],
        orphans: Vec::new(),
    };
    let gate = crate::graph::LoopClosureGate {
        layout: grid(1, 3, GridOrder::Raster),
        check: crate::graph::LoopClosureCheck::Rotation,
        ground: &[],
        gps: &[],
    };
    let mut ungated = graph.clone();
    let ungated_result = ungated
        .reverify_grid(&imgs, &crate::robust::RobustOptions::default(), None)
        .unwrap();
    assert_eq!(ungated_result.edges_dropped, 0);
    assert_eq!(ungated.edges.len(), 3);
    let mut lost_support = graph.clone();
    lost_support.edges[2].inlier_matches.clear();
    assert_eq!(graph.admit_grid_loop_closures(&imgs, &gate), 0);
    let result = graph
        .reverify_grid(&imgs, &crate::robust::RobustOptions::default(), Some(&gate))
        .unwrap();
    assert_eq!(result.edges_dropped, 1);
    assert_eq!(result.matches_dropped, 80);
    assert_eq!(
        graph.edges.iter().map(|e| (e.a, e.b)).collect::<Vec<_>>(),
        vec![(0, 1), (1, 2)]
    );
    assert!(matches!(
        graph.rejected[0].reason,
        VerifyFailure::LoopClosureUnconfirmed { .. }
    ));
    let lost = lost_support
        .reverify_grid(&imgs, &crate::robust::RobustOptions::default(), Some(&gate))
        .unwrap();
    assert_eq!(lost.edges_dropped, 2);
    assert_eq!(lost_support.components, vec![vec![0, 1], vec![2]]);
    assert_eq!(lost_support.orphans, vec![2]);
    assert!(lost_support.rejected.iter().any(|e| matches!(
        e.reason,
        VerifyFailure::LoopClosureUnconfirmed {
            best_triangle_error_deg: None
        }
    )));
}

#[test]
fn planar_closure_is_rechecked_after_correspondences_move() {
    let imgs = images(3);
    let edge = |a, b, shift| {
        let inlier_matches: Vec<_> = (0..80)
            .map(|i| {
                let point = (50.0 + (i % 10) as f64 * 40.0, 50.0 + (i / 10) as f64 * 40.0);
                crate::twoview::PixelCorrespondence {
                    a: point,
                    b: (point.0 + shift, point.1),
                }
            })
            .collect();
        VerifiedEdge {
            a,
            b,
            rotation: Mat3::identity(),
            inlier_count: inlier_matches.len(),
            mean_residual_rad: 0.0,
            inlier_matches,
        }
    };
    let mut graph = MatchGraph {
        image_count: 3,
        edges: vec![edge(0, 1, 10.0), edge(0, 2, 20.0), edge(1, 2, 10.0)],
        rejected: Vec::new(),
        components: vec![vec![0, 1, 2]],
        orphans: Vec::new(),
    };
    let gate = crate::graph::LoopClosureGate {
        layout: grid(1, 3, GridOrder::Raster),
        check: crate::graph::LoopClosureCheck::Planar,
        ground: &[],
        gps: &[],
    };
    assert_eq!(graph.admit_grid_loop_closures(&imgs, &gate), 0);
    graph.edges[1]
        .inlier_matches
        .iter_mut()
        .for_each(|m| m.b.0 += 40.0);
    assert_eq!(graph.admit_grid_loop_closures(&imgs, &gate), 1);
    assert_eq!(graph.edges.len(), 2);
    assert!(matches!(
        graph.rejected[0].reason,
        VerifyFailure::LoopClosurePlacementUnconfirmed { .. }
    ));
}
