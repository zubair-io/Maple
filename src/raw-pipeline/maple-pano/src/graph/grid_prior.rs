//! Structured-grid candidate prior for drone surveys and camera arrays
//! (#4519).
//!
//! Global descriptor nomination ([`super::DescriptorTopKProvider`]) and
//! the gimbal prior both misbehave on nadir grids: repetitive terrain
//! (fields, roofs) ranks unrelated frames as similar, and a fixed nadir
//! gimbal puts every frame inside every other's prior cone — false loop
//! closures plus quadratic verification. When the operator declares the
//! capture as an `R × C` grid flown in raster or serpentine order, the
//! frame index alone says where each frame sits, so:
//!
//! - [`GridPriorProvider`] nominates the 4-connected neighbours (plus
//!   diagonals when asked) and the loop-closure pairs that share a
//!   common neighbour — a constant number per frame, O(N) overall.
//! - [`MatchGraph::admit_grid_loop_closures`] runs after two-view
//!   verification. Neighbour edges are the prior and always stay; any
//!   other verified edge survives only when its frames lie within
//!   [`LOOP_CLOSURE_MAX_CELLS`] of each other on the grid (the footprint
//!   gate) **and** some triangle through two verified neighbour edges
//!   reproduces its relative rotation within
//!   [`LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG`] (the cycle-consistency
//!   gate). Rejections move to [`MatchGraph::rejected`] with their
//!   reason — reported, never silently dropped.
//!
//! The footprint is measured in grid cells: frame priors carry no GPS
//! position today, so the declared grid is the only metric layout.
//!
//! `cols` is the number of frames per pass; a column-major flight is
//! the same grid transposed (`C × R`), which preserves every neighbour
//! relation. A ragged final pass (fewer than `cols` frames) is allowed;
//! in serpentine order a reversed final pass fills from the far end.

use std::collections::BTreeMap;

use super::{connected_components, orphans_of, CandidateProvider, GraphImage, MatchGraph};
use super::{RejectedPair, VerifiedEdge};
use crate::math::Mat3;
use crate::robust::VerifyFailure;
use crate::twoview::rotation_angle_between;

/// Chebyshev grid distance beyond which two frames cannot overlap on a
/// survey flown at normal (≤ ~80 %) forward/side overlap.
pub const LOOP_CLOSURE_MAX_CELLS: usize = 2;

/// Two composed neighbour rotations each carry the verifier's
/// sub-0.5° noise; a real loop closure lands well inside this, a false
/// match on repetitive texture lands far outside.
pub const LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG: f64 = 2.0;

/// Capture order of the frames within the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridOrder {
    /// Every pass runs in the same direction.
    Raster,
    /// Alternate passes reverse direction (boustrophedon / lawnmower).
    Serpentine,
}

/// A declared `rows × cols` capture grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridLayout {
    pub rows: usize,
    /// Frames per pass.
    pub cols: usize,
    pub order: GridOrder,
    /// Also treat diagonal cells as neighbours.
    pub diagonals: bool,
}

impl GridLayout {
    /// Accepts any frame count that fills every pass but the last, which
    /// must hold at least one frame.
    pub fn validate(&self, frame_count: usize) -> Result<(), String> {
        let capacity = self.rows * self.cols;
        if self.rows == 0 || self.cols == 0 {
            Err(format!("grid {}x{} has no cells", self.rows, self.cols))
        } else if frame_count > capacity || frame_count <= capacity - self.cols {
            Err(format!(
                "grid {}x{} needs {}..={} frames, got {frame_count}",
                self.rows,
                self.cols,
                capacity - self.cols + 1,
                capacity
            ))
        } else {
            Ok(())
        }
    }

    /// `(row, col)` of capture index `index`, or `None` past the grid.
    pub fn cell(&self, index: usize) -> Option<(usize, usize)> {
        let (row, step) = (index / self.cols, index % self.cols);
        (row < self.rows).then(|| (row, self.column(row, step)))
    }

    fn column(&self, row: usize, step: usize) -> usize {
        match self.order {
            GridOrder::Serpentine if row % 2 == 1 => self.cols - 1 - step,
            _ => step,
        }
    }

    /// Inverse of [`Self::cell`], bounded by `frame_count`.
    fn index(&self, row: usize, col: usize, frame_count: usize) -> Option<usize> {
        (row < self.rows && col < self.cols)
            .then(|| row * self.cols + self.column(row, col))
            .filter(|&index| index < frame_count)
    }

    /// Chebyshev distance in cells between two capture indices.
    pub fn cell_distance(&self, a: usize, b: usize) -> Option<usize> {
        let ((ra, ca), (rb, cb)) = (self.cell(a)?, self.cell(b)?);
        Some(ra.abs_diff(rb).max(ca.abs_diff(cb)))
    }

