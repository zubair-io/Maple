//! Estimate the camera focal length from a pairwise homography.
//!
//! For a pure rotation between two cameras, H ≈ K · R · K⁻¹.
//! Two independent constraints from the column orthonormality of R
//! give two estimates of f²; we return the geometric mean of both
//! when both are positive.
//!
//! Reference: Hartley & Zisserman 2003 § 8.8 "Extracting K from H".

use nalgebra::Matrix3;

use crate::ba::homography::Homography;

/// Estimate the focal length (in pixels) from a homography H between
/// two cameras with the same intrinsic matrix.
///
/// `image_size = (width, height)` — used to compute the principal point
/// (assumed at the image center).
///
/// Returns `None` if the homography is degenerate (e.g. pure translation,
/// numerical near-singularities).
pub fn focal_from_homography(h: &Homography, image_size: (u32, u32)) -> Option<f64> {
    let cx = image_size.0 as f64 / 2.0;
    let cy = image_size.1 as f64 / 2.0;

    // Recenter H to principal-point-at-origin coordinates: H' = T · H · T⁻¹
    // where T = [[1, 0, -cx], [0, 1, -cy], [0, 0, 1]].
    #[rustfmt::skip]
    let t = Matrix3::new(
        1.0, 0.0, -cx,
        0.0, 1.0, -cy,
        0.0, 0.0,  1.0,
    );
    #[rustfmt::skip]
    let t_inv = Matrix3::new(
        1.0, 0.0, cx,
        0.0, 1.0, cy,
        0.0, 0.0, 1.0,
    );
    let h_centered = t * h.0 * t_inv;

    // Columns of H' (row-major access: h_centered[(row, col)]).
    let h11 = h_centered[(0, 0)];
    let h21 = h_centered[(1, 0)];
    let h31 = h_centered[(2, 0)];

    let h12 = h_centered[(0, 1)];
    let h22 = h_centered[(1, 1)];
    let h32 = h_centered[(2, 1)];

    // Method 1 (HZ eq 8.13): |v1| = |v2| → equal column magnitudes
    //   (h11² + h21²)/f² + h31² = (h12² + h22²)/f² + h32²
    //   ((h11² + h21²) - (h12² + h22²)) / f² = h32² - h31²
    //   f² = ((h11² + h21²) - (h12² + h22²)) / (h32² - h31²)
    let f1_sq = {
        let numer = (h11 * h11 + h21 * h21) - (h12 * h12 + h22 * h22);
        let denom = h32 * h32 - h31 * h31;
        if denom.abs() < 1e-12 {
            None
        } else {
            Some(numer / denom)
        }
    };

    // Method 2 (HZ eq 8.14): v1 · v2 = 0 → orthogonal columns
    //   (h11·h12 + h21·h22)/f² + h31·h32 = 0
    //   f² = -(h11·h12 + h21·h22) / (h31·h32)
    let f2_sq = {
        let denom = h31 * h32;
        if denom.abs() < 1e-12 {
            None
        } else {
            Some(-(h11 * h12 + h21 * h22) / denom)
        }
    };

    // Take whichever produces a positive estimate; geometric mean if both.
    let valid_estimates: Vec<f64> = [f1_sq, f2_sq]
        .iter()
        .filter_map(|&x| x.filter(|&v| v > 1e-6))
        .map(|v| v.sqrt())
        .collect();

    match valid_estimates.len() {
        0 => None,
        1 => Some(valid_estimates[0]),
        _ => Some((valid_estimates[0] * valid_estimates[1]).sqrt()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::Matrix3;

    fn camera_k(focal: f64, w: u32, h: u32) -> Matrix3<f64> {
        Matrix3::new(
            focal, 0.0, w as f64 / 2.0,
            0.0, focal, h as f64 / 2.0,
            0.0, 0.0, 1.0,
        )
    }

    fn yaw(deg: f64) -> Matrix3<f64> {
        let r = deg.to_radians();
        Matrix3::new(
             r.cos(), 0.0, r.sin(),
             0.0,     1.0, 0.0,
            -r.sin(), 0.0, r.cos(),
        )
    }

    #[test]
    fn focal_recovered_from_30deg_yaw() {
        let focal_truth = 256.0_f64;
        let image_size = (256u32, 256u32);
        let k = camera_k(focal_truth, image_size.0, image_size.1);
        let k_inv = k.try_inverse().unwrap();
        let r = yaw(30.0);
        let h = k * r * k_inv;
        let homography = Homography(h);

        let f_est = focal_from_homography(&homography, image_size)
            .expect("should recover focal from synthetic H");
        let rel_err = (f_est - focal_truth).abs() / focal_truth;
        assert!(
            rel_err < 0.05,
            "focal estimate {f_est} off by {rel_err:.4} from truth {focal_truth}"
        );
    }
}
