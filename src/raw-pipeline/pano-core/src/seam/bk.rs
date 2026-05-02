//! Boykov-Kolmogorov max-flow / min-cut algorithm.
//!
//! Reference: Boykov & Kolmogorov 2004, "An Experimental Comparison of
//! Min-Cut/Max-Flow Algorithms for Energy Minimization in Vision",
//! IEEE PAMI 26(9): 1124–1137.
//!
//! Designed for grid-graph energy-minimization problems (image segmentation,
//! seam finding).  In practice 2–5× faster than Edmonds-Karp on vision graphs
//! because the search trees are reused across augmentation iterations.
//!
//! # Known correctness limitation: parent_edge cycles
//!
//! On grid graphs with **heterogeneous edge capacities** (some edges
//! ≫ others), the `adopt()` / `try_find_parent()` pair can produce
//! parent_edge chains that form cycles. Specifically, when an orphan
//! is processed, `try_find_parent` walks each candidate's parent
//! chain via `path_valid` to confirm it still reaches a terminal —
//! but `path_valid` short-circuits on the current iteration's
//! timestamp without verifying that the in-progress walk hasn't
//! re-visited a node, so a cycle that forms later in adoption
//! cascades isn't detected. Once a cycle exists, `augment()`'s
//! S/T-tree walks would loop forever.
//!
//! Repro: `cargo run --release --example bk_repro het2` — an 8×4
//! grid with cap_low=1, cap_high=2 in a single 1×1 rect, terminal
//! cap=100. The 6th augmenting iteration's S-walk cycles at depth
//! ≥ 133 on a 32-node graph.
//!
//! Defensive mitigation in this file: every walk in `augment()` and
//! `path_valid()` is capped at `n_nodes + small_constant` steps; on
//! overflow we abort the augmenting path (saturating its crossing
//! edge to remove it from future grow searches) so the solver
//! terminates with under-augmented flow rather than hanging.
//!
//! TODO: replace with the `maxflow` crate or fix the adoption
//! invariant. Tracked separately. Until then, callers should expect
//! BK to produce a valid (acyclic) cut on heterogeneous graphs but
//! may stop a few units short of the true min-cut.
//!
//! # Data-structure conventions
//!
//! Edges are stored as sister pairs: edge `2k` is the forward direction,
//! edge `2k+1` is the reverse.  `sister(e) = e ^ 1` always.
//!
//! **Parent-edge convention (matching Kolmogorov's original C++ implementation):**
//!
//! - **S-tree** node `q` with parent `p`: `q.parent_edge = arc q→p`
//!   (the arc going child → parent, *opposite* to flow direction).
//!   The augmenting-path capacity is `edges[parent_edge ^ 1].residual`
//!   (sister arc = arc p→q, flow direction source→q).
//!
//! - **T-tree** node `q` with parent `p`: `q.parent_edge = arc p→q`
//!   (the arc going parent → child, *same* as flow direction).
//!   The augmenting-path capacity is `edges[parent_edge].residual`.
//!
//! Sentenels: `TERMINAL` = tree root (directly connected to source/sink);
//! `ORPHAN` = orphaned node (parent arc was saturated).
//!
//! # Usage
//!
//! ```
//! use pano_core::seam::bk::BkGraph;
//!
//! let mut g = BkGraph::with_capacity(2, 1);
//! let a = g.add_node();
//! let b = g.add_node();
//! g.add_terminal(a, 10, 0);   // source → a: 10
//! g.add_terminal(b, 0, 10);   // b → sink:  10
//! g.add_edge(a, b, 5, 0);
//! g.finalize();
//! let flow = g.solve();
//! assert_eq!(flow, 5);
//! assert!(g.is_in_source(a));
//! assert!(!g.is_in_source(b));
//! ```

use std::collections::VecDeque;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

