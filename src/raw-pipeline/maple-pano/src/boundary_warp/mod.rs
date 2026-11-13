//! Boundary Warp: stretch a panorama's irregular edge out to the full
//! output rectangle (#5570, slice #5571).
//!
//! [`solve`] takes the panorama's [`Footprint`] on a downscaled copy of the
//! output canvas and a strength `t ∈ [0, 1]`, and returns a
//! [`BoundaryWarp`]: a map from each output position to the unwarped canvas
//! position the existing warp chain should sample. Every per-output-pixel
//! consumer evaluates its unchanged code at `u = unwarp(p)`, so each source
//! pixel is still resampled once. The map never decides validity: an output
//! pixel is valid exactly when today's coverage test passes at `u`.
//!
//! 1. The footprint's outer edge is traced and split into four arcs
//!    ([`footprint`]).
//! 2. A rest mesh inside the edge and an output mesh over the rectangle are
//!    solved with He et al.'s shape-preserving term ([`mesh`]).
//! 3. The full-strength map `u₁` is sampled onto a regular grid over the
//!    rectangle, and the slider blends `unwarp_t(p) = (1 − t)·p + t·u₁(p)`,
//!    defined everywhere in the rectangle for every `t` ([`grid`]).
//! 4. `t` is held below the first value at which any cell of the map would
//!    shrink under [`MIN_JACOBIAN_RATIO`] of its rest area.
//!
//! Coordinates are normalised to the rectangle, so one map serves the
//! preview canvas and any output size.

mod footprint;
mod grid;
mod mesh;
mod sparse;

use std::time::Instant;

use serde::{Deserialize, Serialize};

pub use footprint::{Footprint, FootprintError};

/// The solve runs on the footprint coarsened to this long edge: its inset
/// and smoothing are measured in cells, and the mesh needs no finer grid.
const WORK_LONG_EDGE: u32 = 512;
/// About this many vertices in each mesh.
const MESH_VERTICES: usize = 1600;
/// Inverse-grid nodes per output-mesh quad along each axis.
const GRID_PER_QUAD: usize = 4;
/// No cell may shrink below this fraction of its rest area.
const MIN_JACOBIAN_RATIO: f64 = 0.05;
/// A fold limit below this is reported as a refusal rather than a warp.
const MIN_APPLIED: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryWarpStatus {
    /// Strength 0: no map.
    Off,
    Applied,
    /// Applied below the requested strength, which would fold the map.
    ClampedFold,
    RefusedFullWrap,
    RefusedDisconnected,
    RefusedEmpty,
    /// The traced edge's corners do not run around it in order.
    RefusedShape,
    /// Even a strength of [`MIN_APPLIED`] would shrink a cell below
    /// [`MIN_JACOBIAN_RATIO`] of its rest area.
    RefusedFold,
    RefusedSolve,
}

impl BoundaryWarpStatus {
    pub fn is_refused(self) -> bool {
        !matches!(self, Self::Off | Self::Applied | Self::ClampedFold)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoundaryWarpReport {
    pub requested: f64,
    pub applied: f64,
    pub status: BoundaryWarpStatus,
    /// Largest local area magnification of the map (1 when off).
    pub max_stretch: f64,
    /// Smallest local Jacobian determinant relative to the identity's.
    pub min_jacobian: f64,
    /// Fraction of all canvas cells whose unwarped position is covered (the
    /// footprint's own coverage when no map is applied).
    pub predicted_coverage: f64,
    pub solve_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryWarpOutcome {
    pub map: Option<BoundaryWarp>,
    pub report: BoundaryWarpReport,
}

/// `unwarp_t` sampled on a `cols × rows` regular node grid over the output
/// rectangle, in normalised coordinates, at the applied strength.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryWarp {
    cols: usize,
    rows: usize,
    nodes: Vec<(f64, f64)>,
}

impl BoundaryWarp {
    /// The map in the pixel coordinates of a `width × height` canvas.
    pub fn on_canvas(&self, width: u32, height: u32) -> CanvasWarp<'_> {
        CanvasWarp {
            map: self,
            width: width as f64,
            height: height as f64,
        }
    }

    fn node(&self, i: usize, j: usize) -> (f64, f64) {
        self.nodes[j * self.cols + i]
    }

    fn cell_of(&self, nx: f64, ny: f64) -> (usize, usize, f64, f64) {
        let gx = nx.clamp(0.0, 1.0) * (self.cols - 1) as f64;
        let gy = ny.clamp(0.0, 1.0) * (self.rows - 1) as f64;
        let (i, j) = (
            (gx as usize).min(self.cols - 2),
            (gy as usize).min(self.rows - 2),
        );
        (i, j, gx - i as f64, gy - j as f64)
    }
}

/// A [`BoundaryWarp`] scaled to one canvas.
#[derive(Debug, Clone, Copy)]
pub struct CanvasWarp<'a> {
    map: &'a BoundaryWarp,
    width: f64,
    height: f64,
}

