//! The two meshes of He et al. 2013 (*Rectangling Panoramic Images via
//! Warping*) Stage 2, shape term only.
//!
//! The rest mesh `U` sits inside the footprint: its boundary vertices are
//! spaced evenly along the four arcs of the traced outer edge and its
//! interior vertices are harmonic (each the mean of its four neighbours).
//! The output mesh `V` covers the rectangle `[0, w] × [0, h]`: each side's
//! vertices slide along that side, the corners are fixed, and the interior
//! is solved so every output quad is as close as possible to a similarity
//! transform of its rest quad.

use super::footprint::{sample_arc, OuterEdge};
use super::sparse::SystemBuilder;
use super::BoundaryWarpStatus;

const CG_TOLERANCE: f64 = 1e-10;
const CG_MAX_ITERS: usize = 20_000;

/// A `cols × rows` vertex grid, row-major.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Mesh {
    pub(super) cols: usize,
    pub(super) rows: usize,
    pub(super) points: Vec<(f64, f64)>,
}

impl Mesh {
    pub(super) fn at(&self, i: usize, j: usize) -> (f64, f64) {
        self.points[j * self.cols + i]
    }

    /// Corners of quad `(i, j)` in the order `(i, j)`, `(i + 1, j)`,
    /// `(i + 1, j + 1)`, `(i, j + 1)`.
    pub(super) fn quad(&self, i: usize, j: usize) -> [(f64, f64); 4] {
        [
            self.at(i, j),
            self.at(i + 1, j),
            self.at(i + 1, j + 1),
            self.at(i, j + 1),
        ]
    }

    fn quad_ids(&self, i: usize, j: usize) -> [usize; 4] {
        let c = self.cols;
        [
            j * c + i,
            j * c + i + 1,
            (j + 1) * c + i + 1,
            (j + 1) * c + i,
        ]
    }

    /// Whether every corner of every quad turns the way the rest grid does
    /// (positive cross product of its two edges, y down).
    pub(super) fn is_unfolded(&self) -> bool {
        (0..self.rows - 1).all(|j| {
            (0..self.cols - 1).all(|i| corner_crosses(&self.quad(i, j)).iter().all(|&c| c > 0.0))
        })
    }
}

type Vector = (f64, f64);

/// The `s`- and `r`-direction edges at each corner of a quad, whose cross
/// product is the bilinear map's Jacobian determinant there.
pub(super) fn corner_edges(q: &[(f64, f64); 4]) -> [(Vector, Vector); 4] {
    let edge = |a: (f64, f64), b: (f64, f64)| (b.0 - a.0, b.1 - a.1);
    let (s_lo, s_hi) = (edge(q[0], q[1]), edge(q[3], q[2]));
    let (r_lo, r_hi) = (edge(q[0], q[3]), edge(q[1], q[2]));
    [(s_lo, r_lo), (s_lo, r_hi), (s_hi, r_hi), (s_hi, r_lo)]
}

pub(super) fn cross(u: Vector, v: Vector) -> f64 {
    u.0 * v.1 - u.1 * v.0
}

/// The Jacobian determinant at each corner of a quad, oriented so a regular
/// grid cell scores `+dx·dy` at all four.
pub(super) fn corner_crosses(q: &[(f64, f64); 4]) -> [f64; 4] {
    corner_edges(q).map(|(s, r)| cross(s, r))
}

/// Vertex counts giving roughly square quads over a `w × h` grid and about
/// `target` vertices, at least three per side.
pub(super) fn mesh_dims(w: f64, h: f64, target: usize) -> (usize, usize) {
    let quads = target as f64;
    let cols_q = (quads * w / h).sqrt().round().max(2.0) as usize;
    let rows_q = (quads * h / w).sqrt().round().max(2.0) as usize;
    (cols_q + 1, rows_q + 1)
}

pub(super) fn rest_mesh(
    edge: &OuterEdge,
    cols: usize,
    rows: usize,
) -> Result<Mesh, BoundaryWarpStatus> {
    let [tl, tr, br, bl] = edge.corners;
    let top = sample_arc(edge, tl, tr, cols);
    let right = sample_arc(edge, tr, br, rows);
    let bottom: Vec<_> = sample_arc(edge, br, bl, cols).into_iter().rev().collect();
    let left: Vec<_> = sample_arc(edge, bl, tl, rows).into_iter().rev().collect();
    let boundary = |i: usize, j: usize| match (i, j) {
        (_, 0) => Some(top[i]),
        (_, j) if j == rows - 1 => Some(bottom[i]),
        (0, _) => Some(left[j]),
        (i, _) if i == cols - 1 => Some(right[j]),
        _ => None,
    };
    let interior: Vec<(usize, usize)> = (1..rows - 1)
        .flat_map(|j| (1..cols - 1).map(move |i| (i, j)))
        .collect();
    let index = |i: usize, j: usize| (j - 1) * (cols - 2) + (i - 1);
    let solve_axis = |axis: fn((f64, f64)) -> f64| {
        let mut system = SystemBuilder::new(interior.len());
        for &(i, j) in &interior {
            let row = index(i, j);
            system.add(row, row, 4.0);
            for (ni, nj) in [(i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)] {
                match boundary(ni, nj) {
                    Some(p) => system.add_rhs(row, axis(p)),
                    None => system.add(row, index(ni, nj), -1.0),
                }
            }
        }
        let coons_patch = interior
            .iter()
            .map(|&(i, j)| {
                let (s, r) = (i as f64 / (cols - 1) as f64, j as f64 / (rows - 1) as f64);
                (1.0 - r) * axis(top[i])
                    + r * axis(bottom[i])
                    + (1.0 - s) * axis(left[j])
                    + s * axis(right[j])
                    - bilinear(
                        axis(top[0]),
                        axis(top[cols - 1]),
                        axis(bottom[cols - 1]),
                        axis(bottom[0]),
                        s,
                        r,
                    )
            })
            .collect();
        system
            .into_system()
            .solve(coons_patch, CG_TOLERANCE, CG_MAX_ITERS)
    };
    let xs = solve_axis(|p| p.0).ok_or(BoundaryWarpStatus::RefusedSolve)?;
    let ys = solve_axis(|p| p.1).ok_or(BoundaryWarpStatus::RefusedSolve)?;
    let points = (0..rows)
        .flat_map(|j| (0..cols).map(move |i| (i, j)))
        .map(|(i, j)| boundary(i, j).unwrap_or_else(|| (xs[index(i, j)], ys[index(i, j)])))
        .collect();
    Ok(Mesh { cols, rows, points })
}

