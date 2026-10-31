//! The solved map sampled onto a regular grid over the output rectangle,
//! and the per-cell fold limit of the slider blend.
//!
//! Grid nodes hold the unwarped position `u₁(n)` of each regular output
//! position `n`, in normalised coordinates. Between nodes the map is
//! bilinear, so a cell is fold-free exactly when the Jacobian determinant
//! is positive at its four corners (the determinant of a bilinear map is
//! affine in each cell).

use super::mesh::{corner_crosses, corner_edges, cross, Mesh};

const NEWTON_ITERS: usize = 30;
const INSIDE_SLACK: f64 = 1e-9;

/// `u₁` at every node of a `cols × rows` regular grid over the output
/// rectangle, normalised to `[0, 1]²`; `None` where no output quad holds a
/// node, which a fold-free output mesh never leaves.
pub(super) fn sample_inverse(
    rest: &Mesh,
    out: &Mesh,
    (w, h): (f64, f64),
    cols: usize,
    rows: usize,
) -> Option<Vec<(f64, f64)>> {
    let mut nodes: Vec<Option<(f64, f64)>> = vec![None; cols * rows];
    let (step_x, step_y) = (w / (cols - 1) as f64, h / (rows - 1) as f64);
    for j in 0..out.rows - 1 {
        for i in 0..out.cols - 1 {
            let quad = out.quad(i, j);
            let (x0, y0, x1, y1) = bounds(quad.iter().copied());
            let span = |lo: f64, hi: f64, step: f64, n: usize| {
                let first = ((lo / step) - INSIDE_SLACK).ceil().max(0.0) as usize;
                let last = (((hi / step) + INSIDE_SLACK).floor().max(0.0) as usize).min(n - 1);
                first..=last
            };
            for nj in span(y0, y1, step_y, rows) {
                for ni in span(x0, x1, step_x, cols) {
                    let slot = &mut nodes[nj * cols + ni];
                    if slot.is_some() {
                        continue;
                    }
                    let p = (ni as f64 * step_x, nj as f64 * step_y);
                    if let Some((s, r)) = inverse_bilinear(&quad, p) {
                        let (ux, uy) = bilinear(&rest.quad(i, j), s, r);
                        *slot = Some((ux / w, uy / h));
                    }
                }
            }
        }
    }
    nodes.into_iter().collect()
}

/// `u₁` when the output mesh is the regular grid itself: each rest quad
/// sampled at `per_quad` steps along each axis, normalised to `w × h`.
pub(super) fn sample_regular(rest: &Mesh, (w, h): (f64, f64), per_quad: usize) -> Vec<(f64, f64)> {
    let (cols, rows) = (
        per_quad * (rest.cols - 1) + 1,
        per_quad * (rest.rows - 1) + 1,
    );
    let local = |g: usize, quads: usize| {
        let q = (g / per_quad).min(quads - 1);
        (q, (g - q * per_quad) as f64 / per_quad as f64)
    };
    (0..rows)
        .flat_map(|j| (0..cols).map(move |i| (i, j)))
        .map(|(i, j)| {
            let ((qi, s), (qj, r)) = (local(i, rest.cols - 1), local(j, rest.rows - 1));
            let (x, y) = bilinear(&rest.quad(qi, qj), s, r);
            (x / w, y / h)
        })
        .collect()
}

/// The bounding box `(x0, y0, x1, y1)` of `points`.
pub(super) fn bounds(points: impl Iterator<Item = (f64, f64)>) -> (f64, f64, f64, f64) {
    points.fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(a, b, c, d), (x, y)| (a.min(x), b.min(y), c.max(x), d.max(y)),
    )
}

pub(super) fn bilinear(q: &[(f64, f64); 4], s: f64, r: f64) -> (f64, f64) {
    let weights = [(1.0 - s) * (1.0 - r), s * (1.0 - r), s * r, (1.0 - s) * r];
    q.iter()
        .zip(weights)
        .fold((0.0, 0.0), |(x, y), (p, k)| (x + k * p.0, y + k * p.1))
}

/// Local coordinates `(s, r) ∈ [0, 1]²` of `p` in `q`, by Newton's method
/// from the quad centre.
fn inverse_bilinear(q: &[(f64, f64); 4], p: (f64, f64)) -> Option<(f64, f64)> {
    let scale = (q[2].0 - q[0].0)
        .abs()
        .max((q[2].1 - q[0].1).abs())
        .max(1.0);
    let (mut s, mut r) = (0.5, 0.5);
    for _ in 0..NEWTON_ITERS {
        let (fx, fy) = bilinear(q, s, r);
        let (ex, ey) = (fx - p.0, fy - p.1);
        if ex.hypot(ey) < 1e-12 * scale {
            break;
        }
        let ds = (
            (1.0 - r) * (q[1].0 - q[0].0) + r * (q[2].0 - q[3].0),
            (1.0 - r) * (q[1].1 - q[0].1) + r * (q[2].1 - q[3].1),
        );
        let dr = (
            (1.0 - s) * (q[3].0 - q[0].0) + s * (q[2].0 - q[1].0),
            (1.0 - s) * (q[3].1 - q[0].1) + s * (q[2].1 - q[1].1),
        );
        let det = ds.0 * dr.1 - ds.1 * dr.0;
        if det.abs() < 1e-300 {
            return None;
        }
        s -= (ex * dr.1 - ey * dr.0) / det;
        r -= (ds.0 * ey - ds.1 * ex) / det;
    }
    let (fx, fy) = bilinear(q, s, r);
    let converged = (fx - p.0).hypot(fy - p.1) < 1e-7 * scale;
    let inside = (-INSIDE_SLACK..=1.0 + INSIDE_SLACK).contains(&s)
        && (-INSIDE_SLACK..=1.0 + INSIDE_SLACK).contains(&r);
    (converged && inside).then(|| (s.clamp(0.0, 1.0), r.clamp(0.0, 1.0)))
}

