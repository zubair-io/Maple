//! Pure math solver for the 2D Thin Plate Spline (TPS) HueSatMap fit.
//!
//! Exposes a pure-Rust Gaussian Elimination solver with partial pivoting
//! and the thin plate spline fitting/evaluation algorithms.
//!
//! Fits data points (x, y) -> z, where U(r) = r^2 * ln(r) is the biharmonic RBF.

#[derive(Clone, Debug, PartialEq)]
pub struct TpsCoefficients {
    pub points: Vec<(f32, f32)>,
    pub w: Vec<f32>,     // Length N (RBF weights)
    pub a: [f32; 3],     // Length 3: [a0, a1, a2] (Affine terms: offset, x, y)
}

/// Solve A * x = b using Gaussian Elimination with partial pivoting.
/// Returns None if the matrix is singular or extremely ill-conditioned.
pub fn solve_linear_system(mut a: Vec<Vec<f32>>, mut b: Vec<f32>) -> Option<Vec<f32>> {
    let n = a.len();
    if n == 0 || b.len() != n {
        return None;
    }
    for i in 0..n {
        // Find pivot
        let mut pivot_row = i;
        let mut max_val = a[i][i].abs();
        for r in (i + 1)..n {
            let val = a[r][i].abs();
            if val > max_val {
                max_val = val;
                pivot_row = r;
            }
        }
        if max_val < 1e-9 {
            return None; // Singular matrix
        }
        if pivot_row != i {
            a.swap(i, pivot_row);
            b.swap(i, pivot_row);
        }
        // Eliminate column elements below pivot
        for r in (i + 1)..n {
            let factor = a[r][i] / a[i][i];
            a[r][i] = 0.0;
            for c in (i + 1)..n {
                a[r][c] -= factor * a[i][c];
            }
            b[r] -= factor * b[i];
        }
    }
    // Back substitution
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut sum = 0.0;
        for c in (i + 1)..n {
            sum += a[i][c] * x[c];
        }
        x[i] = (b[i] - sum) / a[i][i];
    }
    Some(x)
}

/// Thin Plate Spline radial basis function kernel: U(r) = r^2 * ln(r).
/// Limit as r -> 0 is 0.0.
#[inline]
pub fn tps_kernel(r: f32) -> f32 {
    if r < 1e-8 {
        0.0
    } else {
        r * r * r.ln()
    }
}

/// Fits a 2D Thin Plate Spline (TPS) surface: z = f(x, y).
/// Inputs: points `(x, y)`, targets `z`, and a smoothing regularization factor `lambda`.
///
/// System matrix layout:
///   [ K + lambda*I   P ] [ W ]   [ Z ]
///   [      P^T       0 ] [ A ] = [ 0 ]
pub fn tps_solve(
    points: &[(f32, f32)],
    targets: &[f32],
    lambda: f32,
) -> Option<TpsCoefficients> {
    let n = points.len();
    if n == 0 || targets.len() != n {
        return None;
    }
    let sys_size = n + 3;
    let mut m = vec![vec![0.0; sys_size]; sys_size];
    let mut rhs = vec![0.0; sys_size];

    // Fill K + lambda * I
    for i in 0..n {
        let (xi, yi) = points[i];
        for j in 0..n {
            let (xj, yj) = points[j];
            let dx = xi - xj;
            let dy = yi - yj;
            let r = dx.hypot(dy);
            let mut val = tps_kernel(r);
            if i == j {
                val += lambda;
            }
            m[i][j] = val;
        }
    }

    // Fill P and P^T
    for i in 0..n {
        let (xi, yi) = points[i];
        // P column 0 (1.0), column 1 (x), column 2 (y)
        m[i][n] = 1.0;
        m[i][n + 1] = xi;
        m[i][n + 2] = yi;

        // P^T row 0 (1.0), row 1 (x), row 2 (y)
        m[n][i] = 1.0;
        m[n + 1][i] = xi;
        m[n + 2][i] = yi;
    }

    // Fill RHS
    for i in 0..n {
        rhs[i] = targets[i];
    }
    // bottom-right block of matrix and remaining RHS are 0.0

    let sol = solve_linear_system(m, rhs)?;
    let w = sol[0..n].to_vec();
    let a = [sol[n], sol[n + 1], sol[n + 2]];

    Some(TpsCoefficients {
        points: points.to_vec(),
        w,
        a,
    })
}

/// Evaluates the TPS surface at a given 2D coordinate.
pub fn tps_evaluate(coef: &TpsCoefficients, pt: (f32, f32)) -> f32 {
    let mut sum = coef.a[0] + coef.a[1] * pt.0 + coef.a[2] * pt.1;
    for i in 0..coef.points.len() {
        let (px, py) = coef.points[i];
        let dx = pt.0 - px;
        let dy = pt.1 - py;
        let r = dx.hypot(dy);
        sum += coef.w[i] * tps_kernel(r);
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_solve_linear_system_identity() {
        let a = vec![
            vec![1.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0],
        ];
        let b = vec![3.0, -1.0, 0.5];
        let x = solve_linear_system(a, b).unwrap();
        assert_eq!(x, vec![3.0, -1.0, 0.5]);
    }

    #[test]
    fn test_solve_linear_system_2x2() {
        let a = vec![
            vec![2.0, 1.0],
            vec![1.0, -1.0],
        ];
        let b = vec![5.0, 1.0];
        let x = solve_linear_system(a, b).unwrap();
        // 2x + y = 5
        // x - y = 1 => 3x = 6 => x = 2, y = 1
        assert_eq!(x, vec![2.0, 1.0]);
    }

    #[test]
    fn test_solve_linear_system_singular() {
        let a = vec![
            vec![1.0, 1.0],
            vec![2.0, 2.0],
        ];
        let b = vec![2.0, 4.0];
        assert!(solve_linear_system(a, b).is_none());
    }

    #[test]
    fn test_tps_fitting_flat_surface() {
        // Points on a flat plane z = 2.0 - 0.5 * x + 1.2 * y
        let points = vec![
            (0.0, 0.0),
            (1.0, 0.0),
            (0.0, 1.0),
            (1.0, 1.0),
            (-0.5, 0.5),
        ];
        let targets: Vec<f32> = points.iter().map(|&(x, y)| 2.0 - 0.5 * x + 1.2 * y).collect();

        // Exact fit (lambda = 0.0) should recover the plane coefficients
        let coef = tps_solve(&points, &targets, 0.0).unwrap();

        // Verify interpolation at control points
        for (i, &pt) in points.iter().enumerate() {
            let val = tps_evaluate(&coef, pt);
            assert!((val - targets[i]).abs() < 1e-4, "pt={:?} got={}, expected={}", pt, val, targets[i]);
        }

        // Verify extrapolation at a new point
        let test_pt = (0.5, 0.5);
        let expected = 2.0 - 0.5 * 0.5 + 1.2 * 0.5;
        let val = tps_evaluate(&coef, test_pt);
        assert!((val - expected).abs() < 1e-4, "test_pt={:?} got={}, expected={}", test_pt, val, expected);
    }
}
