//! Correctness tests for [`super::BkGraph`], ported (trimmed) from the
//! `pano-core` prototype (PR #17). Covers the textbook min-cut cases plus
//! one heterogeneous-capacity probe that exercises the parent-edge-cycle
//! mitigation documented on the parent module.

use super::BkGraph;

#[test]
fn trivial_single_node_equal_caps() {
    let mut g = BkGraph::with_capacity(1, 0);
    let a = g.add_node();
    g.add_terminal(a, 10, 10);
    g.finalize();
    assert_eq!(g.solve(), 10);
}

/// S --10--> A --5--> B --10--> T. Max flow = 5.
#[test]
fn two_node_edge_bottleneck() {
    let mut g = BkGraph::with_capacity(2, 1);
    let a = g.add_node();
    let b = g.add_node();
    g.add_terminal(a, 10, 0);
    g.add_terminal(b, 0, 10);
    g.add_edge(a, b, 5, 0);
    g.finalize();
    assert_eq!(g.solve(), 5);
    assert!(g.is_in_source(a));
    assert!(!g.is_in_source(b));
}

/// Symmetric cap-5 edge. Max flow = 5.
#[test]
fn two_node_symmetric_edge() {
    let mut g = BkGraph::with_capacity(2, 1);
    let a = g.add_node();
    let b = g.add_node();
    g.add_terminal(a, 100, 0);
    g.add_terminal(b, 0, 100);
    g.add_edge(a, b, 5, 5);
    g.finalize();
    assert_eq!(g.solve(), 5);
}

/// Diamond: pre-flow=5, augment 3 -> total 8.
#[test]
fn diamond_graph() {
    let mut g = BkGraph::with_capacity(2, 1);
    let a = g.add_node();
    let b = g.add_node();
    g.add_terminal(a, 10, 5);
    g.add_terminal(b, 0, 7);
    g.add_edge(a, b, 3, 0);
    g.finalize();
    assert_eq!(g.solve(), 8);
}

/// n x n grid, unit-capacity horizontal/vertical edges, source on row 0,
/// sink on row n-1: min cut = n (one unit edge per column).
fn grid_horizontal_cut(n: usize) -> i64 {
    let mut g = BkGraph::with_capacity(n * n, n * (n - 1) * 2);
    let mut nodes = vec![vec![0u32; n]; n];
    for row in 0..n {
        for col in 0..n {
            nodes[row][col] = g.add_node();
        }
    }
    for col in 0..n {
        g.add_terminal(nodes[0][col], 100, 0);
        g.add_terminal(nodes[n - 1][col], 0, 100);
    }
    for row in 0..n {
        for col in 0..(n - 1) {
            g.add_edge(nodes[row][col], nodes[row][col + 1], 1, 1);
        }
    }
    for row in 0..(n - 1) {
        for col in 0..n {
            g.add_edge(nodes[row][col], nodes[row + 1][col], 1, 1);
        }
    }
    g.finalize();
    g.solve()
}

#[test]
fn grid_3x3_horizontal_cut() {
    assert_eq!(grid_horizontal_cut(3), 3);
}

#[test]
fn grid_5x5_horizontal_cut() {
    assert_eq!(grid_horizontal_cut(5), 5);
}

/// No sink -> flow = 0, everything stays source-side.
#[test]
fn all_source_no_sink() {
    let mut g = BkGraph::with_capacity(3, 2);
    let a = g.add_node();
    let b = g.add_node();
    let c = g.add_node();
    g.add_terminal(a, 5, 0);
    g.add_terminal(b, 3, 0);
    g.add_terminal(c, 2, 0);
    g.add_edge(a, b, 10, 10);
    g.add_edge(b, c, 10, 10);
    g.finalize();
    assert_eq!(g.solve(), 0);
    assert!(g.is_in_source(a));
    assert!(g.is_in_source(b));
    assert!(g.is_in_source(c));
}

/// Chain with bypass. pre-flow=2, augment 3 -> total 5.
#[test]
fn chain_with_bypass() {
    let mut g = BkGraph::with_capacity(2, 2);
    let a = g.add_node();
    let b = g.add_node();
    g.add_terminal(a, 100, 2);
    g.add_terminal(b, 0, 100);
    g.add_edge(a, b, 3, 0);
    g.finalize();
    assert_eq!(g.solve(), 5);
}

/// No edges, single node: pre-flow = min(7,3) = 3, no augmenting path.
#[test]
fn no_edges_single_node() {
    let mut g = BkGraph::with_capacity(1, 0);
    let a = g.add_node();
    g.add_terminal(a, 7, 3);
    g.finalize();
    assert_eq!(g.solve(), 3);
}

#[test]
fn empty_graph() {
    let mut g = BkGraph::with_capacity(0, 0);
    g.finalize();
    assert_eq!(g.solve(), 0);
}

/// Heterogeneous-capacity probe: a mostly-uniform grid (unit edges) with
/// one small interior rectangle whose edges are ~1e6x larger, plus
/// near-infinite terminal edges on the boundary columns — the exact
/// pattern the pairwise seam finder's `INF_CAP` terminals + gradient-cost
/// edges produce. Exercises the module doc's documented parent-edge-cycle
/// mitigation: without it this shape can loop; with it, `solve()`
/// terminates within a small multiple of the min-cut value (one unit
/// edge per row = `rows`).
#[test]
fn heterogeneous_capacity_grid_terminates_within_iter_bound() {
    let (cols, rows): (u32, u32) = (16, 8);
    let n = (cols * rows) as usize;
    let mut g = BkGraph::with_capacity(n, n * 4);
    let ids: Vec<super::NodeId> = (0..n).map(|_| g.add_node()).collect();
    let in_rect = |x: u32, y: u32| (6..10).contains(&x) && (2..6).contains(&y);
    const INF_CAP: i64 = i64::MAX / 4;
    for y in 0..rows {
        for x in 0..cols {
            let idx = (y * cols + x) as usize;
            if x + 1 < cols {
                let cap = if in_rect(x, y) || in_rect(x + 1, y) {
                    1_000_000
                } else {
                    1
                };
                g.add_edge(ids[idx], ids[idx + 1], cap, cap);
            }
            if y + 1 < rows {
                let cap = if in_rect(x, y) || in_rect(x, y + 1) {
                    1_000_000
                } else {
                    1
                };
                g.add_edge(ids[idx], ids[idx + cols as usize], cap, cap);
            }
            if x == 0 {
                g.add_terminal(ids[idx], INF_CAP, 0);
            } else if x == cols - 1 {
                g.add_terminal(ids[idx], 0, INF_CAP);
            }
        }
    }
    // Generous but finite bound: real min-cut is `rows` augmenting paths
    // in the ideal case; allow a large multiple for the defensive
    // cycle-break bookkeeping without letting a true infinite loop pass.
    g.set_iter_limit(rows as u64 * 1000);
    g.finalize();
    let flow = g.solve();
    assert!(
        g.augment_iters() < rows as u64 * 1000,
        "solve() hit the iteration cap — the cycle mitigation did not terminate the search"
    );
    assert!(
        flow > 0,
        "expected positive flow through the grid, got {flow}"
    );
}
