//! Brown-Conrady radial lens distortion helpers.
//!
//! The model is `r' = r · (1 + k1·r² + k2·r⁴)` in normalised camera
//! coordinates (one focal length per unit). Coefficients come from the
//! DNG `OpcodeList3 → WarpRectilinear` opcode (see
//! `raw_core::pano::extract_lens_distortion`).
//!
//! Two operations are needed across the pipeline:
//!
//! - **Forward** (ideal → distorted): used inside `Warper::warp` and
//!   `warp_image_to_canvas` so we sample the input image at the
//!   sensor pixel a back-projected ideal ray actually hits.
//! - **Inverse** (distorted → ideal): used to undistort detected
//!   keypoints once before bundle adjustment so BA sees ideal-pinhole
//!   coordinates and doesn't mis-attribute radial compression to focal
//!   error.

/// Forward radial distortion: ideal normalised coords → distorted
/// normalised coords.
///
/// `r' = r · (1 + k1·r² + k2·r⁴)`
///
/// Returns the input unchanged when both coefficients are zero.
#[inline]
pub fn forward_distort_xy(xn: f64, yn: f64, k1: f32, k2: f32) -> (f64, f64) {
    if k1 == 0.0 && k2 == 0.0 {
        return (xn, yn);
    }
    let r2 = xn * xn + yn * yn;
    let factor = 1.0 + (k1 as f64) * r2 + (k2 as f64) * r2 * r2;
    (xn * factor, yn * factor)
}

/// Inverse of [`forward_distort_xy`]: distorted normalised coords →
/// ideal normalised coords.
///
/// Brown-Conrady has no closed-form inverse. We use 8 fixed-point
/// iterations:
///
/// ```text
/// x_{n+1} = x_d / (1 + k1·r_n² + k2·r_n⁴)
/// y_{n+1} = y_d / (1 + k1·r_n² + k2·r_n⁴)
/// ```
///
/// with `(x_0, y_0) = (x_d, y_d)`. For the magnitudes we encounter on
/// real DJI lenses (|k1| ≈ 0.06, |k2| ≈ 0.03, image-corner r ≤ 1.2)
/// this converges below 1e-9 in 4-5 iterations; the extra iterations
/// give us margin at the synthetic-test corner (r = √2) where
/// convergence is slower but still well-behaved.
///
/// Returns the input unchanged when both coefficients are zero.
#[inline]
pub fn inverse_distort_xy(xn_d: f64, yn_d: f64, k1: f32, k2: f32) -> (f64, f64) {
    if k1 == 0.0 && k2 == 0.0 {
        return (xn_d, yn_d);
    }
    let mut xn = xn_d;
    let mut yn = yn_d;
    for _ in 0..8 {
        let r2 = xn * xn + yn * yn;
        let factor = 1.0 + (k1 as f64) * r2 + (k2 as f64) * r2 * r2;
        xn = xn_d / factor;
        yn = yn_d / factor;
    }
    (xn, yn)
}

/// Pixel-space convenience: undistort a `(px, py)` pair given the
/// camera intrinsics and distortion coefficients. Returns the
/// "ideal-pinhole" pixel coordinate the lens *would have* projected
/// to had it had no radial distortion.
///
/// Used in pano-smoke as a one-shot pre-process on detected keypoints,
/// so bundle adjustment sees ideal-pinhole positions and doesn't fold
/// radial compression into a spurious focal-length offset.
#[inline]
pub fn undistort_pixel(
    px: f32,
    py: f32,
    cx: f32,
    cy: f32,
    focal: f32,
    k1: f32,
    k2: f32,
) -> (f32, f32) {
    if k1 == 0.0 && k2 == 0.0 {
        return (px, py);
    }
    let xn_d = ((px - cx) / focal) as f64;
    let yn_d = ((py - cy) / focal) as f64;
    let (xn, yn) = inverse_distort_xy(xn_d, yn_d, k1, k2);
    (
        (xn as f32) * focal + cx,
        (yn as f32) * focal + cy,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forward then inverse should recover the input to high precision.
    #[test]
    fn forward_inverse_roundtrip() {
        // Test a grid of normalised coords with realistic DJI L2D-20c
        // coefficients.
        let k1 = -0.057_f32;
        let k2 = 0.029_f32;
        for &xn in &[-1.0, -0.5, -0.1, 0.0, 0.1, 0.5, 1.0_f64] {
            for &yn in &[-1.0, -0.5, -0.1, 0.0, 0.1, 0.5, 1.0_f64] {
                let (xd, yd) = forward_distort_xy(xn, yn, k1, k2);
                let (xb, yb) = inverse_distort_xy(xd, yd, k1, k2);
                assert!(
                    (xb - xn).abs() < 1e-6 && (yb - yn).abs() < 1e-6,
                    "roundtrip failed at ({xn},{yn}): forward→({xd},{yd}) inverse→({xb},{yb})",
                );
            }
        }
    }

    /// At the origin, both forward and inverse are no-ops regardless of
    /// the coefficients (because r = 0).
    #[test]
    fn origin_is_fixed_point() {
        assert_eq!(forward_distort_xy(0.0, 0.0, -0.5, 0.3), (0.0, 0.0));
        assert_eq!(inverse_distort_xy(0.0, 0.0, -0.5, 0.3), (0.0, 0.0));
    }

    /// k1 = k2 = 0 → both transforms are identities.
    #[test]
    fn zero_coefficients_are_noop() {
        assert_eq!(forward_distort_xy(0.7, -0.3, 0.0, 0.0), (0.7, -0.3));
        assert_eq!(inverse_distort_xy(0.7, -0.3, 0.0, 0.0), (0.7, -0.3));
    }

    /// Pixel-space wrapper composes correctly: undistort_pixel(px, py)
    /// must equal the manual normalize → inverse_distort → denormalize
    /// chain.
    #[test]
    fn pixel_wrapper_matches_manual_chain() {
        let cx = 2688.0_f32;
        let cy = 1978.0_f32;
        let focal = 3584.0_f32;
        let k1 = -0.057_f32;
        let k2 = 0.029_f32;

        let px = 5000.0_f32; // far from centre — substantial distortion
        let py = 3500.0_f32;

        let xn_d = ((px - cx) / focal) as f64;
        let yn_d = ((py - cy) / focal) as f64;
        let (xn_ideal, yn_ideal) = inverse_distort_xy(xn_d, yn_d, k1, k2);
        let expect_px = (xn_ideal as f32) * focal + cx;
        let expect_py = (yn_ideal as f32) * focal + cy;

        let (got_px, got_py) = undistort_pixel(px, py, cx, cy, focal, k1, k2);
        assert!((got_px - expect_px).abs() < 1e-3);
        assert!((got_py - expect_py).abs() < 1e-3);
    }

    /// Negative k1 (barrel distortion — DJI L2D-20c) compresses radii.
    /// Forward should map (1, 0) → x' < 1 in normalised coords.
    #[test]
    fn negative_k1_compresses_radius_forward() {
        let k1 = -0.057_f32;
        let (x_d, _) = forward_distort_xy(1.0, 0.0, k1, 0.0);
        assert!(x_d < 1.0, "expected radial compression, got x_d={x_d}");
        // Inverse should expand (1, 0) → x > 1.
        let (x_inv, _) = inverse_distort_xy(1.0, 0.0, k1, 0.0);
        assert!(x_inv > 1.0, "expected radial expansion on inverse, got x_inv={x_inv}");
    }
}
