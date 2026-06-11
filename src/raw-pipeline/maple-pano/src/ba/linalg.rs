//! Dense symmetric linear algebra for the bundle-adjustment normal
//! equations — packed lower-triangular storage + Cholesky (LLᵀ) solve.
//!
//! Hand-rolled next to [`crate::math`]/[`crate::eigen`] under the same
//! "no linear-algebra dependency" rule. The BA state is tiny by
//! direct-solver standards (`3·N + 3` ≈ 453 parameters at 150 cameras,
//! spec §9.1), so a dense O(P³) Cholesky is microseconds — far below the
//! residual/Jacobian evaluation cost — and a sparse or iterative solver
//! would be pure complexity.

/// Symmetric matrix in packed lower-triangular row-major storage:
/// element `(r, c)` with `r ≥ c` lives at `r·(r+1)/2 + c`.
#[derive(Debug, Clone)]
pub struct PackedSymmetric {
    n: usize,
    data: Vec<f64>,
}

impl PackedSymmetric {
    pub fn zeros(n: usize) -> Self {
        Self {
            n,
            data: vec![0.0; n * (n + 1) / 2],
        }
    }

    pub fn dim(&self) -> usize {
        self.n
    }

    #[inline]
    fn idx(r: usize, c: usize) -> usize {
        debug_assert!(r >= c);
        r * (r + 1) / 2 + c
    }

    /// Add `v` to element `(a, b)` (order-insensitive).
    #[inline]
    pub fn add(&mut self, a: usize, b: usize, v: f64) {
        let (r, c) = if a >= b { (a, b) } else { (b, a) };
        self.data[Self::idx(r, c)] += v;
    }

    #[inline]
    pub fn get(&self, a: usize, b: usize) -> f64 {
        let (r, c) = if a >= b { (a, b) } else { (b, a) };
        self.data[Self::idx(r, c)]
    }

    /// Element-wise sum (for merging per-chunk accumulators). Panics on
    /// dimension mismatch — accumulators are built from one layout.
    pub fn add_assign(&mut self, other: &PackedSymmetric) {
        assert_eq!(self.n, other.n, "PackedSymmetric dimension mismatch");
        for (a, b) in self.data.iter_mut().zip(&other.data) {
            *a += b;
        }
    }

    /// The diagonal, as a fresh vector.
    pub fn diagonal(&self) -> Vec<f64> {
        (0..self.n).map(|i| self.data[Self::idx(i, i)]).collect()
    }

    /// Solve `(M + diag(damping)) · x = rhs` by Cholesky, leaving `self`
    /// untouched. Returns `None` when the damped matrix is not positive
    /// definite (the LM driver responds by raising λ).
    pub fn solve_damped(&self, damping: &[f64], rhs: &[f64]) -> Option<Vec<f64>> {
        assert_eq!(damping.len(), self.n);
        assert_eq!(rhs.len(), self.n);
        let mut l = self.data.clone();
        for i in 0..self.n {
            l[Self::idx(i, i)] += damping[i];
        }
        cholesky_in_place(self.n, &mut l)?;
        Some(cholesky_solve(self.n, &l, rhs))
    }
}

/// In-place packed Cholesky: overwrite the packed lower triangle of an
/// SPD matrix with its factor `L` (`M = L·Lᵀ`). `None` when a pivot is
/// non-positive (matrix not positive definite at working precision).
fn cholesky_in_place(n: usize, a: &mut [f64]) -> Option<()> {
    for j in 0..n {
        let jj = PackedSymmetric::idx(j, j);
        let mut d = a[jj];
        for k in 0..j {
            let v = a[PackedSymmetric::idx(j, k)];
            d -= v * v;
        }
        if d <= 0.0 || !d.is_finite() {
            return None;
        }
        let ljj = d.sqrt();
        a[jj] = ljj;
        let inv = 1.0 / ljj;
        for i in (j + 1)..n {
            let mut s = a[PackedSymmetric::idx(i, j)];
            for k in 0..j {
                s -= a[PackedSymmetric::idx(i, k)] * a[PackedSymmetric::idx(j, k)];
            }
            a[PackedSymmetric::idx(i, j)] = s * inv;
        }
    }
    Some(())
}

