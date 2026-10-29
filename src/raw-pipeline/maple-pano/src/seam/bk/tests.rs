//! Correctness tests for [`super::BkGraph`], ported (trimmed) from the
//! `pano-core` prototype (PR #17). Covers the textbook min-cut cases, the
//! iteration cap, and random heterogeneous grids checked against a dense
//! Edmonds–Karp reference.

use super::BkGraph;

#[test]
fn trivial_single_node_equal_caps() {
    let mut g = BkGraph::with_capacity(1, 0);
    let a = g.add_node();
    g.add_terminal(a, 10, 10);
    g.finalize();
    assert_eq!(g.solve(), Some(10));
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
    assert_eq!(g.solve(), Some(5));
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
    assert_eq!(g.solve(), Some(5));
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
    assert_eq!(g.solve(), Some(8));
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
    g.solve().expect("uncapped solve")
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
    assert_eq!(g.solve(), Some(0));
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
    assert_eq!(g.solve(), Some(5));
}

/// No edges, single node: pre-flow = min(7,3) = 3, no augmenting path.
#[test]
fn no_edges_single_node() {
    let mut g = BkGraph::with_capacity(1, 0);
    let a = g.add_node();
    g.add_terminal(a, 7, 3);
    g.finalize();
    assert_eq!(g.solve(), Some(3));
}

#[test]
fn empty_graph() {
    let mut g = BkGraph::with_capacity(0, 0);
    g.finalize();
    assert_eq!(g.solve(), Some(0));
}

/// Heterogeneous-capacity probe: a mostly-uniform grid (unit edges) with
/// one small interior rectangle whose edges are ~1e6x larger, plus
/// near-infinite terminal edges on the boundary columns — the exact
/// pattern the pairwise seam finder's `INF_CAP` terminals + gradient-cost
/// edges produce. The min cut is one unit edge per row.
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
    g.set_iter_limit(rows as u64 * 1000);
    g.finalize();
    assert_eq!(g.solve(), Some(rows as i64));
}

#[test]
fn a_solve_stopped_by_the_iteration_cap_reports_no_flow() {
    let mut g = BkGraph::with_capacity(3, 2);
    let ids: Vec<super::NodeId> = (0..3).map(|_| g.add_node()).collect();
    g.add_terminal(ids[0], 10, 0);
    g.add_terminal(ids[1], 10, 0);
    g.add_terminal(ids[2], 0, 20);
    g.add_edge(ids[0], ids[2], 10, 0);
    g.add_edge(ids[1], ids[2], 10, 0);
    g.set_iter_limit(1);
    g.finalize();
    assert_eq!(g.solve(), None);
}

#[derive(Clone)]
struct ReferenceNetwork {
    cap: Vec<Vec<i64>>,
}

impl ReferenceNetwork {
    fn new(n_nodes: usize) -> Self {
        Self {
            cap: vec![vec![0; n_nodes + 2]; n_nodes + 2],
        }
    }

    fn max_flow(mut self) -> i64 {
        let n = self.cap.len();
        let (source, sink) = (n - 2, n - 1);
        std::iter::from_fn(|| {
            let mut prev = vec![usize::MAX; n];
            prev[source] = source;
            let mut queue = std::collections::VecDeque::from([source]);
            while let Some(u) = queue.pop_front() {
                for (v, p) in prev.iter_mut().enumerate() {
                    if *p == usize::MAX && self.cap[u][v] > 0 {
                        *p = u;
                        queue.push_back(v);
                    }
                }
            }
            (prev[sink] != usize::MAX).then(|| {
                let path: Vec<(usize, usize)> =
                    std::iter::successors(Some(sink), |&v| (v != source).then(|| prev[v]))
                        .filter(|&v| v != source)
                        .map(|v| (prev[v], v))
                        .collect();
                let push = path.iter().map(|&(u, v)| self.cap[u][v]).min().unwrap_or(0);
                for &(u, v) in &path {
                    self.cap[u][v] -= push;
                    self.cap[v][u] += push;
                }
                push
            })
        })
        .sum()
    }
}

fn random_heterogeneous_grid(
    seed: u64,
    cols: usize,
    rows: usize,
    edge_copies: usize,
) -> (BkGraph, ReferenceNetwork) {
    let mut rng = crate::prng::SplitMix64::new(seed);
    let n = cols * rows;
    let mut g = BkGraph::with_capacity(n, n * 2);
    let mut reference = ReferenceNetwork::new(n);
    let (source, sink) = (n, n + 1);
    let ids: Vec<super::NodeId> = (0..n).map(|_| g.add_node()).collect();
    let mut capacity = || match rng.next_u64() % 4 {
        0 => 0,
        1 => 1 + (rng.next_u64() % 3) as i64,
        2 => 1 + (rng.next_u64() % 40) as i64,
        _ => 1 + (rng.next_u64() % 4000) as i64,
    };
    for y in 0..rows {
        for x in 0..cols {
            let idx = y * cols + x;
            let neighbours = [(x + 1 < cols, idx + 1), (y + 1 < rows, idx + cols)];
            let pairs = neighbours.into_iter().filter(|&(exists, _)| exists);
            for (_, other) in pairs.flat_map(|pair| std::iter::repeat_n(pair, edge_copies)) {
                let (fwd, rev) = (capacity(), capacity());
                g.add_edge(ids[idx], ids[other], fwd, rev);
                reference.cap[idx][other] += fwd;
                reference.cap[other][idx] += rev;
            }
            let (to_source, to_sink) = (capacity(), capacity());
            g.add_terminal(ids[idx], to_source, to_sink);
            reference.cap[source][idx] += to_source;
            reference.cap[idx][sink] += to_sink;
        }
    }
    g.finalize();
    (g, reference)
}

fn cut_capacity(g: &BkGraph, reference: &ReferenceNetwork) -> i64 {
    let n = reference.cap.len();
    let (source, sink) = (n - 2, n - 1);
    let in_source = |v: usize| v == source || (v != sink && g.is_in_source(v as super::NodeId));
    (0..n)
        .filter(|&u| in_source(u))
        .flat_map(|u| (0..n).filter(|&v| !in_source(v)).map(move |v| (u, v)))
        .map(|(u, v)| reference.cap[u][v])
        .sum()
}

fn grids_off_the_true_max_flow(edge_copies: usize) -> Vec<(u64, i64, i64, i64)> {
    (0..400u64)
        .filter_map(|seed| {
            let (mut g, reference) = random_heterogeneous_grid(seed, 9, 7, edge_copies);
            let expected = reference.clone().max_flow();
            g.set_iter_limit(100_000);
            let got = g.solve().unwrap_or(-1);
            let cut = cut_capacity(&g, &reference);
            (got != expected || cut != expected).then_some((seed, got, cut, expected))
        })
        .collect()
}

#[test]
fn heterogeneous_random_grids_reach_the_true_max_flow() {
    let mismatches = grids_off_the_true_max_flow(1);
    assert!(
        mismatches.is_empty(),
        "BK missed the max flow on {} of 400 grids (seed, flow, cut, expected): {:?}",
        mismatches.len(),
        &mismatches[..mismatches.len().min(8)]
    );
}

#[test]
fn parallel_edges_reach_the_true_max_flow() {
    let mismatches = grids_off_the_true_max_flow(2);
    assert!(
        mismatches.is_empty(),
        "BK missed the max flow on {} of 400 parallel-edge grids (seed, flow, cut, expected): {:?}",
        mismatches.len(),
        &mismatches[..mismatches.len().min(8)]
    );
}
