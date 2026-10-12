//! Structured-grid candidate prior for drone surveys and camera arrays
//! (#4519).
//!
//! Global descriptor nomination (`DescriptorTopKProvider`) and
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
//! - [`super::grid_gate`] then admits or rejects every non-neighbour
//!   (loop-closure) edge after two-view verification.
//!
//! `cols` is the number of frames per pass; a column-major flight is
//! the same grid transposed (`C × R`), which preserves every neighbour
//! relation. A ragged final pass (fewer than `cols` frames) is allowed;
//! in serpentine order a reversed final pass fills from the far end.

use super::{CandidateProvider, GraphImage};

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

    pub(super) fn neighbours(&self, index: usize, frame_count: usize) -> Vec<usize> {
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

#[cfg(test)]
#[path = "grid_prior_tests.rs"]
mod tests;
