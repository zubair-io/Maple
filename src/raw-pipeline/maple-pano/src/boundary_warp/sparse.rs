//! Symmetric sparse assembly and Jacobi-preconditioned conjugate gradients
//! for the boundary-warp mesh solves. The systems are small (a few thousand
//! unknowns, a dozen non-zeros per row), so a row-sorted triplet build and a
//! sequential CG are enough, and the iteration order is fixed, so results are
//! deterministic.

use std::collections::BTreeMap;

/// A symmetric positive-definite system `A x = b` under assembly. Entries are
/// summed, so each energy term adds its own contribution.
pub(super) struct SystemBuilder {
    rows: Vec<BTreeMap<usize, f64>>,
    rhs: Vec<f64>,
}

impl SystemBuilder {
    pub(super) fn new(unknowns: usize) -> Self {
        Self {
            rows: vec![BTreeMap::new(); unknowns],
            rhs: vec![0.0; unknowns],
        }
    }

    pub(super) fn add(&mut self, row: usize, col: usize, value: f64) {
        *self.rows[row].entry(col).or_insert(0.0) += value;
    }

    pub(super) fn add_rhs(&mut self, row: usize, value: f64) {
        self.rhs[row] += value;
    }

    pub(super) fn into_system(self) -> System {
        let mut offsets = Vec::with_capacity(self.rows.len() + 1);
        let mut cols = Vec::new();
        let mut values = Vec::new();
        offsets.push(0);
        for row in &self.rows {
            for (&c, &v) in row {
                cols.push(c);
                values.push(v);
            }
            offsets.push(cols.len());
        }
        System {
            offsets,
            cols,
            values,
            rhs: self.rhs,
        }
    }
}

/// Compressed-row form of an assembled [`SystemBuilder`].
pub(super) struct System {
    offsets: Vec<usize>,
    cols: Vec<usize>,
    values: Vec<f64>,
    rhs: Vec<f64>,
}

impl System {
    fn unknowns(&self) -> usize {
        self.rhs.len()
    }

    fn apply(&self, x: &[f64], out: &mut [f64]) {
        for (row, o) in out.iter_mut().enumerate() {
            let span = self.offsets[row]..self.offsets[row + 1];
            *o = self.cols[span.clone()]
                .iter()
                .zip(&self.values[span])
                .map(|(&c, &v)| v * x[c])
                .sum();
        }
    }

    fn diagonal(&self) -> Vec<f64> {
        (0..self.unknowns())
            .map(|row| {
                let span = self.offsets[row]..self.offsets[row + 1];
                self.cols[span.clone()]
                    .iter()
                    .zip(&self.values[span])
                    .find(|(&c, _)| c == row)
                    .map_or(1.0, |(_, &v)| v)
            })
            .collect()
    }

    /// Solves from `initial`, stopping once the residual norm falls below
    /// `tolerance` times the right-hand side's. `None` if it has not
    /// converged after `max_iters` iterations or the matrix is not positive
    /// definite along a search direction.
    pub(super) fn solve(
        &self,
        initial: Vec<f64>,
        tolerance: f64,
        max_iters: usize,
    ) -> Option<Vec<f64>> {
        let n = self.unknowns();
        let inv_diag: Vec<f64> = self
            .diagonal()
            .iter()
            .map(|&d| if d > 0.0 { 1.0 / d } else { 1.0 })
            .collect();
        let mut x = initial;
        let mut ax = vec![0.0; n];
        self.apply(&x, &mut ax);
        let mut r: Vec<f64> = self.rhs.iter().zip(&ax).map(|(b, a)| b - a).collect();
        let target = tolerance * norm(&self.rhs).max(f64::MIN_POSITIVE);
        if norm(&r) <= target {
            return Some(x);
        }
        let mut z: Vec<f64> = r.iter().zip(&inv_diag).map(|(r, d)| r * d).collect();
        let mut p = z.clone();
        let mut rz = dot(&r, &z);
        let mut ap = vec![0.0; n];
        for _ in 0..max_iters {
            self.apply(&p, &mut ap);
            let curvature = dot(&p, &ap);
            if curvature <= 0.0 {
                return None;
            }
            let alpha = rz / curvature;
            x.iter_mut().zip(&p).for_each(|(x, p)| *x += alpha * p);
            r.iter_mut().zip(&ap).for_each(|(r, ap)| *r -= alpha * ap);
            if norm(&r) <= target {
                return Some(x);
            }
            z.iter_mut()
                .zip(&r)
                .zip(&inv_diag)
                .for_each(|((z, r), d)| *z = r * d);
            let rz_next = dot(&r, &z);
            let beta = rz_next / rz;
            rz = rz_next;
            p.iter_mut().zip(&z).for_each(|(p, z)| *p = z + beta * *p);
        }
        None
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

fn norm(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}
