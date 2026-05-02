use std::collections::HashSet;

use pano_core::matching::{
    build_overlap_graph, OverlapGraphOptions, PairCandidateReason, PoseSummary,
};

const ROWS: usize = 3;
const COLS: usize = 7;

fn deg(value: f64) -> f64 {
    value.to_radians()
}

fn synthetic_grid() -> Vec<PoseSummary> {
    let pitches = [-18.0, 0.0, 18.0];
    let yaws = [-60.0, -40.0, -20.0, 0.0, 20.0, 40.0, 60.0];

    pitches
        .iter()
        .flat_map(|pitch| {
            yaws.iter()
                .map(move |yaw| PoseSummary::new(deg(*yaw), deg(*pitch), 3_200.0, (4_000, 3_000)))
        })
        .collect()
}

fn candidate_pairs_for(
    report: &pano_core::matching::OverlapGraphReport,
    reason: PairCandidateReason,
) -> HashSet<(usize, usize)> {
    report
        .candidates
        .iter()
        .filter(|candidate| candidate.reason == reason)
        .map(|candidate| (candidate.a.min(candidate.b), candidate.a.max(candidate.b)))
        .collect()
}

#[test]
fn grid_selects_horizontal_neighbors_by_yaw_row() {
    let poses = synthetic_grid();
    let report = build_overlap_graph(&poses, &OverlapGraphOptions::default());
    let horizontal = candidate_pairs_for(&report, PairCandidateReason::Horizontal);

    assert_eq!(horizontal.len(), ROWS * (COLS - 1));
    for row in 0..ROWS {
        for col in 0..COLS - 1 {
            let a = row * COLS + col;
            let b = a + 1;
            assert!(
                horizontal.contains(&(a, b)),
                "missing horizontal pair ({a}, {b})"
            );
        }
    }
}

#[test]
fn grid_selects_vertical_nearest_yaw_links() {
    let poses = synthetic_grid();
    let report = build_overlap_graph(&poses, &OverlapGraphOptions::default());
    let vertical = candidate_pairs_for(&report, PairCandidateReason::Vertical);

    assert_eq!(vertical.len(), (ROWS - 1) * COLS);
    for row in 0..ROWS - 1 {
        for col in 0..COLS {
            let a = row * COLS + col;
            let b = (row + 1) * COLS + col;
            assert!(
                vertical.contains(&(a, b)),
                "missing vertical pair ({a}, {b})"
            );
        }
    }
}

#[test]
fn grid_adds_skip_neighbors_when_enabled() {
    let poses = synthetic_grid();
    let options = OverlapGraphOptions {
        enable_skip_neighbors: true,
        ..OverlapGraphOptions::default()
    };
    let report = build_overlap_graph(&poses, &options);
    let skip = candidate_pairs_for(&report, PairCandidateReason::Skip);

    assert_eq!(skip.len(), ROWS * (COLS - 2));
    for row in 0..ROWS {
        for col in 0..COLS - 2 {
            let a = row * COLS + col;
            let b = a + 2;
            assert!(skip.contains(&(a, b)), "missing skip pair ({a}, {b})");
        }
    }
}

#[test]
fn grid_does_not_expand_to_all_pairs() {
    let poses = synthetic_grid();
    let options = OverlapGraphOptions {
        enable_skip_neighbors: true,
        ..OverlapGraphOptions::default()
    };
    let report = build_overlap_graph(&poses, &options);
    let all_pairs = poses.len() * (poses.len() - 1) / 2;

    assert_eq!(report.candidates.len(), 47);
    assert!(
        report.candidates.len() < all_pairs / 3,
        "candidate graph should stay bounded, got {} of {all_pairs}",
        report.candidates.len()
    );
}

#[test]
fn grid_overlap_graph_is_connected() {
    let poses = synthetic_grid();
    let report = build_overlap_graph(&poses, &OverlapGraphOptions::default());

    assert!(report.is_connected);
    assert_eq!(report.component_count, 1);
    assert_eq!(report.largest_component_size, poses.len());
    assert!(report.isolated_pose_indices.is_empty());
    assert_eq!(
        report.connected_components,
        vec![(0..poses.len()).collect::<Vec<_>>()]
    );
}
