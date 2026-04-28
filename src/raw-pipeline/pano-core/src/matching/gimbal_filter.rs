//! Gimbal-aware match filter — reject matches that disagree with the
//! gimbal-predicted homography by more than a tolerance in pixels.
//!
//! ## Why
//!
//! For DJI panoramas with high frame-to-frame overlap (~75%) and known
//! gimbal angles, the brute-force descriptor matcher routinely picks
//! zero-displacement correspondences (feature at (x, y) in image A
//! matches feature at (x, y) in image B) even when the camera has
//! rotated by 10–40°. GMS (`gms_filter`) catches the most egregious
//! cases by spatial-motion-consistency, but the zero-displacement
//! cluster IS internally consistent (everything moves by Δ = 0
//! uniformly) so GMS lets it through.
//!
//! When we already know roughly where the camera was pointing
//! (gimbal hardware reports orientation to ~0.1°), we can predict
//! the expected pixel location of every matched feature and reject
//! the ones that miss the prediction by a wide margin. The predicted
//! homography from gimbal + EXIF focal:
//!
//! ```text
//! H = K_b · R_b^T · R_a · K_a^-1
//! ```
//!
//! maps a pixel in image A to its expected pixel in image B (assuming
//! pure rotation, infinity-plane homography). Matches where the
//! observed (x_b, y_b) differs from the predicted (x̂_b, ŷ_b) by more
//! than `tolerance_px` are rejected.
//!
//! ## When NOT to use
//!
//! - No gimbal data → caller should skip this stage and rely on GMS +
//!   RANSAC alone.
//! - Strong lens distortion not yet corrected → tolerance has to be
//!   wide enough to absorb radial-distortion error. For DJI L2D-20c at
//!   24 mm equivalent, undistorted-vs-distorted disagreement at the
//!   image corner is ~5–8 px; pick `tolerance_px ≥ 50` so we don't
//!   reject correct-but-distorted matches.
//! - Hand-shot panoramas (no gimbal): use the homography from RANSAC
//!   itself as the "prediction" (i.e., this filter is the iterative
//!   reweighting step inside RANSAC, not a pre-filter).

use nalgebra::Matrix3;

use crate::types::{Features, Match, Matches};

/// Project a pixel `(x, y, 1)` through a 3×3 homography in homogeneous coords.
/// Returns `(x', y')` after dehomogenisation.  None if `H · p` has a
/// near-zero w-component (point at infinity / degenerate).
#[inline]
fn project_h(h: &Matrix3<f64>, x: f64, y: f64) -> Option<(f64, f64)> {
    let p = h * nalgebra::Vector3::new(x, y, 1.0);
    if p.z.abs() < 1e-9 {
        return None;
    }
    Some((p.x / p.z, p.y / p.z))
}

/// Reject matches where the observed pixel in B differs from the
/// homography-predicted pixel by more than `tolerance_px` (Euclidean).
///
/// `h_predicted` is the homography that maps image-A pixels to image-B
/// pixels (typically built from the two cameras' gimbal rotations and
/// EXIF focal).
///
/// Match counts:
/// - input ≥ 0
/// - output ≤ input
///
/// A match `m` with `(x_a, y_a) → (x_b, y_b)` survives iff
/// `|H · (x_a, y_a, 1) − (x_b, y_b)| ≤ tolerance_px`.
pub fn gimbal_filter(
    initial: &Matches,
    feats_a: &Features,
    feats_b: &Features,
    h_predicted: &Matrix3<f64>,
    tolerance_px: f64,
) -> Matches {
    if initial.inliers.is_empty() {
        return Matches::default();
    }
    let tol_sq = tolerance_px * tolerance_px;

    let inliers: Vec<Match> = initial
        .inliers
        .iter()
        .filter(|m| {
            let kp_a = match feats_a.keypoints.get(m.a as usize) {
                Some(k) => k,
                None => return false,
            };
            let kp_b = match feats_b.keypoints.get(m.b as usize) {
                Some(k) => k,
                None => return false,
            };
            let Some((x_pred, y_pred)) =
                project_h(h_predicted, kp_a.x as f64, kp_a.y as f64)
            else {
                return false;
            };
            let dx = x_pred - kp_b.x as f64;
            let dy = y_pred - kp_b.y as f64;
            (dx * dx + dy * dy) <= tol_sq
        })
        .copied()
        .collect();

    Matches { inliers }
}

