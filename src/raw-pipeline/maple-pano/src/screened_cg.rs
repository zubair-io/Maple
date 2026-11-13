//! Matrix-free conjugate gradients for the coarse screened-Poisson
//! correction fields: the tile strategy's residual exposure fields
//! (`tile::exposure_field`, #350) and the rotation strategy's per-view
//! exposure field (`gain::field`, #4521).
//!
//! Both minimise the same quadratic over node values `x`:
//!
//! ```text
//!   Σ_data   w · (x_a − x_b − d)²        pairwise residuals
//! + λ Σ_edges  (x_a − x_b)²              smoothness
//! + λ Σ_pins   x_a²                      edge to a Dirichlet-zero node
//! + μ Σ        x²                        shrinkage
//! ```
//!
//! whose normal equations are symmetric positive definite for `μ > 0`.
//! The operator is applied from the explicit term lists, so cost and
//! memory scale with the term count, and the iteration is purely
//! data-driven (deterministic for a deterministic term order).

pub(crate) struct DiffTerm {
    pub a: usize,
    pub b: usize,
    pub w: f64,
    pub d: f64,
}

pub(crate) struct ScreenedSystem<'a> {
    pub unknowns: usize,
    pub data: &'a [DiffTerm],
    pub smooth: &'a [(usize, usize)],
    pub pinned: &'a [usize],
    pub lambda: f64,
    pub shrinkage: f64,
}

impl ScreenedSystem<'_> {
    fn apply(&self, x: &[f64], out: &mut [f64]) {
        for (o, xv) in out.iter_mut().zip(x) {
            *o = self.shrinkage * xv;
        }
        for t in self.data {
            let diff = t.w * (x[t.a] - x[t.b]);
            out[t.a] += diff;
            out[t.b] -= diff;
        }
        for &(a, b) in self.smooth {
            let diff = self.lambda * (x[a] - x[b]);
            out[a] += diff;
            out[b] -= diff;
        }
        for &a in self.pinned {
            out[a] += self.lambda * x[a];
        }
    }

    /// Solve the normal equations, stopping after `max_iters` or once the
    /// squared residual falls below `1e-16` of the right-hand side's.
    pub fn solve(&self, max_iters: usize) -> Vec<f64> {
        let n = self.unknowns;
        let mut rhs = vec![0.0_f64; n];
        for t in self.data {
            rhs[t.a] += t.w * t.d;
            rhs[t.b] -= t.w * t.d;
        }
        let rhs_norm2: f64 = rhs.iter().map(|v| v * v).sum();
        let mut x = vec![0.0_f64; n];
        if rhs_norm2 <= 0.0 {
            return x;
        }
        let mut r = rhs.clone();
        let mut p = rhs;
        let mut ap = vec![0.0_f64; n];
        let mut rs = rhs_norm2;
        for _ in 0..max_iters {
            self.apply(&p, &mut ap);
            let p_ap: f64 = p.iter().zip(&ap).map(|(a, b)| a * b).sum();
            if p_ap <= 0.0 {
                break;
            }
            let alpha = rs / p_ap;
            for i in 0..n {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }
            let rs_new: f64 = r.iter().map(|v| v * v).sum();
            if rs_new <= 1e-16 * rhs_norm2 {
                break;
            }
            let beta = rs_new / rs;
            for i in 0..n {
                p[i] = r[i] + beta * p[i];
            }
            rs = rs_new;
        }
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_pair(pinned: &[usize], lambda: f64) -> Vec<f64> {
        let data = [DiffTerm {
            a: 0,
            b: 1,
            w: 1.0,
            d: 0.2,
        }];
        ScreenedSystem {
            unknowns: 2,
            data: &data,
            smooth: &[],
            pinned,
            lambda,
            shrinkage: 1e-6,
        }
        .solve(50)
    }

    #[test]
    fn a_pair_difference_splits_symmetrically_under_shrinkage() {
        let x = single_pair(&[], 0.0);
        assert!(
            (x[0] - 0.1).abs() < 1e-5 && (x[1] + 0.1).abs() < 1e-5,
            "{x:?}"
        );
    }

    #[test]
    fn a_pinned_node_is_held_near_zero() {
        let x = single_pair(&[1], 100.0);
        assert!(x[1].abs() < 0.01 && (x[0] - 0.2).abs() < 0.01, "{x:?}");
    }
}
