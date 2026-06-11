//! Two-view relative rotation from bearing correspondences (spec §5.2 /
//! §5.3 — the pure-rotation pano camera model).
//!
//! # Conventions (binding)
//!
//! - A **pixel correspondence** is a bare pair of continuous pixel
//!   coordinates, one per frame — deliberately free of any
//!   keypoint/descriptor structure (those types belong to the ML-stack
//!   port, ticket #1139; this module is the geometry consumer side of
//!   that boundary).
//! - A **bearing** is the unit direction of a pixel's ray in its own
//!   *camera frame* (+X right, +Y down, +Z optical axis), obtained via
//!   [`crate::camera::Camera::pixel_to_camera_dir`] — intrinsics +
//!   distortion inverse only, pose ignored.
//! - The estimated **relative rotation** `R_ab` maps frame-A bearings to
//!   frame-B bearings: `d_b ≈ R_ab · d_a`. Against ground-truth
//!   camera-to-world poses this is `R_ab = R_bᵀ · R_a` (both frames see
//!   the same world direction `d_w = R_a·d_a = R_b·d_b`).
//!
//! # Solver
//!
//! [`solve_rotation`] solves the orthogonal-Procrustes / Wahba problem —
//! minimize `Σ wᵢ‖bᵢ − R·aᵢ‖²` over rotations — in closed form with
//! **Davenport's q-method**: accumulate the 3×3 profile matrix
//! `S = Σ wᵢ aᵢ bᵢᵀ`, build Horn's symmetric 4×4 quaternion matrix `N`
//! from it, and take the eigenvector of the largest eigenvalue
//! ([`crate::eigen`], hand-rolled Jacobi — no linear-algebra dependency).
//! The quaternion convention is Hamilton `(w, x, y, z)` with `R(q)·a ≈ b`.
//!
//! **Two correspondences suffice** for pure rotation: a rotation has
//! 3 degrees of freedom while each unit-bearing pair contributes 2
//! constraints (a direction, not a length). One pair leaves the roll
//! about that bearing free — visible in the q-method as a repeated
//! dominant eigenvalue — and two non-collinear pairs pin all 3 DOF.
//! [`solve_rotation`] therefore returns `None` for under-determined
//! inputs (fewer than 2 effective pairs, or pairs collinear enough that
//! the dominant eigenvalue is repeated to machine precision).

use crate::camera::Camera;
use crate::eigen::eigen_symmetric;
use crate::math::{matrix_to_axis_angle, Mat3, Vec3};

/// One pixel match between two frames: `a` in the first camera's image,
/// `b` in the second camera's image, both in continuous pixel
/// coordinates (origin top-left, texel centers at half-integers).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelCorrespondence {
    pub a: (f64, f64),
    pub b: (f64, f64),
}

/// Convert pixel correspondences to bearing pairs through each camera's
/// intrinsics (undistorting via the Newton inverse).
///
/// Output is index-aligned with the input; an entry is `None` when the
/// distortion polynomial is not invertible at that pixel's radius (does
/// not happen for physically plausible `k1`/`k2` inside the frame —
/// callers treat such entries as unusable, never as inliers). Camera
/// poses are ignored ([`Camera::pixel_to_camera_dir`]).
pub fn bearing_correspondences(
    cam_a: &Camera,
    cam_b: &Camera,
    matches: &[PixelCorrespondence],
) -> Vec<Option<(Vec3, Vec3)>> {
    matches
        .iter()
        .map(|m| {
            let da = cam_a.pixel_to_camera_dir(m.a.0, m.a.1)?;
            let db = cam_b.pixel_to_camera_dir(m.b.0, m.b.1)?;
            Some((da, db))
        })
        .collect()
}

