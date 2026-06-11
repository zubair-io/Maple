//! Symmetric eigendecomposition by cyclic Jacobi rotations — hand-rolled
//! next to [`crate::math`] under the same "no linear-algebra dependency"
//! rule (no `nalgebra`).
//!
//! The two-view solver ([`crate::twoview`]) needs exactly one
//! factorization: the dominant eigenvector of Davenport's symmetric 4×4
//! K-matrix. Cyclic Jacobi is the textbook fit for tiny symmetric
//! matrices: unconditionally convergent, quadratic once sweeps settle,
//! and fully deterministic (fixed sweep order, no pivot search, so the
//! same input always produces bit-identical output — a property the
//! robust estimator's determinism gate relies on).
//!
//! Generic over the dimension `N` so later milestones (BA preconditioner
//! blocks, covariance probes) can reuse it for other small sizes.

/// Eigendecomposition of a symmetric `N × N` matrix.
///
/// Returns `(eigenvalues, eigenvectors)` sorted by eigenvalue
/// **descending**; `eigenvectors[k]` is the unit eigenvector belonging to
/// `eigenvalues[k]` (row layout: each returned row is one eigenvector).
///
/// The input must be symmetric — only its symmetric part is meaningful to
/// the rotations, and asymmetry beyond floating-point noise is a caller
/// bug (`debug_assert`ed). Eigenvectors of repeated eigenvalues span the
/// right subspace but their individual directions are arbitrary (still
/// deterministic for a given input).
// Indexed loops are the readable form for (p,q) plane-rotation updates —
// the bodies mutate two rows/columns of `a` at once, which iterator
// rewrites can only express through split-borrow gymnastics.
#[allow(clippy::needless_range_loop)]
pub fn eigen_symmetric<const N: usize>(matrix: &[[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let mut a = *matrix;
    #[cfg(debug_assertions)]
    {
        let scale = a
            .iter()
            .flatten()
            .fold(0.0_f64, |m, &x| m.max(x.abs()))
            .max(1.0);
        for p in 0..N {
            for q in (p + 1)..N {
                debug_assert!(
                    (a[p][q] - a[q][p]).abs() <= 1e-9 * scale,
                    "eigen_symmetric: input is not symmetric at ({p},{q})"
                );
            }
        }
    }

    // V accumulates the product of all Jacobi rotations; its columns end
    // up as the eigenvectors of the input.
    let mut v = [[0.0_f64; N]; N];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }

    let frob: f64 = a.iter().flatten().map(|x| x * x).sum::<f64>().sqrt();
    let tol = (frob * 1e-15).max(f64::MIN_POSITIVE);

    // 64 sweeps is far beyond what a well-conditioned small matrix needs
    // (4×4 converges in ~6); the loop exits on the off-diagonal norm.
    for _sweep in 0..64 {
        let off: f64 = {
            let mut s = 0.0;
            for p in 0..N {
                for q in (p + 1)..N {
                    s += a[p][q] * a[p][q];
                }
            }
            s.sqrt()
        };
        if off <= tol {
            break;
        }
        for p in 0..N {
            for q in (p + 1)..N {
                let apq = a[p][q];
                if apq == 0.0 {
                    continue;
                }
                // Rotation angle zeroing a[p][q]: t = tan θ is the
                // smaller-magnitude root of t² + 2·τ·t − 1 = 0 with
                // τ = (a_qq − a_pp) / (2·a_pq), evaluated in the
                // cancellation-free form.
                let tau = (a[q][q] - a[p][p]) / (2.0 * apq);
                let t = if tau >= 0.0 {
                    1.0 / (tau + (1.0 + tau * tau).sqrt())
                } else {
                    1.0 / (tau - (1.0 + tau * tau).sqrt())
                };
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = t * c;

                // A ← Gᵀ·A·G with G the (p,q)-plane rotation:
                // columns first (A·G), then rows (Gᵀ·…).
                for row in a.iter_mut() {
                    let (rp, rq) = (row[p], row[q]);
                    row[p] = c * rp - s * rq;
                    row[q] = s * rp + c * rq;
                }
                for k in 0..N {
                    let (pk, qk) = (a[p][k], a[q][k]);
                    a[p][k] = c * pk - s * qk;
                    a[q][k] = s * pk + c * qk;
                }
                // V ← V·G (columns of V track the eigenvectors).
                for row in v.iter_mut() {
                    let (vp, vq) = (row[p], row[q]);
                    row[p] = c * vp - s * vq;
                    row[q] = s * vp + c * vq;
                }
            }
        }
    }

    // Sort by eigenvalue descending; emit eigenvectors as rows.
    let mut order: [usize; N] = [0; N];
    for (i, o) in order.iter_mut().enumerate() {
        *o = i;
    }
    order.sort_by(|&i, &j| a[j][j].total_cmp(&a[i][i]));

    let mut values = [0.0_f64; N];
    let mut vectors = [[0.0_f64; N]; N];
    for (k, &i) in order.iter().enumerate() {
        values[k] = a[i][i];
        for (r, vec_k) in vectors[k].iter_mut().enumerate() {
            *vec_k = v[r][i];
        }
    }
    (values, vectors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prng::SplitMix64;

    fn assert_decomposition<const N: usize>(a: &[[f64; N]; N], tol: f64) {
        let (vals, vecs) = eigen_symmetric(a);
        // Sorted descending.
        for k in 1..N {
            assert!(vals[k - 1] >= vals[k], "eigenvalues not sorted: {vals:?}");
        }
        // A·v = λ·v and orthonormality.
        for k in 0..N {
            let mut av = [0.0_f64; N];
            for (i, av_i) in av.iter_mut().enumerate() {
                *av_i = (0..N).map(|j| a[i][j] * vecs[k][j]).sum();
            }
            for i in 0..N {
                assert!(
                    (av[i] - vals[k] * vecs[k][i]).abs() < tol,
                    "A·v != λ·v for k={k}: {av:?} vs λ={} v={:?}",
                    vals[k],
                    vecs[k]
                );
            }
            for l in 0..N {
                let dot: f64 = (0..N).map(|i| vecs[k][i] * vecs[l][i]).sum();
                let want = if k == l { 1.0 } else { 0.0 };
                assert!((dot - want).abs() < tol, "v{k}·v{l} = {dot}, want {want}");
            }
        }
    }

    #[test]
    fn diagonal_matrix_is_exact() {
        let a = [[3.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 7.0]];
        let (vals, vecs) = eigen_symmetric(&a);
        assert_eq!(vals, [7.0, 3.0, -1.0]);
        assert_eq!(vecs[0][2].abs(), 1.0);
        assert_eq!(vecs[1][0].abs(), 1.0);
        assert_eq!(vecs[2][1].abs(), 1.0);
    }

    #[test]
    fn known_two_by_two() {
        // [[2,1],[1,2]] has eigenvalues 3 and 1 with vectors (1,1)/√2,
        // (1,-1)/√2.
        let (vals, vecs) = eigen_symmetric(&[[2.0, 1.0], [1.0, 2.0]]);
        assert!((vals[0] - 3.0).abs() < 1e-14 && (vals[1] - 1.0).abs() < 1e-14);
        let s = 1.0 / 2.0_f64.sqrt();
        assert!((vecs[0][0].abs() - s).abs() < 1e-14 && (vecs[0][1].abs() - s).abs() < 1e-14);
        assert!(
            vecs[0][0] * vecs[0][1] > 0.0,
            "λ=3 vector is (1,1) up to sign"
        );
        assert!(
            vecs[1][0] * vecs[1][1] < 0.0,
            "λ=1 vector is (1,-1) up to sign"
        );
    }

    // Symmetric fill mutates a[i][j] and a[j][i] together — indexed by
    // necessity (same false positive as the solver's plane rotations).
    #[allow(clippy::needless_range_loop)]
    fn random_symmetric<const N: usize>(rng: &mut SplitMix64) -> [[f64; N]; N] {
        let mut a = [[0.0_f64; N]; N];
        for i in 0..N {
            for j in i..N {
                let x = rng.next_range(-2.0, 2.0);
                a[i][j] = x;
                a[j][i] = x;
            }
        }
        a
    }

    #[test]
    fn random_symmetric_matrices_decompose() {
        let mut rng = SplitMix64::new(31);
        for _ in 0..50 {
            assert_decomposition(&random_symmetric::<3>(&mut rng), 1e-10);
            assert_decomposition(&random_symmetric::<4>(&mut rng), 1e-10);
        }
    }

    #[test]
    fn repeated_eigenvalues_stay_orthonormal() {
        // Identity: every direction is an eigenvector; the contract is
        // orthonormality + correct eigenvalues, not specific directions.
        let a = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];
        assert_decomposition(&a, 1e-12);
    }

    #[test]
    fn deterministic_for_identical_input() {
        let a = [[1.5, -0.3, 0.7], [-0.3, 2.0, 0.1], [0.7, 0.1, -0.9]];
        let (v1, e1) = eigen_symmetric(&a);
        let (v2, e2) = eigen_symmetric(&a);
        assert_eq!(v1, v2);
        assert_eq!(e1, e2);
    }
}
