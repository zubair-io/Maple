//! Polynomial radial lens distortion (Brown–Conrady, k1/k2 terms).
//!
//! Model, in *ideal normalized camera coordinates* (pixel offset from the
//! principal point divided by the focal length in pixels):
//!
//! ```text
//! r_d = r · (1 + k1·r² + k2·r⁴)        r = √(x² + y²)
//! (x_d, y_d) = (x, y) · (1 + k1·r² + k2·r⁴)
//! ```
//!
//! Forward (ideal → distorted) is the closed-form polynomial above; the
//! inverse (distorted → ideal) has no closed form and is solved per point
//! with Newton's method on the scalar radius (adapted from the PR #17
//! fixed-point version; Newton converges quadratically and detects the
//! non-monotonic domain instead of silently cycling).

/// Forward radial distortion: ideal normalized coords → distorted.
#[inline]
pub fn distort(x: f64, y: f64, k1: f64, k2: f64) -> (f64, f64) {
    if k1 == 0.0 && k2 == 0.0 {
        return (x, y);
    }
    let r2 = x * x + y * y;
    let f = 1.0 + k1 * r2 + k2 * r2 * r2;
    (x * f, y * f)
}

/// Inverse of [`distort`]: distorted normalized coords → ideal.
///
/// Newton iteration on the radius: solve `g(r) = r·(1 + k1·r² + k2·r⁴) − r_d
/// = 0` with `g′(r) = 1 + 3·k1·r² + 5·k2·r⁴`, starting from `r = r_d`.
///
/// Returns `None` when the polynomial is not invertible at this radius —
/// i.e. the iteration walks into a region where `g′ ≤ 0` (the distortion
/// curve folds back; beyond the lens model's valid domain) or fails to
/// converge. For physically plausible coefficients (|k1| ≲ 0.3 with
/// frame-corner radii ≲ 1.5) it always converges in < 10 iterations.
#[inline]
pub fn undistort(x_d: f64, y_d: f64, k1: f64, k2: f64) -> Option<(f64, f64)> {
    if k1 == 0.0 && k2 == 0.0 {
        return Some((x_d, y_d));
    }
    let r_d = (x_d * x_d + y_d * y_d).sqrt();
    if r_d < 1e-15 {
        return Some((x_d, y_d)); // r = 0 is a fixed point of the model.
    }
    let mut r = r_d;
    let tol = 1e-12 * r_d.max(1.0);
    for _ in 0..32 {
        let r2 = r * r;
        let g = r * (1.0 + k1 * r2 + k2 * r2 * r2) - r_d;
        if g.abs() <= tol {
            let s = r / r_d;
            return Some((x_d * s, y_d * s));
        }
        let dg = 1.0 + 3.0 * k1 * r2 + 5.0 * k2 * r2 * r2;
        if dg <= 1e-9 {
            return None; // Non-monotonic region — model not invertible here.
        }
        r -= g / dg;
        if !r.is_finite() || r < 0.0 {
            return None;
        }
    }
    None // Did not converge within the iteration budget.
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forward → inverse recovers the input across a grid of normalized
    /// coordinates, for barrel, pincushion and mixed coefficients.
    #[test]
    fn forward_inverse_round_trip() {
        let coeff_sets = [
            (-0.057, 0.029), // DJI L2D-20c-like barrel
            (-0.15, 0.05),   // strong barrel
            (0.08, 0.01),    // pincushion
            (0.0, 0.04),     // k2-only
            (-0.06, 0.0),    // k1-only
        ];
        let grid = [-1.2, -0.9, -0.5, -0.1, 0.0, 0.1, 0.5, 0.9, 1.2];
        for (k1, k2) in coeff_sets {
            for &x in &grid {
                for &y in &grid {
                    let (xd, yd) = distort(x, y, k1, k2);
                    let (xb, yb) = undistort(xd, yd, k1, k2)
                        .unwrap_or_else(|| panic!("not invertible at ({x},{y}) k=({k1},{k2})"));
                    assert!(
                        (xb - x).abs() < 1e-9 && (yb - y).abs() < 1e-9,
                        "round trip failed at ({x},{y}) k=({k1},{k2}): got ({xb},{yb})"
                    );
                }
            }
        }
    }

    #[test]
    fn zero_coefficients_are_identity() {
        assert_eq!(distort(0.7, -0.3, 0.0, 0.0), (0.7, -0.3));
        assert_eq!(undistort(0.7, -0.3, 0.0, 0.0), Some((0.7, -0.3)));
    }

    #[test]
    fn origin_is_fixed_point() {
        assert_eq!(distort(0.0, 0.0, -0.5, 0.3), (0.0, 0.0));
        assert_eq!(undistort(0.0, 0.0, -0.5, 0.3), Some((0.0, 0.0)));
    }

    #[test]
    fn barrel_compresses_radius_forward() {
        let (xd, _) = distort(1.0, 0.0, -0.057, 0.0);
        assert!(xd < 1.0, "expected radial compression, got {xd}");
        let (xi, _) = undistort(1.0, 0.0, -0.057, 0.0).unwrap();
        assert!(xi > 1.0, "expected radial expansion on inverse, got {xi}");
    }

    /// Past the fold of a strongly negative k1 the polynomial stops being
    /// monotonic; the inverse must refuse rather than return garbage.
    #[test]
    fn non_invertible_region_returns_none() {
        // r_d(r) = r·(1 − 0.5·r²) peaks at r = √(2/3) with r_d ≈ 0.544;
        // any distorted radius beyond the peak has no pre-image.
        assert_eq!(undistort(0.9, 0.0, -0.5, 0.0), None);
    }
}