impl CanvasWarp<'_> {
    /// The unwarped canvas position output pixel position `(px, py)` samples.
    #[inline]
    pub fn unwarp(&self, px: f64, py: f64) -> (f64, f64) {
        let m = self.map;
        let (i, j, s, r) = m.cell_of(px / self.width, py / self.height);
        let q = [
            m.node(i, j),
            m.node(i + 1, j),
            m.node(i + 1, j + 1),
            m.node(i, j + 1),
        ];
        let (ux, uy) = grid::bilinear(&q, s, r);
        (ux * self.width, uy * self.height)
    }

    /// A box holding `unwarp(p)` for every `p` in the output rectangle with
    /// corners `(x0, y0)` and `(x1, y1)`: the nodes of every cell the
    /// rectangle touches, since within a cell the map is a convex combination
    /// of its four nodes. It can exceed the tight box by up to a cell.
    pub fn unwarped_bounds(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> (f64, f64, f64, f64) {
        let m = self.map;
        let (i0, j0, _, _) = m.cell_of(x0.min(x1) / self.width, y0.min(y1) / self.height);
        let (i1, j1, _, _) = m.cell_of(x0.max(x1) / self.width, y0.max(y1) / self.height);
        let (bx0, by0, bx1, by1) = grid::bounds(
            (j0..=j1 + 1)
                .flat_map(|j| (i0..=i1 + 1).map(move |i| (i, j)))
                .map(|(i, j)| m.node(i, j)),
        );
        (
            bx0 * self.width,
            by0 * self.height,
            bx1 * self.width,
            by1 * self.height,
        )
    }

    /// The output pixels whose unwarped position can fall in the canvas box
    /// `[x0, x1] × [y0, y1]`, as a half-open pixel box `(x0, y0, x1, y1)`:
    /// every map cell whose nodes' box meets it. `None` when no cell does.
    pub fn output_box(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> Option<(u32, u32, u32, u32)> {
        let m = self.map;
        let (step_x, step_y) = (
            self.width / (m.cols - 1) as f64,
            self.height / (m.rows - 1) as f64,
        );
        let (i0, j0, i1, j1) = (0..m.rows - 1)
            .flat_map(|j| (0..m.cols - 1).map(move |i| (i, j)))
            .filter(|&(i, j)| {
                let (bx0, by0, bx1, by1) = grid::bounds(
                    [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
                        .into_iter()
                        .map(|(i, j)| m.node(i, j)),
                );
                bx0 * self.width <= x1
                    && bx1 * self.width >= x0
                    && by0 * self.height <= y1
                    && by1 * self.height >= y0
            })
            .fold((usize::MAX, usize::MAX, 0, 0), |(a, b, c, d), (i, j)| {
                (a.min(i), b.min(j), c.max(i + 1), d.max(j + 1))
            });
        let pixel = |cell: usize, step: f64, round: fn(f64) -> f64, len: f64| {
            round(cell as f64 * step).clamp(0.0, len) as u32
        };
        (i0 != usize::MAX).then(|| {
            (
                pixel(i0, step_x, f64::floor, self.width),
                pixel(j0, step_y, f64::floor, self.height),
                pixel(i1, step_x, f64::ceil, self.width),
                pixel(j1, step_y, f64::ceil, self.height),
            )
        })
    }
}

/// Solves the boundary warp of `footprint` at `strength`, clamped to
/// `[0, 1]` (NaN reads as 0).
pub fn solve(footprint: &Footprint, strength: f64) -> BoundaryWarpOutcome {
    let started = Instant::now();
    let requested = if strength.is_nan() {
        0.0
    } else {
        strength.clamp(0.0, 1.0)
    };
    let refused = |status: BoundaryWarpStatus| BoundaryWarpOutcome {
        map: None,
        report: BoundaryWarpReport {
            requested,
            applied: 0.0,
            status,
            max_stretch: 1.0,
            min_jacobian: 1.0,
            predicted_coverage: coverage(footprint, None),
            solve_ms: started.elapsed().as_secs_f64() * 1e3,
        },
    };
    if requested == 0.0 {
        return refused(BoundaryWarpStatus::Off);
    }
    if footprint.is_full_wrap() {
        return refused(BoundaryWarpStatus::RefusedFullWrap);
    }
    if footprint.width() == 0 || footprint.height() == 0 {
        return refused(BoundaryWarpStatus::RefusedEmpty);
    }
    let work = footprint.coarsened(WORK_LONG_EDGE);
    match full_strength(&work) {
        Err(status) => refused(status),
        Ok(full) => {
            let (cols, rows) = (full.cols, full.rows);
            let dims = (work.width() as f64, work.height() as f64);
            let limit = grid::fold_limit(&full.nodes, cols, rows, dims, MIN_JACOBIAN_RATIO);
            if limit < MIN_APPLIED {
                return refused(BoundaryWarpStatus::RefusedFold);
            }
            let applied = requested.min(limit);
            let map = BoundaryWarp {
                cols,
                rows,
                nodes: grid::blend(&full.nodes, cols, rows, applied),
            };
            let min_jacobian = grid::min_jacobian(&map.nodes, cols, rows, dims);
            BoundaryWarpOutcome {
                report: BoundaryWarpReport {
                    requested,
                    applied,
                    status: if applied < requested {
                        BoundaryWarpStatus::ClampedFold
                    } else {
                        BoundaryWarpStatus::Applied
                    },
                    max_stretch: 1.0 / min_jacobian,
                    min_jacobian,
                    predicted_coverage: coverage(footprint, Some(&map)),
                    solve_ms: started.elapsed().as_secs_f64() * 1e3,
                },
                map: Some(map),
            }
        }
    }
}

/// The full-strength map `u₁`.
fn full_strength(footprint: &Footprint) -> Result<BoundaryWarp, BoundaryWarpStatus> {
    let (w, h) = (footprint.width() as f64, footprint.height() as f64);
    let (cols, rows) = mesh::mesh_dims(w, h, MESH_VERTICES);
    let cell = (w / (cols - 1) as f64).max(1.0).round() as usize;
    let edge = footprint::outer_edge(footprint, cell)?;
    let rest = mesh::rest_mesh(&edge, cols, rows)?;
    let out = mesh::output_mesh(&rest, w, h)?;
    let (gc, gr) = (
        GRID_PER_QUAD * (cols - 1) + 1,
        GRID_PER_QUAD * (rows - 1) + 1,
    );
    // A rest mesh folded inside a strongly non-convex edge makes the
    // shape-preserving output mesh fold with it; the rest mesh laid over the
    // regular grid still gives a map, and the fold limit holds `t` short of
    // its folds.
    let nodes = out
        .is_unfolded()
        .then(|| grid::sample_inverse(&rest, &out, (w, h), gc, gr))
        .flatten()
        .unwrap_or_else(|| grid::sample_regular(&rest, (w, h), GRID_PER_QUAD));
    Ok(BoundaryWarp {
        cols: gc,
        rows: gr,
        nodes,
    })
}

fn coverage(footprint: &Footprint, map: Option<&BoundaryWarp>) -> f64 {
    let (w, h) = (footprint.width(), footprint.height());
    let total = w as usize * h as usize;
    if total == 0 {
        return 0.0;
    }
    let warp = map.map(|m| m.on_canvas(w, h));
    let covered = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x as f64 + 0.5, y as f64 + 0.5)))
        .filter(|&(px, py)| {
            let (ux, uy) = warp.map_or((px, py), |c| c.unwarp(px, py));
            footprint.covers(ux, uy)
        })
        .count();
    covered as f64 / total as f64
}

#[cfg(test)]
mod tests;