fn bilinear(c00: f64, c10: f64, c11: f64, c01: f64, s: f64, r: f64) -> f64 {
    (1.0 - s) * (1.0 - r) * c00 + s * (1.0 - r) * c10 + s * r * c11 + (1.0 - s) * r * c01
}

/// The output mesh over `[0, w] × [0, h]` for `rest`.
pub(super) fn output_mesh(rest: &Mesh, w: f64, h: f64) -> Result<Mesh, BoundaryWarpStatus> {
    let (cols, rows) = (rest.cols, rest.rows);
    let regular = |i: usize, j: usize| {
        (
            w * i as f64 / (cols - 1) as f64,
            h * j as f64 / (rows - 1) as f64,
        )
    };
    let pinned = |coordinate: usize| {
        let (i, j) = ((coordinate / 2) % cols, (coordinate / 2) / cols);
        if coordinate % 2 == 0 {
            i == 0 || i == cols - 1
        } else {
            j == 0 || j == rows - 1
        }
    };
    let dof: Vec<usize> = (0..2 * cols * rows)
        .scan(0, |free, k| {
            Some(if pinned(k) {
                usize::MAX
            } else {
                *free += 1;
                *free - 1
            })
        })
        .collect();
    let free = dof.iter().filter(|&&d| d != usize::MAX).count();
    let value = |k: usize| {
        let (x, y) = regular((k / 2) % cols, (k / 2) / cols);
        if k % 2 == 0 {
            x
        } else {
            y
        }
    };
    let mut system = SystemBuilder::new(free);
    for j in 0..rows - 1 {
        for i in 0..cols - 1 {
            let projector = shape_residual(&rest.quad(i, j));
            let coords: Vec<usize> = rest
                .quad_ids(i, j)
                .iter()
                .flat_map(|&v| [2 * v, 2 * v + 1])
                .collect();
            for (a, &ka) in coords.iter().enumerate() {
                let Some(row) = (dof[ka] != usize::MAX).then_some(dof[ka]) else {
                    continue;
                };
                for (b, &kb) in coords.iter().enumerate() {
                    match dof[kb] {
                        usize::MAX => system.add_rhs(row, -projector[a][b] * value(kb)),
                        col => system.add(row, col, projector[a][b]),
                    }
                }
            }
        }
    }
    let initial = (0..2 * cols * rows)
        .filter(|&k| dof[k] != usize::MAX)
        .map(value)
        .collect();
    let solved = system
        .into_system()
        .solve(initial, CG_TOLERANCE, CG_MAX_ITERS)
        .ok_or(BoundaryWarpStatus::RefusedSolve)?;
    let coord = |k: usize| match dof[k] {
        usize::MAX => value(k),
        d => solved[d],
    };
    let points = (0..cols * rows)
        .map(|v| (coord(2 * v), coord(2 * v + 1)))
        .collect();
    Ok(Mesh { cols, rows, points })
}

/// `I − A (AᵀA)⁻¹ Aᵀ` for the 8×4 similarity basis `A` of a rest quad: the
/// part of an output quad no similarity of the rest quad explains. With the
/// quad centred, `AᵀA` is `diag(Σ|p|², Σ|p|², 4, 4)`.
fn shape_residual(rest: &[(f64, f64); 4]) -> [[f64; 8]; 8] {
    let (cx, cy) = rest
        .iter()
        .fold((0.0, 0.0), |(x, y), p| (x + p.0 / 4.0, y + p.1 / 4.0));
    let basis: Vec<[f64; 4]> = rest
        .iter()
        .flat_map(|&(x, y)| {
            let (x, y) = (x - cx, y - cy);
            [[x, -y, 1.0, 0.0], [y, x, 0.0, 1.0]]
        })
        .collect();
    let spread: f64 = rest
        .iter()
        .map(|&(x, y)| (x - cx).powi(2) + (y - cy).powi(2))
        .sum();
    let gram_inv = [1.0 / spread, 1.0 / spread, 0.25, 0.25];
    std::array::from_fn(|a| {
        std::array::from_fn(|b| {
            let proj: f64 = (0..4)
                .map(|p| basis[a][p] * gram_inv[p] * basis[b][p])
                .sum();
            f64::from(u8::from(a == b)) - proj
        })
    })
}