/// Solve `L·Lᵀ·x = b` given the packed factor from [`cholesky_in_place`].
fn cholesky_solve(n: usize, l: &[f64], b: &[f64]) -> Vec<f64> {
    // Forward: L·y = b.
    let mut y = vec![0.0; n];
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[PackedSymmetric::idx(i, k)] * y[k];
        }
        y[i] = s / l[PackedSymmetric::idx(i, i)];
    }
    // Backward: Lᵀ·x = y.
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in (i + 1)..n {
            s -= l[PackedSymmetric::idx(k, i)] * x[k];
        }
        x[i] = s / l[PackedSymmetric::idx(i, i)];
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prng::SplitMix64;

    fn mat_vec(m: &PackedSymmetric, x: &[f64]) -> Vec<f64> {
        let n = m.dim();
        (0..n)
            .map(|r| (0..n).map(|c| m.get(r, c) * x[c]).sum())
            .collect()
    }

    #[test]
    fn solves_a_known_spd_system() {
        // M = [[4, 2, 0], [2, 5, 1], [0, 1, 3]], x = [1, -2, 3].
        let mut m = PackedSymmetric::zeros(3);
        m.add(0, 0, 4.0);
        m.add(0, 1, 2.0);
        m.add(1, 1, 5.0);
        m.add(1, 2, 1.0);
        m.add(2, 2, 3.0);
        let x_true = [1.0, -2.0, 3.0];
        let rhs = mat_vec(&m, &x_true);
        let x = m.solve_damped(&[0.0; 3], &rhs).expect("SPD");
        for (a, b) in x.iter().zip(x_true) {
            assert!((a - b).abs() < 1e-12, "got {x:?}");
        }
    }

    #[test]
    fn random_spd_systems_round_trip() {
        let mut rng = SplitMix64::new(31);
        for trial in 0..20 {
            let n = 1 + (rng.next_u64() % 40) as usize;
            // Build SPD as AᵀA + I via random A accumulated in rank-1
            // outer products (exactly how the normal equations are built).
            let mut m = PackedSymmetric::zeros(n);
            for _ in 0..(2 * n) {
                let row: Vec<f64> = (0..n).map(|_| rng.next_range(-1.0, 1.0)).collect();
                for i in 0..n {
                    for j in 0..=i {
                        m.add(i, j, row[i] * row[j]);
                    }
                }
            }
            for i in 0..n {
                m.add(i, i, 1.0);
            }
            let x_true: Vec<f64> = (0..n).map(|_| rng.next_range(-5.0, 5.0)).collect();
            let rhs = mat_vec(&m, &x_true);
            let x = m.solve_damped(&vec![0.0; n], &rhs).expect("SPD");
            let worst = x
                .iter()
                .zip(&x_true)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f64, f64::max);
            assert!(worst < 1e-8, "trial {trial}: worst component error {worst}");
        }
    }

    #[test]
    fn damping_rescues_a_singular_matrix() {
        // Rank-1: xxᵀ is singular; un-damped must fail, damped must solve.
        let mut m = PackedSymmetric::zeros(3);
        let v = [1.0, 2.0, -1.0];
        for i in 0..3 {
            for j in 0..=i {
                m.add(i, j, v[i] * v[j]);
            }
        }
        assert!(m.solve_damped(&[0.0; 3], &[1.0, 0.0, 0.0]).is_none());
        let x = m
            .solve_damped(&[1e-3; 3], &[1.0, 0.0, 0.0])
            .expect("damped is SPD");
        assert!(x.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn add_assign_merges_accumulators() {
        let mut a = PackedSymmetric::zeros(2);
        a.add(0, 0, 1.0);
        a.add(1, 0, 2.0);
        let mut b = PackedSymmetric::zeros(2);
        b.add(1, 1, 3.0);
        b.add(0, 1, 4.0);
        a.add_assign(&b);
        assert_eq!(a.get(0, 0), 1.0);
        assert_eq!(a.get(1, 0), 6.0);
        assert_eq!(a.get(0, 1), 6.0);
        assert_eq!(a.get(1, 1), 3.0);
        assert_eq!(a.diagonal(), vec![1.0, 3.0]);
    }
}
