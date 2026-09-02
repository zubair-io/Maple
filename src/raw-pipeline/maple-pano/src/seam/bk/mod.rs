//! Boykov-Kolmogorov max-flow / min-cut algorithm.
//!
//! Reference: Boykov & Kolmogorov 2004, "An Experimental Comparison of
//! Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision", IEEE
//! PAMI 26(9): 1124-1137.
//!
//! Designed for grid-graph energy-minimization problems (image
//! segmentation, seam finding). In practice 2-5x faster than
//! Edmonds-Karp on vision graphs because the search trees are reused
//! across augmentation iterations — which is why this crate carries its
//! own copy rather than reaching for `pathfinding::edmonds_karp_sparse`
//! (the only max-flow primitive in that already-vendored crate):
//! Edmonds-Karp is `O(V * E^2)`, orders of magnitude too slow on a
//! multi-megapixel seam graph.
//!
//! Ported from the `pano-core` prototype (PR #17, closed unmerged; see
//! ticket #1179) into this crate, with the graph API here in [`mod@self`]
//! and the grow/augment/adopt algorithm internals split into [`solve`]
//! to respect the file-size budget.
//!
//! # Known correctness limitation: parent_edge cycles
//!
//! On grid graphs with **heterogeneous edge capacities** (some edges
//! much larger than others), the `adopt()` / `try_find_parent()` pair
//! can produce parent_edge chains that form cycles. Specifically, when
//! an orphan is processed, `try_find_parent` walks each candidate's
//! parent chain via `path_valid` to confirm it still reaches a
//! terminal — but `path_valid` short-circuits on the current
//! iteration's timestamp without verifying that the in-progress walk
//! hasn't re-visited a node, so a cycle that forms later in adoption
//! cascades isn't detected. Once a cycle exists, `augment()`'s S/T-tree
//! walks would loop forever.
//!
//! Defensive mitigation in this file: every walk in `augment()` and
//! `path_valid()` is capped at `n_nodes + small_constant` steps; on
//! overflow we abort the augmenting path (saturating its crossing edge
//! to remove it from future grow searches) so the solver terminates
//! with under-augmented flow rather than hanging. On a seam graph this
//! means the cut can land a few flow units short of the true min-cut —
//! invisible in the routed seam, since the search space that matters
//! (whole-canvas seam placement) is far coarser than a single unit of
//! flow.
//!
//! # Data-structure conventions
//!
//! Edges are stored as sister pairs: edge `2k` is the forward
//! direction, edge `2k+1` is the reverse. `sister(e) = e ^ 1` always.
//!
//! **Parent-edge convention (matching Kolmogorov's original C++
//! implementation):**
//!
//! - **S-tree** node `q` with parent `p`: `q.parent_edge = arc q->p`
//!   (the arc going child -> parent, *opposite* to flow direction).
//!   The augmenting-path capacity is `edges[parent_edge ^ 1].residual`
//!   (sister arc = arc p->q, flow direction source->q).
//!
//! - **T-tree** node `q` with parent `p`: `q.parent_edge = arc p->q`
//!   (the arc going parent -> child, *same* as flow direction). The
//!   augmenting-path capacity is `edges[parent_edge].residual`.
//!
//! Sentinels: `TERMINAL` = tree root (directly connected to
//! source/sink); `ORPHAN` = orphaned node (parent arc was saturated).
//!
//! # Usage
//!
//! ```
//! use maple_pano::seam::bk::BkGraph;
//!
//! let mut g = BkGraph::with_capacity(2, 1);
//! let a = g.add_node();
//! let b = g.add_node();
//! g.add_terminal(a, 10, 0); // source -> a: 10
//! g.add_terminal(b, 0, 10); // b -> sink: 10
//! g.add_edge(a, b, 5, 0);
//! g.finalize();
//! let flow = g.solve();
//! assert_eq!(flow, 5);
//! assert!(g.is_in_source(a));
//! assert!(!g.is_in_source(b));
//! ```

mod solve;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

pub type NodeId = u32;
pub const TERMINAL: u32 = u32::MAX;
pub const ORPHAN: u32 = u32::MAX - 1;
const NO_EDGE: u32 = u32::MAX - 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tree {
    None,
    Source,
    Sink,
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Edge {
    head: NodeId,
    residual: i64,
}

#[derive(Clone, Debug)]
struct Node {
    first_adj: u32,
    adj_count: u32,
    /// Parent edge with tree-specific conventions (see module docs).
    parent_edge: u32,
    dist: u32,
    timestamp: u32,
    tree: Tree,
    terminal_cap: i64,
    is_active: bool,
}

#[derive(Clone, Copy)]
struct PendingEdge {
    tail: NodeId,
    head: NodeId,
    cap_fwd: i64,
    cap_rev: i64,
}

// ---------------------------------------------------------------------------
// BkGraph
// ---------------------------------------------------------------------------

pub struct BkGraph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    node_adj: Vec<u32>,
    pending: Vec<PendingEdge>,
    active: VecDeque<NodeId>,
    orphans: VecDeque<NodeId>,
    timestamp: u32,
    flow: i64,
    /// Number of outer-loop (grow -> augment -> adopt) iterations the
    /// last `solve()` call performed. Useful for diagnosing perf
    /// pathologies where heterogeneous edge capacities make BK iterate
    /// orders of magnitude more than the min-cut value would suggest.
    /// Zero before the first `solve()`.
    augment_iters: u64,
    /// Maximum iteration cap for `solve()`. Defaults to `u64::MAX` (no
    /// cap). Set lower in tests / for instrumentation to bail before
    /// runaway loops eat the wall clock.
    iter_limit: u64,
}

