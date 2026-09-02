//! Algorithm internals for [`super::BkGraph`]: the grow / augment / adopt
//! phases of Boykov-Kolmogorov max-flow. Split out of `bk/mod.rs` (which
//! keeps the graph-building API) to respect the file-size budget — see
//! that module's doc comment for the algorithm reference and the known
//! parent-edge-cycle mitigation these walks implement.

use std::collections::VecDeque;

use super::{BkGraph, Node, NodeId, Tree, NO_EDGE, ORPHAN, TERMINAL};

impl BkGraph {
    // -----------------------------------------------------------------------
    // Growth phase
    // -----------------------------------------------------------------------

    /// Returns `Some((s_edge, t_edge))` where `s_edge` is the S->T crossing
    /// edge (positive residual in S->T direction) and `t_edge = s_edge ^ 1`.
    pub(super) fn grow(&mut self) -> Option<(u32, u32)> {
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
                // edge `ei` goes p -> head.
                let head = self.edges[ei as usize].head;
                let tree_q = self.nodes[head as usize].tree;
                let sister = ei ^ 1;

                match (tree_p, tree_q) {
                    // ---- Grow S-tree from p to free node head ----
                    // Need edges[ei].residual > 0 (capacity p->head).
                    // S-tree: head.parent_edge = arc head->p = sister.
                    (Tree::Source, Tree::None) if self.edges[ei as usize].residual > 0 => {
                        self.nodes[head as usize].tree = Tree::Source;
                        self.nodes[head as usize].parent_edge = sister; // head->p
                        self.nodes[head as usize].dist = self.nodes[p as usize].dist + 1;
                        self.nodes[head as usize].timestamp = self.timestamp;
                        Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                    }
                    // ---- Grow T-tree from p to free node head ----
                    // Kolmogorov grows T-tree using sister's capacity (=capacity head->p).
                    // T-tree: head.parent_edge = arc p->head = ei.
                    (Tree::Sink, Tree::None) if self.edges[sister as usize].residual > 0 => {
                        self.nodes[head as usize].tree = Tree::Sink;
                        self.nodes[head as usize].parent_edge = ei; // p->head
                        self.nodes[head as usize].dist = self.nodes[p as usize].dist + 1;
                        self.nodes[head as usize].timestamp = self.timestamp;
                        Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                    }
                    // ---- Crossing: S-tree p -> T-tree head ----
                    // Need capacity p->head > 0.
                    (Tree::Source, Tree::Sink) if self.edges[ei as usize].residual > 0 => {
                        return Some((ei, sister));
                    }
                    // ---- Crossing: T-tree p, S-tree head ----
                    // Augmenting edge S->T is sister (head->p). Need sister.residual > 0.
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

    /// `s_edge`: S-tree -> T-tree crossing edge (positive residual).
    /// `t_edge = s_edge ^ 1`.
    pub(super) fn augment(&mut self, s_edge: u32, t_edge: u32) {
        // s_edge goes S-node -> T-node.
        let u = self.edges[s_edge as usize].head; // T-tree side
        let v = self.edges[t_edge as usize].head; // S-tree side

        // ---- Compute bottleneck -------------------------------------------

        // Defensive walk-step cap. In a correctly-maintained BK tree these
        // walks are O(tree-depth) <= O(n_nodes). If they exceed that, our
        // adopt()/try_find_parent() pair has created a parent_edge cycle (a
        // known bug in this implementation — see the module-level "Known
        // correctness limitation" comment). When it happens we abort the
        // augmenting path rather than looping forever; flow is left
        // under-augmented but the overall solver still terminates.
        let walk_cap = self.nodes.len() as u64 + 32;
        let mut bottleneck = self.edges[s_edge as usize].residual;
        let mut path_aborted = false;

        // S-tree walk v -> source.
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

        // T-tree walk u -> sink.
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
            // candidate from future grow() searches, otherwise grow will
            // keep returning the same crossing edge and loop us forever at
            // the BK-iteration level.
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

        // ---- Push flow: S-tree path v -> source ------------------------------
        // S-tree: pe = cur->parent. Flow direction parent->cur: increase
        // pe.residual, decrease pe^1.
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
                // Flow direction = pe^1 (parent->cur): decrease its residual, increase pe.
                self.edges[pe as usize ^ 1].residual -= bottleneck;
                self.edges[pe as usize].residual += bottleneck;
                if self.edges[pe as usize ^ 1].residual == 0 {
                    // The tree-edge capacity in flow direction reached 0 -> orphan cur.
                    self.nodes[cur as usize].parent_edge = ORPHAN;
                    self.orphans.push_back(cur);
                }
                cur = self.edges[pe as usize].head; // advance to parent
            }
        }

        // ---- Push flow: T-tree path u -> sink --------------------------------
        // T-tree: pe = parent->cur. Flow direction parent->cur: decrease
        // pe, increase pe^1.
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
                // Flow direction = pe (parent->cur): decrease its residual, increase pe^1.
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

    pub(super) fn adopt(&mut self) {
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
                // ei: p -> head
                let head = self.edges[ei as usize].head;
                let sister = ei ^ 1; // head -> p

                if self.nodes[head as usize].tree != tree_p {
                    continue;
                }

                // Is `head` a child of `p` in the tree?
                // S-tree: head.parent_edge = head->p = sister.
                // T-tree: head.parent_edge = p->head = ei.
                let head_pe = self.nodes[head as usize].parent_edge;
                let is_child = match tree_p {
                    Tree::Source => head_pe == sister,
                    Tree::Sink => head_pe == ei,
                    Tree::None => false,
                };
                if is_child {
                    self.nodes[head as usize].parent_edge = ORPHAN;
                    self.orphans.push_back(head);
                }

                // Re-enqueue head if there's capacity to grow/maintain the tree.
                // S-tree: capacity p->head = edges[ei].residual > 0.
                // T-tree: capacity head->p = edges[sister].residual > 0.
                let cap = match tree_p {
                    Tree::Source => self.edges[ei as usize].residual,
                    Tree::Sink => self.edges[sister as usize].residual,
                    Tree::None => 0,
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
            // ei: p -> head (candidate parent for S-tree; candidate
            // child-parent for T-tree).
            let head = self.edges[ei as usize].head;
            let sister = ei ^ 1; // head -> p

            if self.nodes[head as usize].tree != tree_p {
                continue;
            }

            // Required capacity for adopting head as p's new parent, in
            // both trees, reduces to `edges[sister].residual > 0` — see
            // the parent-edge convention in the module doc comment.
            // S-tree: p.parent_edge = arc p->head = ei.
            // T-tree: p.parent_edge = arc head->p = sister.
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
                    Tree::Source => ei,   // p.parent_edge = arc p->head = ei
                    Tree::Sink => sister, // p.parent_edge = arc head->p = sister
                    Tree::None => unreachable!(),
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

    /// Check whether `node` in `tree` has a valid (non-orphaned) path to
    /// its terminal.
    fn path_valid(&mut self, node: NodeId, tree: Tree, ts: u32) -> bool {
        let mut cur = node;
        let mut visited: Vec<NodeId> = Vec::new();
        // Defensive cap: in a correctly-maintained tree, walk depth <=
        // n_nodes. If we exceed that, parent_edges form a cycle (a known
        // invariant violation in this BK port — see the module-level
        // comment). Treat as "path invalid" so the caller skips this
        // candidate parent.
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
            // S-tree: pe = cur->parent. edges[pe].head = parent.
            // T-tree: pe = parent->cur. edges[pe^1].head = parent.
            let parent = match tree {
                Tree::Source => self.edges[pe as usize].head,
                Tree::Sink => self.edges[pe as usize ^ 1].head,
                Tree::None => return false,
            };
            if self.nodes[parent as usize].tree != tree {
                return false;
            }
            cur = parent;
        }
    }

    pub(super) fn do_enqueue(active: &mut VecDeque<NodeId>, nodes: &mut [Node], node: NodeId) {
        if !nodes[node as usize].is_active {
            nodes[node as usize].is_active = true;
            active.push_back(node);
        }
    }
}