/// Build the predicted homography that maps pixels from image A's frame
/// to image B's frame, given each camera's rotation and focal length.
///
/// Assumes both images share the same intrinsics layout: focal in pixels,
/// principal point at `(cx, cy)`. For DJI multi-row panoramas the focal
/// can vary per camera (it shouldn't, but EXIF rounding sometimes makes
/// it differ by a px or two); this is intentionally per-camera.
///
/// ```text
/// H = K_b · R_b^T · R_a · K_a^-1
/// ```
///
/// Where:
/// - K_a, K_b are the intrinsic matrices.
/// - R_a, R_b are the **camera-to-world** rotations
///   (the "rotation field" on `pano_core::types::Camera`).
pub fn predicted_homography(
    r_a: &Matrix3<f64>,
    focal_a: f64,
    r_b: &Matrix3<f64>,
    focal_b: f64,
    principal_point: (f64, f64),
) -> Matrix3<f64> {
    let (cx, cy) = principal_point;
    // K_a
    let k_a = Matrix3::new(
        focal_a, 0.0, cx,
        0.0, focal_a, cy,
        0.0, 0.0, 1.0,
    );
    // K_b
    let k_b = Matrix3::new(
        focal_b, 0.0, cx,
        0.0, focal_b, cy,
        0.0, 0.0, 1.0,
    );
    // K_a^-1
    let k_a_inv = Matrix3::new(
        1.0 / focal_a, 0.0, -cx / focal_a,
        0.0, 1.0 / focal_a, -cy / focal_a,
        0.0, 0.0, 1.0,
    );
    k_b * r_b.transpose() * r_a * k_a_inv
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Features, Keypoint, Match};

    /// Build a tiny features container: `n` keypoints at given (x, y),
    /// trivial 8-byte zero descriptors.
    fn make_features(positions: &[(f32, f32)]) -> Features {
        let n = positions.len();
        let descriptor_dim = 8;
        let keypoints = positions
            .iter()
            .map(|(x, y)| Keypoint {
                x: *x,
                y: *y,
                scale: 1.0,
                angle: 0.0,
                response: 1.0,
            })
            .collect();
        Features {
            keypoints,
            descriptors: vec![0u8; n * descriptor_dim],
            descriptor_dim,
        }
    }

    /// Identity homography keeps zero-displacement matches; rejects others.
    #[test]
    fn identity_homography_keeps_zero_displacement_only() {
        let feats_a = make_features(&[(100.0, 100.0), (200.0, 200.0), (300.0, 300.0)]);
        // Two matches at zero displacement, one at +10 px shift.
        let feats_b = make_features(&[(100.0, 100.0), (200.0, 200.0), (310.0, 300.0)]);
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
            ],
        };
        let h = Matrix3::identity();
        let kept = gimbal_filter(&matches, &feats_a, &feats_b, &h, 5.0);
        assert_eq!(kept.inliers.len(), 2, "only the zero-displacement pairs should survive");
        assert!(kept.inliers.iter().any(|m| m.a == 0));
        assert!(kept.inliers.iter().any(|m| m.a == 1));
    }

    /// A pure-translation homography (image B = image A shifted by +50 px in x)
    /// should keep matches that exhibit that shift and reject zero-displacement.
    #[test]
    fn translation_homography_rejects_zero_displacement() {
        let feats_a = make_features(&[(100.0, 100.0), (200.0, 200.0), (300.0, 300.0)]);
        // Two zero-displacement matches, one correct +50 px match.
        let feats_b = make_features(&[(100.0, 100.0), (250.0, 200.0), (300.0, 300.0)]);
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
            ],
        };
        // Translation homography: x' = x + 50, y' = y, w' = 1.
        let h = Matrix3::new(
            1.0, 0.0, 50.0,
            0.0, 1.0, 0.0,
            0.0, 0.0, 1.0,
        );
        let kept = gimbal_filter(&matches, &feats_a, &feats_b, &h, 5.0);
        // Match 0: predicted (150, 100), observed (100, 100) → 50 px error → REJECT.
        // Match 1: predicted (250, 200), observed (250, 200) → 0 px error → KEEP.
        // Match 2: predicted (350, 300), observed (300, 300) → 50 px error → REJECT.
        assert_eq!(kept.inliers.len(), 1, "only the correctly-translated match should survive");
        assert_eq!(kept.inliers[0].a, 1);
    }

    /// Tolerance scales correctly: same matches with 100 px tolerance keep all.
    #[test]
    fn loose_tolerance_keeps_everything() {
        let feats_a = make_features(&[(100.0, 100.0), (200.0, 200.0), (300.0, 300.0)]);
        let feats_b = make_features(&[(100.0, 100.0), (250.0, 200.0), (300.0, 300.0)]);
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
            ],
        };
        let h = Matrix3::new(
            1.0, 0.0, 50.0,
            0.0, 1.0, 0.0,
            0.0, 0.0, 1.0,
        );
        let kept = gimbal_filter(&matches, &feats_a, &feats_b, &h, 100.0);
        assert_eq!(kept.inliers.len(), 3);
    }

    /// `predicted_homography(I, I)` is identity (with same focal).
    #[test]
    fn predicted_homography_identity_for_same_pose() {
        let r = Matrix3::identity();
        let h = predicted_homography(&r, 1000.0, &r, 1000.0, (512.0, 384.0));
        // Should be very close to identity (up to floating-point noise).
        let diff = (h - Matrix3::identity()).abs().max();
        assert!(diff < 1e-9, "expected identity, got diff={diff}");
    }

    /// A pure yaw rotation in B (e.g. +20°) maps A's centre pixel to a
    /// point displaced by approximately `−focal × tan(20°)` in B's image.
    ///
    /// Sign convention: `R_b` is camera-to-world for camera B. If B
    /// yaws +20° right, then a point straight ahead of A (at A's
    /// principal point) appears on B's *left* in B's image — because
    /// B is now looking right, the world stayed put, so the point is
    /// to B's left. Hence x_b = cx − focal·tan(yaw).
    #[test]
    fn predicted_homography_yaw_displaces_centre() {
        let r_a = Matrix3::identity();
        let yaw_deg = 20.0_f64;
        let yaw = yaw_deg.to_radians();
        let r_b = Matrix3::new(
            yaw.cos(), 0.0, yaw.sin(),
            0.0, 1.0, 0.0,
           -yaw.sin(), 0.0, yaw.cos(),
        );
        let focal = 1000.0_f64;
        let cx = 512.0;
        let cy = 384.0;
        let h = predicted_homography(&r_a, focal, &r_b, focal, (cx, cy));
        let (px, py) = project_h(&h, cx, cy).unwrap();
        // Point A's centre in B: (cx − focal·tan(yaw), cy) ≈ (512 − 364, 384) = (148, 384).
        let expected_px = cx - focal * yaw.tan();
        let expected_py = cy;
        assert!(
            (px - expected_px).abs() < 1.0,
            "px={px}, expected≈{expected_px}",
        );
        assert!((py - expected_py).abs() < 1e-3, "py={py}, expected≈{expected_py}");
    }
}
