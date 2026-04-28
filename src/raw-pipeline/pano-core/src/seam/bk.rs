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
        }
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
        loop {
            self.timestamp += 1;
            match self.grow() {
                Some((s_edge, t_edge)) => {
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

        let mut bottleneck = self.edges[s_edge as usize].residual;

        // S-tree walk v → source.
        // parent_edge = arc child→parent.  Capacity in flow direction (parent→child) = sister.
        {
            let mut cur = v;
            loop {
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    // terminal_cap = remaining source capacity for this node.
                    bottleneck = bottleneck.min(self.nodes[cur as usize].terminal_cap);
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                // S-tree: pe = cur→parent.  Flow direction parent→cur = pe^1.
                bottleneck = bottleneck.min(self.edges[pe as usize ^ 1].residual);
                // Advance to parent: edges[pe].head = parent.
                cur = self.edges[pe as usize].head;
            }
        }

        // T-tree walk u → sink.
        // parent_edge = arc parent→child.  Capacity in flow direction (= parent→child) = pe.
        {
            let mut cur = u;
            loop {
                let pe = self.nodes[cur as usize].parent_edge;
                if pe == TERMINAL {
                    // terminal_cap is negative; remaining sink capacity = -tc.
                    bottleneck = bottleneck.min(-self.nodes[cur as usize].terminal_cap);
                    break;
                }
                if pe == ORPHAN || pe == NO_EDGE {
                    break;
                }
                // T-tree: pe = parent→cur.  Flow direction = parent→cur = pe.
                bottleneck = bottleneck.min(self.edges[pe as usize].residual);
                // Advance to parent: parent = edges[pe^1].head (sister of pe goes cur→parent).
                // Wait: pe = arc parent→cur, so edges[pe].head = cur.
                // To advance to parent from cur: we need edges[pe^1].head.
                // pe^1 = arc cur→parent, edges[pe^1].head = parent. ✓
                cur = self.edges[pe as usize ^ 1].head;
            }
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
            loop {
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
            loop {
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

        loop {
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
}