/// Regular output position of node `(i, j)`, normalised.
pub(super) fn node_position(i: usize, j: usize, cols: usize, rows: usize) -> (f64, f64) {
    (i as f64 / (cols - 1) as f64, j as f64 / (rows - 1) as f64)
}

/// The blend `(1 − t)·n + t·u₁(n)` at every node.
pub(super) fn blend(full: &[(f64, f64)], cols: usize, rows: usize, t: f64) -> Vec<(f64, f64)> {
    full.iter()
        .enumerate()
        .map(|(k, &(ux, uy))| {
            let (nx, ny) = node_position(k % cols, k / cols, cols, rows);
            ((1.0 - t) * nx + t * ux, (1.0 - t) * ny + t * uy)
        })
        .collect()
}

/// The cells of a `cols × rows` node grid as quads, in grid units scaled to
/// a `w × h` rectangle (so cross products compare as areas).
fn cells(
    nodes: &[(f64, f64)],
    cols: usize,
    rows: usize,
    (w, h): (f64, f64),
) -> impl Iterator<Item = [(f64, f64); 4]> + '_ {
    let at = move |i: usize, j: usize| {
        let (x, y) = nodes[j * cols + i];
        (x * w, y * h)
    };
    (0..rows - 1).flat_map(move |j| {
        (0..cols - 1).map(move |i| [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)])
    })
}

/// The largest `t ≤ 1` keeping every corner's Jacobian determinant at or
/// above `min_ratio` times its rest value along the whole blend. Each
/// determinant is a quadratic in `t`, so the limit is its first crossing.
pub(super) fn fold_limit(
    full: &[(f64, f64)],
    cols: usize,
    rows: usize,
    dims: (f64, f64),
    min_ratio: f64,
) -> f64 {
    let rest = blend(full, cols, rows, 0.0);
    cells(&rest, cols, rows, dims)
        .zip(cells(full, cols, rows, dims))
        .flat_map(|(p, u)| corner_limits(&p, &u, min_ratio))
        .fold(1.0, f64::min)
}

fn corner_limits(p: &[(f64, f64); 4], u: &[(f64, f64); 4], min_ratio: f64) -> [f64; 4] {
    let (ep, eu) = (corner_edges(p), corner_edges(u));
    std::array::from_fn(|k| {
        let ((ps, pr), (us, ur)) = (ep[k], eu[k]);
        let (c_pp, c_mix, c_uu) = (cross(ps, pr), cross(ps, ur) + cross(us, pr), cross(us, ur));
        // det(t) = c_pp(1−t)² + c_mix·t(1−t) + c_uu·t²; first t with det = min_ratio·c_pp.
        let (a, b, c) = (
            c_pp - c_mix + c_uu,
            c_mix - 2.0 * c_pp,
            c_pp * (1.0 - min_ratio),
        );
        first_root_in_unit(a, b, c).unwrap_or(1.0)
    })
}

/// Smallest root of `a t² + b t + c` in `(0, 1]`, given `c > 0`.
fn first_root_in_unit(a: f64, b: f64, c: f64) -> Option<f64> {
    let roots = if a.abs() < 1e-14 * (b.abs() + c.abs()) {
        vec![-c / b]
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            return None;
        }
        // The cancellation-free pair of quadratic roots.
        let q = -0.5 * (b + b.signum() * disc.sqrt());
        vec![q / a, c / q]
    };
    roots
        .into_iter()
        .filter(|t| t.is_finite() && *t > 0.0 && *t <= 1.0)
        .min_by(f64::total_cmp)
}

/// The smallest corner Jacobian determinant of the node grid relative to the
/// regular grid's, and so `1 / max_stretch`.
pub(super) fn min_jacobian(
    nodes: &[(f64, f64)],
    cols: usize,
    rows: usize,
    dims: (f64, f64),
) -> f64 {
    let rest_area = (dims.0 / (cols - 1) as f64) * (dims.1 / (rows - 1) as f64);
    cells(nodes, cols, rows, dims)
        .flat_map(|q| corner_crosses(&q))
        .fold(f64::INFINITY, f64::min)
        / rest_area
}