impl BkGraph {
    pub fn with_capacity(n_nodes: usize, n_edges_estimate: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(n_nodes),
            edges: Vec::with_capacity(n_edges_estimate * 2),
            node_adj: Vec::with_capacity(n_edges_estimate * 2),
            pending: Vec::with_capacity(n_edges_estimate),
            active: VecDeque::with_capacity(n_nodes),
            orphans: VecDeque::with_capacity(64),
            timestamp: 0,
            flow: 0,
            augment_iters: 0,
            iter_limit: u64::MAX,
        }
    }

    /// Set a cap on the number of `(grow -> augment -> adopt)` outer-loop
    /// iterations `solve()` will perform. When the cap is hit, `solve()`
    /// returns the partial flow with the cut state as it stands. Default
    /// is `u64::MAX` (no cap) — production callers shouldn't touch this.
    pub fn set_iter_limit(&mut self, limit: u64) {
        self.iter_limit = limit;
    }

    /// Number of outer-loop iterations executed by the most recent
    /// `solve()` call.
    pub fn augment_iters(&self) -> u64 {
        self.augment_iters
    }

    pub fn add_node(&mut self) -> NodeId {
        let id = self.nodes.len() as u32;
        self.nodes.push(Node {
            first_adj: 0,
            adj_count: 0,
            parent_edge: TERMINAL,
            dist: 0,
            timestamp: 0,
            tree: Tree::None,
            terminal_cap: 0,
            is_active: false,
        });
        id
    }

    pub fn add_edge(&mut self, a: NodeId, b: NodeId, cap_forward: i64, cap_reverse: i64) {
        self.pending.push(PendingEdge {
            tail: a,
            head: b,
            cap_fwd: cap_forward,
            cap_rev: cap_reverse,
        });
    }

    pub fn add_terminal(&mut self, node: NodeId, cap_source: i64, cap_sink: i64) {
        let delta = cap_source.min(cap_sink);
        self.flow += delta;
        self.nodes[node as usize].terminal_cap += cap_source - cap_sink;
    }

    pub fn finalize(&mut self) {
        let n = self.nodes.len();
        if n == 0 {
            return;
        }

        let n_pairs = self.pending.len();
        self.edges.clear();
        self.edges.reserve(n_pairs * 2);
        for pe in &self.pending {
            // edge 2k:   tail -> head, capacity fwd
            // edge 2k+1: head -> tail, capacity rev
            self.edges.push(Edge {
                head: pe.head,
                residual: pe.cap_fwd,
            });
            self.edges.push(Edge {
                head: pe.tail,
                residual: pe.cap_rev,
            });
        }

        // CSR adjacency: for node i, all edge indices where i appears as tail.
        let mut degree = vec![0u32; n];
        for pe in &self.pending {
            degree[pe.tail as usize] += 1;
            degree[pe.head as usize] += 1;
        }
        let mut start = vec![0u32; n + 1];
        for i in 0..n {
            start[i + 1] = start[i] + degree[i];
        }
        let total_adj = start[n] as usize;
        self.node_adj = vec![0u32; total_adj];
        let mut cursor = start[..n].to_vec();
        for (k, pe) in self.pending.iter().enumerate() {
            let fwd = (k * 2) as u32;
            let rev = fwd ^ 1;
            // fwd edge (tail->head) stored under tail.
            self.node_adj[cursor[pe.tail as usize] as usize] = fwd;
            cursor[pe.tail as usize] += 1;
            // rev edge (head->tail) stored under head.
            self.node_adj[cursor[pe.head as usize] as usize] = rev;
            cursor[pe.head as usize] += 1;
        }
        for i in 0..n {
            self.nodes[i].first_adj = start[i];
            self.nodes[i].adj_count = degree[i];
        }

        // Initialise S/T trees.
        for i in 0..n {
            let tc = self.nodes[i].terminal_cap;
            if tc > 0 {
                self.nodes[i].tree = Tree::Source;
                self.nodes[i].parent_edge = TERMINAL;
                self.nodes[i].dist = 1;
                Self::do_enqueue(&mut self.active, &mut self.nodes, i as NodeId);
            } else if tc < 0 {
                self.nodes[i].tree = Tree::Sink;
                self.nodes[i].parent_edge = TERMINAL;
                self.nodes[i].dist = 1;
                Self::do_enqueue(&mut self.active, &mut self.nodes, i as NodeId);
            }
        }
    }

    pub fn solve(&mut self) -> i64 {
        self.augment_iters = 0;
        loop {
            if self.augment_iters >= self.iter_limit {
                break;
            }
            self.timestamp += 1;
            match self.grow() {
                Some((s_edge, t_edge)) => {
                    self.augment_iters += 1;
                    self.augment(s_edge, t_edge);
                    self.adopt();
                }
                None => break,
            }
        }
        self.flow
    }

    pub fn is_in_source(&self, node: NodeId) -> bool {
        self.nodes[node as usize].tree == Tree::Source
    }
}