    pub fn is_neighbour(&self, a: usize, b: usize) -> bool {
        match (self.cell(a), self.cell(b)) {
            (Some((ra, ca)), Some((rb, cb))) => {
                let (dr, dc) = (ra.abs_diff(rb), ca.abs_diff(cb));
                dr + dc == 1 || (self.diagonals && dr == 1 && dc == 1)
            }
            _ => false,
        }
    }

    fn neighbours(&self, index: usize, frame_count: usize) -> Vec<usize> {
        let Some((row, col)) = self.cell(index) else {
            return Vec::new();
        };
        let offsets: &[(isize, isize)] = if self.diagonals {
            &[
                (-1, -1),
                (-1, 0),
                (-1, 1),
                (0, -1),
                (0, 1),
                (1, -1),
                (1, 0),
                (1, 1),
            ]
        } else {
            &[(-1, 0), (0, -1), (0, 1), (1, 0)]
        };
        offsets
            .iter()
            .filter_map(|&(dr, dc)| {
                let r = row.checked_add_signed(dr)?;
                let c = col.checked_add_signed(dc)?;
                self.index(r, c, frame_count)
            })
            .collect()
    }
}

/// Grid neighbours plus the shared-neighbour loop-closure pairs.
#[derive(Debug, Clone, Copy)]
pub struct GridPriorProvider {
    pub layout: GridLayout,
}

impl CandidateProvider for GridPriorProvider {
    fn name(&self) -> &'static str {
        "grid-prior"
    }

    fn candidates(&self, images: &[GraphImage]) -> Vec<(usize, usize)> {
        let n = images.len();
        let adjacency: Vec<Vec<usize>> = (0..n).map(|i| self.layout.neighbours(i, n)).collect();
        let direct = adjacency
            .iter()
            .enumerate()
            .flat_map(|(i, ns)| ns.iter().filter(move |&&j| i < j).map(move |&j| (i, j)));
        let closures = adjacency.iter().enumerate().flat_map(|(i, ns)| {
            ns.iter()
                .flat_map(|&j| adjacency[j].iter().copied())
                .filter(move |&k| i < k && !self.layout.is_neighbour(i, k))
                .map(move |k| (i, k))
        });
        direct.chain(closures).collect()
    }
}

impl MatchGraph {
    /// Apply the structured-grid loop-closure gate (module docs) in
    /// place; returns how many edges it rejected. Components and orphans
    /// are recomputed.
    pub fn admit_grid_loop_closures(&mut self, layout: &GridLayout) -> usize {
        let trusted: BTreeMap<(usize, usize), Mat3> = self
            .edges
            .iter()
            .filter(|e| layout.is_neighbour(e.a, e.b))
            .map(|e| ((e.a, e.b), e.rotation))
            .collect();
        let (kept, refused): (Vec<_>, Vec<_>) = std::mem::take(&mut self.edges)
            .into_iter()
            .map(|e| {
                let verdict = loop_closure_verdict(&e, layout, self.image_count, &trusted);
                (e, verdict)
            })
            .partition(|(_, verdict)| verdict.is_none());
        let rejected_count = refused.len();
        self.edges = kept.into_iter().map(|(e, _)| e).collect();
        self.rejected
            .extend(refused.into_iter().filter_map(|(e, verdict)| {
                verdict.map(|reason| RejectedPair {
                    a: e.a,
                    b: e.b,
                    reason,
                })
            }));
        self.rejected.sort_by_key(|r| (r.a, r.b));
        self.components = connected_components(self.image_count, &self.edges);
        self.orphans = orphans_of(&self.components);
        rejected_count
    }
}

/// `None` admits the edge; `Some(reason)` rejects it.
fn loop_closure_verdict(
    edge: &VerifiedEdge,
    layout: &GridLayout,
    frame_count: usize,
    trusted: &BTreeMap<(usize, usize), Mat3>,
) -> Option<VerifyFailure> {
    if layout.is_neighbour(edge.a, edge.b) {
        return None;
    }
    let cells = layout.cell_distance(edge.a, edge.b).unwrap_or(usize::MAX);
    if cells > LOOP_CLOSURE_MAX_CELLS {
        return Some(VerifyFailure::LoopClosureOutsideFootprint { cells });
    }
    let directed = |from: usize, to: usize| -> Option<Mat3> {
        if from < to {
            trusted.get(&(from, to)).copied()
        } else {
            trusted.get(&(to, from)).map(Mat3::transpose)
        }
    };
    let best_triangle_error_deg = layout
        .neighbours(edge.a, frame_count)
        .into_iter()
        .filter_map(|k| {
            let via = directed(k, edge.b)?.mul_mat(&directed(edge.a, k)?);
            Some(rotation_angle_between(&via, &edge.rotation).to_degrees())
        })
        .min_by(f64::total_cmp);
    match best_triangle_error_deg {
        Some(err) if err <= LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG => None,
        _ => Some(VerifyFailure::LoopClosureUnconfirmed {
            best_triangle_error_deg,
        }),
    }
}

#[cfg(test)]
#[path = "grid_prior_tests.rs"]
mod tests;