pub type NodeId = u32;
pub const TERMINAL: u32 = u32::MAX;
pub const ORPHAN: u32 = u32::MAX - 1;
const NO_EDGE: u32 = u32::MAX - 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tree {
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
    /// Number of outer-loop (grow → augment → adopt) iterations the
    /// last `solve()` call performed. Useful for diagnosing perf
    /// pathologies where heterogeneous edge capacities make BK
    /// iterate orders of magnitude more than the min-cut value would
    /// suggest. Zero before the first `solve()`.
    augment_iters: u64,
    /// Maximum iteration cap for `solve()`. Defaults to `u64::MAX`
    /// (no cap). Set lower in tests / for instrumentation to bail
    /// before runaway loops eat the wall clock.
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

    /// Set a cap on the number of `(grow → augment → adopt)` outer-
    /// loop iterations `solve()` will perform. When the cap is hit,
    /// `solve()` returns the partial flow with the cut state as it
    /// stands. Default is `u64::MAX` (no cap) — production callers
    /// shouldn't touch this.
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
            // edge 2k:   tail → head, capacity fwd
            // edge 2k+1: head → tail, capacity rev
            self.edges.push(Edge { head: pe.head, residual: pe.cap_fwd });
            self.edges.push(Edge { head: pe.tail, residual: pe.cap_rev });
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
            // fwd edge (tail→head) stored under tail.
            self.node_adj[cursor[pe.tail as usize] as usize] = fwd;
            cursor[pe.tail as usize] += 1;
            // rev edge (head→tail) stored under head.
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

    // -----------------------------------------------------------------------
    // Growth phase
    // -----------------------------------------------------------------------

    /// Returns `Some((s_edge, t_edge))` where `s_edge` is the S→T crossing edge
    /// (positive residual in S→T direction) and `t_edge = s_edge ^ 1`.
    fn grow(&mut self) -> Option<(u32, u32)> {
        while let Some(p) = self.active.front().copied() {
            if self.nodes[p as usize].tree == Tree::None {
                self.active.pop_front();
                self.nodes[p as usize].is_active = false;
                continue;
            }
            let tree_p = self.nodes[p as usize].tree;

            let first = self.nodes[p as usize].first_adj;
            let count = self.nodes[p as usize].adj_count;

            for k in 0..count {
                let ei = self.node_adj[(first + k) as usize];
                // edge `ei` goes p → head.
                let head = self.edges[ei as usize].head;
                let tree_q = self.nodes[head as usize].tree;
                let sister = ei ^ 1;

                match (tree_p, tree_q) {
                    // ---- Grow S-tree from p to free node head ----
                    // Need edges[ei].residual > 0 (capacity p→head).
                    // S-tree: head.parent_edge = arc head→p = sister.
                    (Tree::Source, Tree::None) if self.edges[ei as usize].residual > 0 => {
                        self.nodes[head as usize].tree = Tree::Source;
                        self.nodes[head as usize].parent_edge = sister; // head→p
                        self.nodes[head as usize].dist = self.nodes[p as usize].dist + 1;
                        self.nodes[head as usize].timestamp = self.timestamp;
                        Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                    }
                    // ---- Grow T-tree from p to free node head ----
                    // Kolmogorov grows T-tree using sister's capacity (=capacity head→p).
                    // "a->sister->r_cap > 0" in original: iterates from T-tree node p
                    // using arc `a` going p→head, checks `a->sister->r_cap` (=head→p cap).
                    // T-tree: head.parent_edge = arc p→head = ei.
                    (Tree::Sink, Tree::None) if self.edges[sister as usize].residual > 0 => {
                        self.nodes[head as usize].tree = Tree::Sink;
                        self.nodes[head as usize].parent_edge = ei; // p→head
                        self.nodes[head as usize].dist = self.nodes[p as usize].dist + 1;
                        self.nodes[head as usize].timestamp = self.timestamp;
                        Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                    }
                    // ---- Crossing: S-tree p → T-tree head ----
                    // Need capacity p→head > 0.
                    (Tree::Source, Tree::Sink) if self.edges[ei as usize].residual > 0 => {
                        return Some((ei, sister));
                    }
                    // ---- Crossing: T-tree p, S-tree head ----
                    // Augmenting edge S→T is sister (head→p).  Need sister.residual > 0.
                    (Tree::Sink, Tree::Source) if self.edges[sister as usize].residual > 0 => {
                        return Some((sister, ei));
                    }
                    _ => {}
                }
            }

            self.active.pop_front();
            self.nodes[p as usize].is_active = false;
        }
        None
    }

    // -----------------------------------------------------------------------
    // Augmentation phase
    // -----------------------------------------------------------------------

    /// `s_edge`: S-tree → T-tree crossing edge (positive residual).
    /// `t_edge = s_edge ^ 1`.
    fn augment(&mut self, s_edge: u32, t_edge: u32) {
        // s_edge goes S-node → T-node.
        let u = self.edges[s_edge as usize].head; // T-tree side
        let v = self.edges[t_edge as usize].head; // S-tree side

        // ---- Compute bottleneck -------------------------------------------

        // Defensive walk-step cap. In a correctly-maintained BK tree
        // these walks are O(tree-depth) ≤ O(n_nodes). If they exceed
        // that, our adopt()/try_find_parent() pair has created a
        // parent_edge cycle (a known bug in this implementation —
        // see the module-level "Known correctness limitation" comment).
        // When it happens we abort the augmenting path rather than
        // looping forever; flow is left under-augmented but the
        // overall solver still terminates.
        let walk_cap = self.nodes.len() as u64 + 32;
        let mut bottleneck = self.edges[s_edge as usize].residual;
        let mut path_aborted = false;

        // S-tree walk v → source.
        {
            let mut cur = v;
            let mut steps = 0u64;
            loop {
                steps += 1;
                if steps > walk_cap {
                    path_aborted = true;
                    break;
                }
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    bottleneck = bottleneck.min(self.nodes[cur as usize].terminal_cap);
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                bottleneck = bottleneck.min(self.edges[pe as usize ^ 1].residual);
                cur = self.edges[pe as usize].head;
            }
        }

        // T-tree walk u → sink.
        if !path_aborted {
            let mut cur = u;
            let mut steps = 0u64;
            loop {
                steps += 1;
                if steps > walk_cap {
                    path_aborted = true;
                    break;
                }
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    bottleneck = bottleneck.min(-self.nodes[cur as usize].terminal_cap);
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                bottleneck = bottleneck.min(self.edges[pe as usize].residual);
                cur = self.edges[pe as usize ^ 1].head;
            }
        }

        if path_aborted {
            // Disconnect the crossing edge to remove this augmenting
            // candidate from future grow() searches, otherwise grow
            // will keep returning the same crossing edge and loop us
            // forever at the BK-iteration level.
            self.edges[s_edge as usize].residual = 0;
            self.edges[t_edge as usize].residual = 0;
            return;
        }

        if bottleneck <= 0 {
            return;
        }
        self.flow += bottleneck;

        // ---- Push flow: crossing edge ----------------------------------------
        self.edges[s_edge as usize].residual -= bottleneck;
        self.edges[t_edge as usize].residual += bottleneck;

        // ---- Push flow: S-tree path v → source ------------------------------
        // S-tree: pe = cur→parent.  Flow direction parent→cur: increase pe.residual, decrease pe^1.
        {
            let mut cur = v;
            let mut steps = 0u64;
            loop {
                steps += 1;
                if steps > walk_cap {
                    break; // defensive cycle break, see comment above
                }
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    self.nodes[cur as usize].terminal_cap -= bottleneck;
                    if self.nodes[cur as usize].terminal_cap == 0 {
                        self.nodes[cur as usize].parent_edge = ORPHAN;
                        self.orphans.push_back(cur);
                    }
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                // Flow direction = pe^1 (parent→cur): decrease its residual, increase pe.
                self.edges[pe as usize ^ 1].residual -= bottleneck;
                self.edges[pe as usize].residual += bottleneck;
                if self.edges[pe as usize ^ 1].residual == 0 {
                    // The tree-edge capacity in flow direction reached 0 → orphan cur.
                    self.nodes[cur as usize].parent_edge = ORPHAN;
                    self.orphans.push_back(cur);
                }
                cur = self.edges[pe as usize].head; // advance to parent
            }
        }

        // ---- Push flow: T-tree path u → sink --------------------------------
        // T-tree: pe = parent→cur.  Flow direction parent→cur: decrease pe, increase pe^1.
        {
            let mut cur = u;
            let mut steps = 0u64;
            loop {
                steps += 1;
                if steps > walk_cap {
                    break; // defensive cycle break, see comment above
                }
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    self.nodes[cur as usize].terminal_cap += bottleneck; // was negative
                    if self.nodes[cur as usize].terminal_cap == 0 {
                        self.nodes[cur as usize].parent_edge = ORPHAN;
                        self.orphans.push_back(cur);
                    }
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                // Flow direction = pe (parent→cur): decrease its residual, increase pe^1.
                self.edges[pe as usize].residual -= bottleneck;
                self.edges[pe as usize ^ 1].residual += bottleneck;
                if self.edges[pe as usize].residual == 0 {
                    self.nodes[cur as usize].parent_edge = ORPHAN;
                    self.orphans.push_back(cur);
                }
                cur = self.edges[pe as usize ^ 1].head; // advance to parent via pe^1
            }
        }
    }

    // -----------------------------------------------------------------------
    // Adoption phase
    // -----------------------------------------------------------------------

    fn adopt(&mut self) {
        while let Some(p) = self.orphans.pop_front() {
            let tree_p = self.nodes[p as usize].tree;
            if tree_p == Tree::None {
                continue;
            }

            if self.try_find_parent(p, tree_p) {
                continue;
            }

            // Cannot re-attach p: orphan its children and free it.
            let first = self.nodes[p as usize].first_adj;
            let count = self.nodes[p as usize].adj_count;

            for k in 0..count {
                let ei = self.node_adj[(first + k) as usize];
                // ei: p → head
                let head = self.edges[ei as usize].head;
                let sister = ei ^ 1; // head → p

                if self.nodes[head as usize].tree != tree_p {
                    continue;
                }

                // Is `head` a child of `p` in the tree?
                // S-tree: head.parent_edge = head→p = sister.
                // T-tree: head.parent_edge = p→head = ei.
                let head_pe = self.nodes[head as usize].parent_edge;
                let is_child = match tree_p {
                    Tree::Source => head_pe == sister,
                    Tree::Sink   => head_pe == ei,
                    Tree::None   => false,
                };
                if is_child {
                    self.nodes[head as usize].parent_edge = ORPHAN;
                    self.orphans.push_back(head);
                }

                // Re-enqueue head if there's capacity to grow/maintain the tree.
                // S-tree: capacity p→head = edges[ei].residual > 0.
                // T-tree: capacity head→p = edges[sister].residual > 0.
                let cap = match tree_p {
                    Tree::Source => self.edges[ei as usize].residual,
                    Tree::Sink   => self.edges[sister as usize].residual,
                    Tree::None   => 0,
                };
                if cap > 0
                    && !self.nodes[head as usize].is_active
                    && self.nodes[head as usize].tree != Tree::None
                {
                    Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                }
            }

            self.nodes[p as usize].tree = Tree::None;
            self.nodes[p as usize].parent_edge = NO_EDGE;
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Try to find a valid new parent for orphan `p` in tree `tree_p`.
    fn try_find_parent(&mut self, p: NodeId, tree_p: Tree) -> bool {
        let first = self.nodes[p as usize].first_adj;
        let count = self.nodes[p as usize].adj_count;
        let ts = self.timestamp;

        let mut best_dist = u32::MAX;
        let mut best_pe = NO_EDGE;

        for k in 0..count {
            let ei = self.node_adj[(first + k) as usize];
            // ei: p → head (candidate parent for S-tree; candidate child-parent for T-tree)
            let head = self.edges[ei as usize].head;
            let sister = ei ^ 1; // head → p

            if self.nodes[head as usize].tree != tree_p {
                continue;
            }

            // Required capacity for adopting head as p's new parent:
            // S-tree: p.parent_edge will be set to sister (p→head... wait, no.
            //   S-tree: parent_edge = child→parent = p→head = ei? No:
            //   in S-tree, head would be p's new parent.
            //   So p.parent_edge = arc p→head = ei.
            //   Flow direction from head to p = sister = head→p.
            //   Capacity: edges[ei^1 = sister].residual. Wait...
            //
            // Let's be careful. In S-tree: parent_edge = child→parent.
            // p's new parent is head. So p.parent_edge = arc p→head = ei.
            // Wait, but S-tree convention is parent_edge = arc going FROM child TO parent.
            // If head is the new parent, p is the child. Arc p→head IS p→its-parent. So
            // p.parent_edge = ei (arc p→head).
            // Capacity in flow direction (head→p) = edges[sister = ei^1].residual.
            // We need edges[sister].residual > 0.
            //
            // Hmm but in grow(), we set: `head.parent_edge = sister` where sister = ei^1
            // and ei goes p→head. That means parent_edge = arc head→p (NOT head→its-parent).
            // Wait that means grow() is setting head.parent_edge = arc from head BACK TO p
            // (the node that grew into head). This IS the convention: head's parent is p,
            // and head.parent_edge = arc head→p. That's arc head→parent ✓.
            // So parent_edge = arc child→parent. And for p being adopted by head:
            // p.parent_edge = arc p→head? No: p→head goes p→its-parent. That IS arc p→parent.
            // Hmm...
            //
            // OK let me re-read:
            // "S-tree node q with parent p: q.parent_edge = arc q→p (child→parent)"
            // If `p` (orphan) is being re-adopted by `head` as its new parent:
            //   p.parent_edge = arc p→head.
            //   But arc p→head in our adjacency is... `ei` (since ei goes p→head)!
            //   So p.parent_edge = ei.
            //   Capacity in flow direction = edges[ei^1].residual = edges[sister].residual.
            //   We need this > 0.
            //
            // T-tree: head would be p's new parent. p.parent_edge = arc head→p (parent→child).
            //   Arc head→p = sister = ei^1.
            //   So p.parent_edge = sister.
            //   Capacity in flow direction = edges[sister].residual.
            //   We need edges[sister].residual > 0.
            //
            // In both cases, capacity check = edges[sister].residual > 0!
            // And for S-tree: best_pe = ei (p.parent_edge = arc p→head).
            //     for T-tree:  best_pe = sister (p.parent_edge = arc head→p).

            if self.edges[sister as usize].residual <= 0 {
                continue;
            }

            if !self.path_valid(head, tree_p, ts) {
                continue;
            }

            let d = self.nodes[head as usize].dist;
            if d < best_dist {
                best_dist = d;
                best_pe = match tree_p {
                    Tree::Source => ei,     // p.parent_edge = arc p→head = ei
                    Tree::Sink   => sister, // p.parent_edge = arc head→p = sister
                    Tree::None   => unreachable!(),
                };
            }
        }

        if best_pe != NO_EDGE {
            self.nodes[p as usize].parent_edge = best_pe;
            self.nodes[p as usize].dist = best_dist + 1;
            self.nodes[p as usize].timestamp = ts;
            true
        } else {
            false
        }
    }

    /// Check whether `node` in `tree` has a valid (non-orphaned) path to its terminal.
    fn path_valid(&mut self, node: NodeId, tree: Tree, ts: u32) -> bool {
        let mut cur = node;
        let mut visited: Vec<NodeId> = Vec::new();
        // Defensive cap: in a correctly-maintained tree, walk depth
        // ≤ n_nodes. If we exceed that, parent_edges form a cycle
        // (a known invariant violation in this BK port — see the
        // module-level comment). Treat as "path invalid" so the
        // caller skips this candidate parent.
        let walk_cap = self.nodes.len() + 32;

        loop {
            if visited.len() > walk_cap {
                return false;
            }
            if self.nodes[cur as usize].timestamp == ts {
                for &n in &visited {
                    self.nodes[n as usize].timestamp = ts;
                }
                return true;
            }
            visited.push(cur);

            let pe = self.nodes[cur as usize].parent_edge;
            if pe == TERMINAL {
                for &n in &visited {
                    self.nodes[n as usize].timestamp = ts;
                }
                return true;
            }
            if pe == ORPHAN || pe == NO_EDGE {
                return false;
            }

            // Advance to parent.
            // S-tree: pe = cur→parent.  edges[pe].head = parent. ✓
            // T-tree: pe = parent→cur.  edges[pe^1].head = parent. ✓
            let parent = match tree {
                Tree::Source => self.edges[pe as usize].head,
                Tree::Sink   => self.edges[pe as usize ^ 1].head,
                Tree::None   => return false,
            };
            if self.nodes[parent as usize].tree != tree {
                return false;
            }
            cur = parent;
        }
    }

    fn do_enqueue(
        active: &mut VecDeque<NodeId>,
        nodes: &mut Vec<Node>,
        node: NodeId,
    ) {
        if !nodes[node as usize].is_active {
            nodes[node as usize].is_active = true;
            active.push_back(node);
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trivial_single_node_equal_caps() {
        let mut g = BkGraph::with_capacity(1, 0);
        let a = g.add_node();
        g.add_terminal(a, 10, 10);
        g.finalize();
        assert_eq!(g.solve(), 10);
    }

    /// S --10--> A --5--> B --10--> T.  Max flow = 5.
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

    /// Symmetric cap-5 edge.  Max flow = 5.
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

    /// Diamond: pre-flow=5, augment 3 → total 8.
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

    /// 3×3 grid, min cut = 3.
    #[test]
    fn grid_3x3_horizontal_cut() {
        let n = 3usize;
        let mut g = BkGraph::with_capacity(n * n, n * (n - 1) * 2);
        let mut nodes = vec![[0u32; 3]; 3];
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
        assert_eq!(g.solve(), n as i64);
    }

    /// 5×5 grid, min cut = 5.
    #[test]
    fn grid_5x5_horizontal_cut() {
        let n = 5usize;
        let mut g = BkGraph::with_capacity(n * n, n * (n - 1) * 2);
        let mut nodes = vec![[0u32; 5]; 5];
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
        assert_eq!(g.solve(), n as i64);
    }

    /// No sink → flow = 0.
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

    /// Chain with bypass.  pre-flow=2, augment 3 → total 5.
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

    /// No edges, single node.
    #[test]
    fn no_edges_single_node() {
        let mut g = BkGraph::with_capacity(1, 0);
        let a = g.add_node();
        g.add_terminal(a, 7, 3);
        g.finalize();
        assert_eq!(g.solve(), 3); // pre-flow = min(7,3) = 3; net_tc=4, no augmenting path
    }

    /// Empty graph.
    #[test]
    fn empty_graph() {
        let mut g = BkGraph::with_capacity(0, 0);
        g.finalize();
        assert_eq!(g.solve(), 0);
    }

    // -------------------------------------------------------------------
    // Heterogeneous-capacity bisection probes
    //
    // These reproduce the runtime profile T6 hit when running BK on
    // graph_cut_maxflow's edge-cost output: a mostly-uniform overlap
    // grid where a small interior rectangle has edge capacities ~1e6×
    // larger than the surrounding edges, plus very large (`INF_CAP`)
    // terminal edges on the source/sink boundary columns. The same
    // pattern is what `pano-smoke --partition graphcut` builds at
    // 50MP scale.
    //
    // The probes use `set_iter_limit` to avoid hanging the test suite
    // and assert the iteration count stays bounded by a small
    // multiple of the min-cut value (which equals h, the canvas
    // height — one unit edge per row in the clear region).
    // -------------------------------------------------------------------

    const INF_CAP_PROBE: i64 = i64::MAX / 4;

    /// Build a `cols × rows` overlap grid with:
    ///   - `cap_low` capacity edges everywhere by default,
    ///   - `cap_high` capacity edges *inside* `rect` (col, row range),
    ///   - terminal connections of `cap_terminal` on column 0
    ///     (→ source) and the last column (→ sink).
    ///
    /// The terminal cap parameter is what we want to bisect on:
    /// `cap_terminal = 100` matches the existing passing
    /// `grid_5x5_horizontal_cut` test; `cap_terminal = INF_CAP_PROBE`
    /// (`i64::MAX/4`) matches what `graph_cut_maxflow.rs` actually
    /// uses in production.
    fn build_heterogeneous_grid_with_cap(
        cols: u32,
        rows: u32,
        cap_low: i64,
        cap_high: i64,
        cap_terminal: i64,
        rect_x: std::ops::Range<u32>,
        rect_y: std::ops::Range<u32>,
    ) -> BkGraph {
        let n = (cols * rows) as usize;
        let mut g = BkGraph::with_capacity(n, n * 4);
        let ids: Vec<NodeId> = (0..n).map(|_| g.add_node()).collect();

        let in_rect = |x: u32, y: u32| {
            rect_x.contains(&x) && rect_y.contains(&y)
        };

        for y in 0..rows {
            for x in 0..cols {
                let idx = (y * cols + x) as usize;
                // Right neighbour
                if x + 1 < cols {
                    let r_idx = idx + 1;
                    let cap = if in_rect(x, y) || in_rect(x + 1, y) {
                        cap_high
                    } else {
                        cap_low
                    };
                    g.add_edge(ids[idx], ids[r_idx], cap, cap);
                }
                // Down neighbour
                if y + 1 < rows {
                    let d_idx = idx + cols as usize;
                    let cap = if in_rect(x, y) || in_rect(x, y + 1) {
                        cap_high
                    } else {
                        cap_low
                    };
                    g.add_edge(ids[idx], ids[d_idx], cap, cap);
                }
                // Source / sink terminals
                if x == 0 {
                    g.add_terminal(ids[idx], cap_terminal, 0);
                } else if x == cols - 1 {
                    g.add_terminal(ids[idx], 0, cap_terminal);
                }
            }
        }
        g
    }

    /// Convenience wrapper preserving the original signature with
    /// `cap_terminal = INF_CAP_PROBE` (the production value).
    fn build_heterogeneous_grid(
        cols: u32,
        rows: u32,
        cap_low: i64,
        cap_high: i64,
        rect_x: std::ops::Range<u32>,
        rect_y: std::ops::Range<u32>,
    ) -> BkGraph {
        build_heterogeneous_grid_with_cap(
            cols,
            rows,
            cap_low,
            cap_high,
            INF_CAP_PROBE,
            rect_x,
            rect_y,
        )
    }

    /// 8×4 grid with **moderate** terminal cap (100, like
    /// `grid_5x5_horizontal_cut`). If this terminates fast, the
    /// hang is specifically about the INF-cap terminal regime.
    #[test]
    fn bk_8x4_moderate_terminal_cap_terminates_fast() {
        let mut g = build_heterogeneous_grid_with_cap(
            8, 4, 1, 3_000_000, 100, 3..4, 1..2,
        );
        g.set_iter_limit(1_000);
        g.finalize();
        let _flow = g.solve();
        eprintln!(
            "[bk-perf] 8×4 cap_terminal=100: BK ran {} iterations",
            g.augment_iters()
        );
        assert!(
            g.augment_iters() < 50,
            "8×4 (cap=100) ran {} iters",
            g.augment_iters()
        );
    }

    /// **Exact copy** of `grid_3x3_horizontal_cut` but at 4×4. If
    /// THIS hangs, my notion of how to build a working BK grid is
    /// wrong even before heterogeneous-capacity comes in.
    #[test]
    fn bk_4x4_uniform_grid_pattern_terminates_fast() {
        let n = 4usize;
        let mut g = BkGraph::with_capacity(n * n, n * (n - 1) * 2);
        let mut nodes = vec![[0u32; 4]; 4];
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
        g.set_iter_limit(1_000);
        g.finalize();
        let flow = g.solve();
        eprintln!(
            "[bk-perf] 4×4 uniform copy-of-3x3-pattern: BK ran {} iters, flow={}",
            g.augment_iters(),
            flow,
        );
        assert_eq!(flow, n as i64);
    }

    /// 8×4 grid with **homogeneous** capacities (no high-cap rect)
    /// and INF terminal cap. If this terminates fast, the hang
    /// requires both INF terminals **and** heterogeneous internal
    /// edges; if it hangs, INF terminals alone are sufficient.
    #[test]
    fn bk_8x4_homogeneous_inf_terminal_terminates_fast() {
        let mut g = build_heterogeneous_grid_with_cap(
            8, 4, 1, 1, INF_CAP_PROBE, 0..0, 0..0,
        );
        g.set_iter_limit(1_000);
        g.finalize();
        let _flow = g.solve();
        eprintln!(
            "[bk-perf] 8×4 homogeneous + INF terminal: BK ran {} iterations",
            g.augment_iters()
        );
        assert!(
            g.augment_iters() < 50,
            "8×4 homogeneous (INF terminals) ran {} iters",
            g.augment_iters()
        );
    }

    /// Bisect on the high-cap magnitude. Each probe uses an 8×4 grid
    /// with terminal cap 100, low edges 1, a 1×1 rectangle of high-
    /// cap edges. We log the iter count and FINAL flow to see
    /// at what magnitude BK starts iterating wildly.
    /// Tight 100-iter cap so the test ALWAYS terminates fast.
    fn bisect_cap_high(label: &str, cap_high: i64) -> u64 {
        let mut g = build_heterogeneous_grid_with_cap(
            8, 4, 1, cap_high, 100, 3..4, 1..2,
        );
        g.set_iter_limit(50);
        g.finalize();
        let flow = g.solve();
        eprintln!(
            "[bk-perf] cap_high={:<13} ({}): {} iters (cap 50), flow={}",
            cap_high,
            label,
            g.augment_iters(),
            flow,
        );
        g.augment_iters()
    }

    #[test]
    fn bk_bisect_cap_high_2() {
        let _ = bisect_cap_high("2", 2);
    }
    #[test]
    fn bk_bisect_cap_high_10() {
        let _ = bisect_cap_high("10", 10);
    }
    #[test]
    fn bk_bisect_cap_high_100() {
        let _ = bisect_cap_high("100", 100);
    }
    #[test]
    fn bk_bisect_cap_high_1000() {
        let _ = bisect_cap_high("1_000", 1_000);
    }
    #[test]
    fn bk_bisect_cap_high_100k() {
        let _ = bisect_cap_high("100_000", 100_000);
    }

    /// 8×4 grid with cap=1 everywhere AND moderate terminal cap (100).
    /// This is identical in topology to my heterogeneous probe but
    /// stripped of every "tricky" parameter. If THIS hangs, my
    /// `build_heterogeneous_grid_with_cap` graph construction is
    /// wrong (e.g. missing nodes, broken adjacency).
    #[test]
    fn bk_8x4_homogeneous_moderate_terminal_terminates_fast() {
        let mut g = build_heterogeneous_grid_with_cap(
            8, 4, 1, 1, 100, 0..0, 0..0,
        );
        g.set_iter_limit(1_000);
        g.finalize();
        let _flow = g.solve();
        eprintln!(
            "[bk-perf] 8×4 fully homogeneous, cap=1, terminal=100: BK ran {} iters",
            g.augment_iters()
        );
        assert!(
            g.augment_iters() < 50,
            "8×4 fully homogeneous ran {} iters",
            g.augment_iters()
        );
    }

    /// 8×4 heterogeneous grid (32 nodes, 1×1 high-cap inner pixel).
    /// Min cut = h = 4. BK should converge in O(h) iterations.
    #[test]
    fn bk_heterogeneous_8x4_terminates_quickly() {
        let mut g = build_heterogeneous_grid(8, 4, 1, 3_000_000, 3..4, 1..2);
        g.set_iter_limit(1_000);
        g.finalize();
        let _flow = g.solve();
        assert!(
            g.augment_iters() < 50,
            "8×4 BK ran {} iters (expected ≪ 50)",
            g.augment_iters()
        );
    }

    /// 16×8 heterogeneous grid (128 nodes, 4×3 high-cap rectangle).
    /// Min cut = h = 8. BK should converge in O(h × small const)
    /// iterations. Capping at 1e4 — if we hit it, BK has a perf bug.
    #[test]
    fn bk_heterogeneous_16x8_iters_bounded() {
        let mut g = build_heterogeneous_grid(16, 8, 1, 3_000_000, 4..8, 2..5);
        g.set_iter_limit(10_000);
        g.finalize();
        let _flow = g.solve();
        assert!(
            g.augment_iters() < 1_000,
            "16×8 BK ran {} iters (cap 1e4 — perf bug if this triggers)",
            g.augment_iters()
        );
    }

    /// 32×16 heterogeneous grid (512 nodes, 8×8 high-cap rectangle).
    /// This is the size that hung indefinitely without `set_iter_limit`.
    /// Cap at 1e6 — if we hit it, BK is iterating ~2000× more than the
    /// O(h × const) ideal (h=16 → ~few hundred at most).
    #[test]
    fn bk_heterogeneous_32x16_iters_bounded() {
        let mut g = build_heterogeneous_grid(32, 16, 1, 3_000_000, 8..16, 4..12);
        g.set_iter_limit(1_000_000);
        g.finalize();
        let _flow = g.solve();
        // Print so test output captures the actual count for
        // bisecting how badly BK degrades.
        eprintln!(
            "[bk-perf] 32×16 heterogeneous grid: BK ran {} iterations",
            g.augment_iters()
        );
        assert!(
            g.augment_iters() < 100_000,
            "32×16 BK ran {} iters (cap 1e6 — major perf bug)",
            g.augment_iters()
        );
    }

    /// 64×32 — twice each direction. If BK iter count scales worse
    /// than ~quadratic in canvas size, it'll show here.
    #[test]
    fn bk_heterogeneous_64x32_iters_bounded() {
        let mut g = build_heterogeneous_grid(64, 32, 1, 3_000_000, 16..32, 8..24);
        g.set_iter_limit(2_000_000);
        g.finalize();
        let _flow = g.solve();
        eprintln!(
            "[bk-perf] 64×32 heterogeneous grid: BK ran {} iterations",
            g.augment_iters()
        );
        assert!(
            g.augment_iters() < 1_000_000,
            "64×32 BK ran {} iters",
            g.augment_iters()
        );
    }
}
