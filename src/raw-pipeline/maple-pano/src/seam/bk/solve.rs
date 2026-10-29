//! Algorithm internals for [`super::BkGraph`]: the grow / augment / adopt
//! phases of Boykov-Kolmogorov max-flow. Split out of `bk/mod.rs` (which
//! keeps the graph-building API) to respect the file-size budget — see
//! that module's doc comment for the algorithm reference and the
//! parent-edge convention these walks rely on.

use std::collections::VecDeque;

use super::{BkGraph, Node, NodeId, Tree, NO_EDGE, ORPHAN, TERMINAL};

impl BkGraph {
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
                let head = self.edges[ei as usize].head;
                let tree_q = self.nodes[head as usize].tree;
                let sister = ei ^ 1;
                let towards_head = self.edges[ei as usize].residual > 0;
                let towards_p = self.edges[sister as usize].residual > 0;

                match (tree_p, tree_q) {
                    (Tree::Source, Tree::None) if towards_head => self.attach(head, p, sister),
                    (Tree::Sink, Tree::None) if towards_p => self.attach(head, p, sister),
                    (Tree::Source, Tree::Sink) if towards_head => return Some((ei, sister)),
                    (Tree::Sink, Tree::Source) if towards_p => return Some((sister, ei)),
                    _ => {}
                }
            }

            self.active.pop_front();
            self.nodes[p as usize].is_active = false;
        }
        None
    }

    fn attach(&mut self, child: NodeId, parent: NodeId, child_to_parent: u32) {
        let (tree, dist, timestamp) = {
            let p = &self.nodes[parent as usize];
            (p.tree, p.dist + 1, p.timestamp)
        };
        let node = &mut self.nodes[child as usize];
        node.tree = tree;
        node.parent_edge = child_to_parent;
        node.dist = dist;
        node.timestamp = timestamp;
        Self::do_enqueue(&mut self.active, &mut self.nodes, child);
    }

    /// Residual capacity of `node`'s tree edge in the flow direction:
    /// parent->node in the S-tree, node->parent in the T-tree.
    fn tree_edge_capacity(&self, node: NodeId, tree: Tree) -> i64 {
        let pe = self.nodes[node as usize].parent_edge;
        match tree {
            Tree::Source => self.edges[pe as usize ^ 1].residual,
            _ => self.edges[pe as usize].residual,
        }
    }

    /// Path from `start` up to its tree root, excluding the root.
    fn walk_to_root(&self, start: NodeId) -> (Vec<NodeId>, NodeId) {
        let mut path = Vec::new();
        let mut cur = start;
        loop {
            let pe = self.nodes[cur as usize].parent_edge;
            debug_assert!(
                pe != ORPHAN && pe != NO_EDGE,
                "augmenting path through a non-tree node"
            );
            if pe == TERMINAL {
                return (path, cur);
            }
            path.push(cur);
            cur = self.edges[pe as usize].head;
        }
    }

    /// `s_edge`: S-tree -> T-tree crossing edge (positive residual).
    /// `t_edge = s_edge ^ 1`.
    pub(super) fn augment(&mut self, s_edge: u32, t_edge: u32) {
        let (s_path, s_root) = self.walk_to_root(self.edges[t_edge as usize].head);
        let (t_path, t_root) = self.walk_to_root(self.edges[s_edge as usize].head);

        let bottleneck = s_path
            .iter()
            .map(|&n| self.tree_edge_capacity(n, Tree::Source))
            .chain(
                t_path
                    .iter()
                    .map(|&n| self.tree_edge_capacity(n, Tree::Sink)),
            )
            .fold(
                self.edges[s_edge as usize]
                    .residual
                    .min(self.nodes[s_root as usize].terminal_cap)
                    .min(-self.nodes[t_root as usize].terminal_cap),
                i64::min,
            );
        debug_assert!(bottleneck > 0, "augmenting path with no residual capacity");
        self.flow += bottleneck;

        self.edges[s_edge as usize].residual -= bottleneck;
        self.edges[t_edge as usize].residual += bottleneck;

        for (&n, tree) in s_path
            .iter()
            .map(|n| (n, Tree::Source))
            .chain(t_path.iter().map(|n| (n, Tree::Sink)))
        {
            let pe = self.nodes[n as usize].parent_edge as usize;
            let (forward, backward) = match tree {
                Tree::Source => (pe ^ 1, pe),
                _ => (pe, pe ^ 1),
            };
            self.edges[forward].residual -= bottleneck;
            self.edges[backward].residual += bottleneck;
            if self.edges[forward].residual == 0 {
                self.make_orphan(n);
            }
        }

        self.nodes[s_root as usize].terminal_cap -= bottleneck;
        if self.nodes[s_root as usize].terminal_cap == 0 {
            self.make_orphan(s_root);
        }
        self.nodes[t_root as usize].terminal_cap += bottleneck;
        if self.nodes[t_root as usize].terminal_cap == 0 {
            self.make_orphan(t_root);
        }
    }

    fn make_orphan(&mut self, node: NodeId) {
        self.nodes[node as usize].parent_edge = ORPHAN;
        self.orphans.push_back(node);
    }

    pub(super) fn adopt(&mut self) {
        while let Some(p) = self.orphans.pop_front() {
            let tree_p = self.nodes[p as usize].tree;
            if tree_p == Tree::None || self.try_find_parent(p, tree_p) {
                continue;
            }

            let first = self.nodes[p as usize].first_adj;
            let count = self.nodes[p as usize].adj_count;
            for k in 0..count {
                let ei = self.node_adj[(first + k) as usize];
                let head = self.edges[ei as usize].head;
                let sister = ei ^ 1;
                if self.nodes[head as usize].tree != tree_p {
                    continue;
                }
                let can_regrow_p = match tree_p {
                    Tree::Source => self.edges[sister as usize].residual > 0,
                    _ => self.edges[ei as usize].residual > 0,
                };
                if can_regrow_p {
                    Self::do_enqueue(&mut self.active, &mut self.nodes, head);
                }
                if self.nodes[head as usize].parent_edge == sister {
                    self.make_orphan(head);
                }
            }

            self.nodes[p as usize].tree = Tree::None;
            self.nodes[p as usize].parent_edge = NO_EDGE;
        }
    }

    /// Re-attach orphan `p` to the neighbour in `tree_p` with the shortest
    /// still-valid path to the terminal (Kolmogorov's adoption rule).
    fn try_find_parent(&mut self, p: NodeId, tree_p: Tree) -> bool {
        let first = self.nodes[p as usize].first_adj;
        let count = self.nodes[p as usize].adj_count;

        let best = (0..count)
            .map(|k| self.node_adj[(first + k) as usize])
            .filter(|&ei| {
                let head = self.edges[ei as usize].head;
                let capacity = match tree_p {
                    Tree::Source => self.edges[ei as usize ^ 1].residual,
                    _ => self.edges[ei as usize].residual,
                };
                self.nodes[head as usize].tree == tree_p && capacity > 0
            })
            .collect::<Vec<u32>>()
            .into_iter()
            .filter_map(|ei| {
                self.distance_to_terminal(self.edges[ei as usize].head)
                    .map(|d| (d, ei))
            })
            .min_by_key(|&(d, _)| d);

        let Some((dist, ei)) = best else {
            return false;
        };
        let node = &mut self.nodes[p as usize];
        node.parent_edge = ei;
        node.dist = dist + 1;
        node.timestamp = self.timestamp;
        true
    }

    /// Distance from `node` to its terminal along parent edges, or `None`
    /// when the chain ends at an orphan. Nodes stamped with the current
    /// timestamp were verified earlier in this adoption phase, so the walk
    /// stops there; every node it verifies is stamped with its distance.
    fn distance_to_terminal(&mut self, node: NodeId) -> Option<u32> {
        let ts = self.timestamp;
        let mut path = Vec::new();
        let mut cur = node;
        let base = loop {
            let n = &self.nodes[cur as usize];
            if n.timestamp == ts {
                break n.dist;
            }
            match n.parent_edge {
                TERMINAL => {
                    path.push(cur);
                    break 0;
                }
                ORPHAN | NO_EDGE => return None,
                pe => {
                    path.push(cur);
                    cur = self.edges[pe as usize].head;
                }
            }
        };
        let total = base + path.len() as u32;
        for (i, &n) in path.iter().enumerate() {
            self.nodes[n as usize].timestamp = ts;
            self.nodes[n as usize].dist = total - i as u32;
        }
        Some(total)
    }

    pub(super) fn do_enqueue(active: &mut VecDeque<NodeId>, nodes: &mut [Node], node: NodeId) {
        if !nodes[node as usize].is_active {
            nodes[node as usize].is_active = true;
            active.push_back(node);
        }
    }
}
