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

/// Multi-row scenes: overlap-graph adjacency must beat file-sequential
/// `(0,1),(1,2),...,(N-2,N-1)` on number-of-pairs.
///
/// Regression-prevention for Stage K: pano-smoke's pair discovery used to
/// gate the overlap graph behind `PANO_USE_OVERLAP_GRAPH=1`, defaulting to
/// the file-sequential chain. For a multi-row sphere pano (file order does
/// not match row-major capture), the chain misses every cross-row
/// neighbour and the global mesh solver gets starved of constraints. The
/// fix made overlap-graph the default. This test pins the strict
/// inequality so a future revert that re-introduces the chain default
/// fails CI.
///
/// Scene: 4 synthetic poses arranged as 2 rows of 2 yaw samples each.
/// File-sequential gives (0,1),(1,2),(2,3) = 3 pairs. Overlap-graph adds
/// the cross-row vertical neighbours (0,2) and (1,3) on top of the
/// horizontal pairs (0,1) and (2,3), so the candidate count goes up.
#[test]
fn multi_row_overlap_graph_beats_file_sequential() {
    let n: usize = 4;
    // Two rows: pitch 0° and pitch 18°. Two yaw samples per row at
    // -10° and +10° — well within the default horizontal/vertical gap
    // budgets and giving plenty of estimated overlap.
    let poses = vec![
        PoseSummary::new(deg(-10.0), deg(0.0), 3_200.0, (4_000, 3_000)), // 0
        PoseSummary::new(deg(10.0), deg(0.0), 3_200.0, (4_000, 3_000)),  // 1
        PoseSummary::new(deg(-10.0), deg(18.0), 3_200.0, (4_000, 3_000)), // 2
        PoseSummary::new(deg(10.0), deg(18.0), 3_200.0, (4_000, 3_000)), // 3
    ];

    let file_sequential_pair_count = n - 1; // (0,1)(1,2)(2,3) = 3
    let report = build_overlap_graph(&poses, &OverlapGraphOptions::default());

    assert!(
        report.candidates.len() > file_sequential_pair_count,
        "overlap graph must produce strictly more pairs than the \
         file-sequential chain on a multi-row scene; got overlap-graph={} \
         vs file-sequential={}",
        report.candidates.len(),
        file_sequential_pair_count,
    );

    // And the cross-row pairs the chain misses MUST be present. (0,2) and
    // (1,3) are the within-yaw vertical neighbours — those are the
    // constraints the global mesh solver actually needs.
    let pair_set: HashSet<(usize, usize)> = report
        .candidates
        .iter()
        .map(|c| (c.a.min(c.b), c.a.max(c.b)))
        .collect();
    assert!(
        pair_set.contains(&(0, 2)),
        "vertical pair (0,2) missing; got {pair_set:?}"
    );
    assert!(
        pair_set.contains(&(1, 3)),
        "vertical pair (1,3) missing; got {pair_set:?}"
    );
}