/// Closed-form Wahba solve: the rotation minimizing `Σ wᵢ‖bᵢ − R·aᵢ‖²`
/// (Davenport q-method; see module docs).
///
/// `weights`, when given, must be the same length as `pairs`; entries
/// `≤ 0` (or non-finite) drop the pair from the accumulation. With
/// `None` every pair weighs 1. Returns `None` when the problem is
/// under-determined: fewer than 2 contributing pairs, zero total weight,
/// or a (near-)repeated dominant eigenvalue (collinear bearings — the
/// rotation about the common axis is free).
pub fn solve_rotation(pairs: &[(Vec3, Vec3)], weights: Option<&[f64]>) -> Option<Mat3> {
    if let Some(w) = weights {
        assert_eq!(
            w.len(),
            pairs.len(),
            "solve_rotation: weights length must match pairs"
        );
    }

    // Profile matrix S = Σ w·a·bᵀ (row i, col j ⇔ a_i·b_j).
    let mut s = [[0.0_f64; 3]; 3];
    let mut w_total = 0.0_f64;
    let mut contributing = 0_usize;
    for (idx, (a, b)) in pairs.iter().enumerate() {
        let w = weights.map_or(1.0, |w| w[idx]);
        if !w.is_finite() || w <= 0.0 {
            continue;
        }
        let av = [a.x, a.y, a.z];
        let bv = [b.x, b.y, b.z];
        for (i, &ai) in av.iter().enumerate() {
            for (j, &bj) in bv.iter().enumerate() {
                s[i][j] += w * ai * bj;
            }
        }
        w_total += w;
        contributing += 1;
    }
    if contributing < 2 || w_total <= 0.0 {
        return None;
    }

    // Horn's symmetric 4×4 matrix N; the optimal quaternion is its
    // dominant eigenvector (Horn 1987, "Closed-form solution of absolute
    // orientation using unit quaternions", §4).
    let (sxx, sxy, sxz) = (s[0][0], s[0][1], s[0][2]);
    let (syx, syy, syz) = (s[1][0], s[1][1], s[1][2]);
    let (szx, szy, szz) = (s[2][0], s[2][1], s[2][2]);
    let n = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ];
    let (vals, vecs) = eigen_symmetric(&n);

    // Repeated dominant eigenvalue ⇔ a 1-parameter family of optimal
    // rotations (collinear bearings). The gap scales with the total
    // weight, so the threshold is relative to it.
    if vals[0] - vals[1] <= 1e-12 * w_total.max(f64::MIN_POSITIVE) {
        return None;
    }
    Some(quaternion_to_matrix(vecs[0]))
}

/// Hamilton quaternion `(w, x, y, z)` → rotation matrix. Normalizes the
/// input (the eigenvector is unit up to rounding).
fn quaternion_to_matrix(q: [f64; 4]) -> Mat3 {
    let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    let (w, x, y, z) = (q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm);
    Mat3([
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ])
}

/// Angular residual of one bearing pair under a relative rotation:
/// the angle between `r_ab·a` and `b`, radians.
///
/// `atan2(‖p×b‖, p·b)` rather than `acos(p·b)` — the residuals the
/// robust stage scores are ~1e-3 rad, where acos near 1 loses half the
/// significand.
pub fn angular_residual_rad(r_ab: &Mat3, a: Vec3, b: Vec3) -> f64 {
    let p = r_ab.mul_vec(a);
    p.cross(b).norm().atan2(p.dot(b))
}

/// Geodesic distance between two rotations, radians: the angle of
/// `r1ᵀ·r2`, recovered through the precision-safe axis-angle log map.
pub fn rotation_angle_between(r1: &Mat3, r2: &Mat3) -> f64 {
    let m = r1.transpose().mul_mat(r2);
    let w = matrix_to_axis_angle(&m);
    (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt()
}

/// Ground-truth relative rotation between two posed cameras, in the
/// [`solve_rotation`] convention: `d_b = R_ab · d_a` with
/// `R_ab = R_bᵀ · R_a` (camera-to-world poses).
pub fn relative_rotation_ground_truth(cam_a: &Camera, cam_b: &Camera) -> Mat3 {
    cam_b.rotation.transpose().mul_mat(&cam_a.rotation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::axis_angle_to_matrix;
    use crate::prng::SplitMix64;

    fn random_rotation(rng: &mut SplitMix64) -> Mat3 {
        let axis = rng.next_unit_vector();
        let angle = rng.next_range(-3.0, 3.0);
        axis_angle_to_matrix([axis.x * angle, axis.y * angle, axis.z * angle])
    }

    #[test]
    fn exact_pairs_recover_rotation_to_machine_precision() {
        let mut rng = SplitMix64::new(11);
        for _ in 0..40 {
            let r_gt = random_rotation(&mut rng);
            let pairs: Vec<(Vec3, Vec3)> = (0..12)
                .map(|_| {
                    let a = rng.next_unit_vector();
                    (a, r_gt.mul_vec(a))
                })
                .collect();
            let r = solve_rotation(&pairs, None).expect("well-posed");
            assert!(
                rotation_angle_between(&r, &r_gt) < 1e-10,
                "recovered rotation off by {} rad",
                rotation_angle_between(&r, &r_gt)
            );
        }
    }

    #[test]
    fn two_point_minimal_sample_is_exact() {
        let mut rng = SplitMix64::new(23);
        for _ in 0..40 {
            let r_gt = random_rotation(&mut rng);
            let a1 = rng.next_unit_vector();
            let mut a2 = rng.next_unit_vector();
            // Keep the sample comfortably non-collinear.
            while a1.cross(a2).norm() < 0.2 {
                a2 = rng.next_unit_vector();
            }
            let pairs = [(a1, r_gt.mul_vec(a1)), (a2, r_gt.mul_vec(a2))];
            let r = solve_rotation(&pairs, None).expect("two non-collinear pairs");
            assert!(rotation_angle_between(&r, &r_gt) < 1e-9);
        }
    }

    #[test]
    fn under_determined_inputs_return_none() {
        let a = Vec3::new(0.0, 0.0, 1.0);
        let r_gt = Mat3::rotation_y(0.4);
        // One pair: roll about the bearing is free.
        assert!(solve_rotation(&[(a, r_gt.mul_vec(a))], None).is_none());
        // Collinear pairs: same freedom.
        let collinear = [
            (a, r_gt.mul_vec(a)),
            (a.scale(-1.0), r_gt.mul_vec(a.scale(-1.0))),
        ];
        assert!(solve_rotation(&collinear, None).is_none());
        // Empty.
        assert!(solve_rotation(&[], None).is_none());
        // All weights zero.
        let two = [
            (a, r_gt.mul_vec(a)),
            (
                Vec3::new(1.0, 0.0, 0.0),
                r_gt.mul_vec(Vec3::new(1.0, 0.0, 0.0)),
            ),
        ];
        assert!(solve_rotation(&two, Some(&[0.0, 0.0])).is_none());
    }

    #[test]
    fn zero_weight_drops_a_corrupted_pair() {
        let mut rng = SplitMix64::new(5);
        let r_gt = random_rotation(&mut rng);
        let mut pairs: Vec<(Vec3, Vec3)> = (0..8)
            .map(|_| {
                let a = rng.next_unit_vector();
                (a, r_gt.mul_vec(a))
            })
            .collect();
        // Corrupt one pair completely.
        pairs.push((rng.next_unit_vector(), rng.next_unit_vector()));
        let mut weights = vec![1.0; pairs.len()];
        weights[8] = 0.0;
        let r = solve_rotation(&pairs, Some(&weights)).expect("well-posed");
        assert!(rotation_angle_between(&r, &r_gt) < 1e-10);
        // Sanity: with the corrupted pair weighted in, the fit degrades.
        let r_biased = solve_rotation(&pairs, None).expect("still solvable");
        assert!(rotation_angle_between(&r_biased, &r_gt) > 1e-6);
    }

    #[test]
    fn bearing_conversion_matches_camera_chain_and_residual_is_zero() {
        // Two posed cameras with distortion; correspondences built by
        // projecting world directions through both.
        let cam_a = Camera::new([0.1, -0.4, 0.05], 700.0, -0.06, 0.025, 1024, 768);
        let cam_b = Camera::new([-0.05, 0.3, -0.1], 650.0, -0.06, 0.025, 1024, 768);
        let r_gt = relative_rotation_ground_truth(&cam_a, &cam_b);

        let mut matches = Vec::new();
        let mut rng = SplitMix64::new(77);
        while matches.len() < 24 {
            let px = rng.next_range(8.0, 1016.0);
            let py = rng.next_range(8.0, 760.0);
            let d = cam_a.pixel_to_world_dir(px, py).unwrap();
            let Some((qx, qy)) = cam_b.world_dir_to_pixel(d) else {
                continue;
            };
            if !cam_b.pixel_in_bounds(qx, qy, 2.0) {
                continue;
            }
            matches.push(PixelCorrespondence {
                a: (px, py),
                b: (qx, qy),
            });
        }

        let bearings = bearing_correspondences(&cam_a, &cam_b, &matches);
        let pairs: Vec<(Vec3, Vec3)> = bearings.into_iter().map(|p| p.unwrap()).collect();
        for &(a, b) in &pairs {
            assert!(
                angular_residual_rad(&r_gt, a, b) < 1e-9,
                "exact correspondences must have ~zero residual under the GT rotation"
            );
        }
        let r = solve_rotation(&pairs, None).expect("well-posed");
        assert!(rotation_angle_between(&r, &r_gt) < 1e-9);
    }

    #[test]
    fn rotation_angle_between_is_precise_for_tiny_angles() {
        let r1 = Mat3::identity();
        let r2 = axis_angle_to_matrix([1e-7, 0.0, 0.0]);
        let angle = rotation_angle_between(&r1, &r2);
        assert!((angle - 1e-7).abs() < 1e-13, "got {angle}");
    }
}
