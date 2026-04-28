//! Joint rotation+focal BA tests on synthetic ground-truth scenes.

use nalgebra::{Matrix3, Vector3};
use pano_core::ba::joint::{solve_joint, JointRotationFocalBA};
use pano_core::types::{Features, Keypoint, Match, Matches};

/// Build a yaw-only rotation matrix for testing.
fn yaw(deg: f64) -> Matrix3<f64> {
    let r = deg.to_radians();
    Matrix3::new(
        r.cos(),  0.0, r.sin(),
        0.0,      1.0, 0.0,
       -r.sin(),  0.0, r.cos(),
    )
}

/// Project a 3D world point through a camera (K * R * point) and return
/// the pixel (u, v) in the camera's image plane.
fn project(p_world: Vector3<f64>, r: Matrix3<f64>, focal: f64, cx: f64, cy: f64) -> (f64, f64) {
    let p_cam = r * p_world;
    if p_cam.z <= 1e-9 {
        return (f64::NAN, f64::NAN);
    }
    let x = focal * p_cam.x / p_cam.z + cx;
    let y = focal * p_cam.y / p_cam.z + cy;
    (x, y)
}

#[test]
fn joint_ba_recovers_three_yaw_rotations() {
    // Three cameras at known yaws {0°, 30°, 60°}, identity intrinsics
    // (cx=cy=128, focal=256). Generate 50 synthetic 3D points in front
    // of camera 0 and project through each. Match consecutive pairs
    // by 3D-point identity (so 50 perfect inliers between (0,1) and
    // (1,2)). Joint BA must recover the three rotations within ±0.5°.

    let n_cams = 3;
    let yaws_deg = vec![0.0, 30.0, 60.0];
    let focal = 256.0;
    let cx = 128.0;
    let cy = 128.0;
    let image_w = 256u32;
    let image_h = 256u32;

    let r_truth: Vec<Matrix3<f64>> = yaws_deg.iter().map(|&d| yaw(d)).collect();

    // Generate 50 random 3D points in front of camera 0.
    let mut rng_state = 12345u64;
    let mut next_f64 = || {
        rng_state = rng_state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((rng_state >> 33) as f64) / (u32::MAX as f64) - 0.5
    };

    // Generate 60 world points spread over the angular range of all 3 cameras
    // (yaw 0..60°) so consecutive pairs (0,1) and (1,2) each have good overlap.
    // Points are placed at radius ≈ 1..1.3, theta ∈ [0°, 60°], phi ∈ [−10°, 10°].
    let mut world_pts = Vec::with_capacity(60);
    let n_pts = 60usize;
    for i in 0..n_pts {
        let _ = next_f64(); // consume rng for determinism
        let _ = next_f64();
        let _ = next_f64();
        // Sweep theta from −5° to 65° to ensure overlap with all 3 camera FOVs.
        let t = i as f64 / n_pts as f64;
        let theta_deg = -5.0 + t * 70.0;
        let phi_deg = ((i % 7) as f64 - 3.0) * 2.5; // ±7.5° elevation
        let radius = 1.0 + (i % 4) as f64 * 0.08;
        let theta = theta_deg.to_radians();
        let phi = phi_deg.to_radians();
        world_pts.push(Vector3::new(
            radius * theta.sin() * phi.cos(),
            radius * phi.sin(),
            radius * theta.cos() * phi.cos(),
        ));
    }

    // Project each world point through each camera.
    let n_pts = world_pts.len();
    let mut features: Vec<Features> = Vec::with_capacity(n_cams);
    let mut visible_in_cam: Vec<Vec<Option<usize>>> = vec![vec![None; n_pts]; n_cams];

    for (cam_idx, r) in r_truth.iter().enumerate() {
        let mut keypoints: Vec<Keypoint> = Vec::new();
        for (pt_idx, p) in world_pts.iter().enumerate() {
            // R^-1 takes a point in cam-0 world coords into cam_idx's
            // body frame. For a camera that has been rotated by R from
            // cam 0's pose, the inverse R^T projects world points into
            // its image plane.
            let r_inv = r.transpose();
            let (u, v) = project(*p, r_inv, focal, cx, cy);
            if u.is_finite()
                && v.is_finite()
                && u >= 0.0
                && v >= 0.0
                && u < image_w as f64
                && v < image_h as f64
            {
                visible_in_cam[cam_idx][pt_idx] = Some(keypoints.len());
                keypoints.push(Keypoint {
                    x: u as f32, y: v as f32,
                    scale: 1.0, angle: 0.0, response: 1.0,
                });
            }
        }
        features.push(Features { keypoints, descriptors: vec![], descriptor_dim: 0 });
    }

    // Build pairs (0,1) and (1,2) by matching points visible in both.
    let mut pairs: Vec<(usize, usize, Matches)> = Vec::new();
    for (i, j) in [(0usize, 1usize), (1, 2)] {
        let mut inliers = Vec::new();
        for pt_idx in 0..n_pts {
            if let (Some(ka), Some(kb)) = (visible_in_cam[i][pt_idx], visible_in_cam[j][pt_idx]) {
                inliers.push(Match { a: ka as u32, b: kb as u32, distance: 0.0 });
            }
        }
        assert!(
            inliers.len() >= 8,
            "expected ≥8 visible matches in pair ({i},{j}), got {} (points need to overlap both cameras)",
            inliers.len()
        );
        pairs.push((i, j, Matches { inliers }));
    }

    let cameras = solve_joint(&features, &pairs, (image_w, image_h)).expect("solve should succeed");
    assert_eq!(cameras.len(), n_cams);

    // Camera 0 should be identity (gauge fix).
    let r0 = cameras[0].rotation.cast::<f64>();
    let r0_diff = (r0 - Matrix3::<f64>::identity()).abs().max();
    assert!(r0_diff < 1e-3, "cam[0] should be identity, max diff = {r0_diff}");

    // Cameras 1 and 2 should be yaw(30°) and yaw(60°) within ±0.5°.
    for (idx, expected_deg) in [(1, 30.0), (2, 60.0)] {
        let r = cameras[idx].rotation.cast::<f64>();
        let expected = yaw(expected_deg);
        let r_diff = (r - expected).abs().max();
        // Convert max element diff to rough angle error (approx).
        assert!(
            r_diff < 0.01,
            "cam[{idx}] rotation off by max element {r_diff}; expected yaw({expected_deg}°)"
        );
    }
}

/// Verify the Rodrigues helpers are self-consistent inside the crate.
#[test]
fn rodrigues_helpers_via_public_path() {
    use pano_core::ba::joint::{rodrigues_exp, rodrigues_log};

    let omega = Vector3::new(0.1f64, 0.5, -0.3);
    let r = rodrigues_exp(omega);
    let back = rodrigues_log(&r);
    assert!((back - omega).norm() < 1e-6, "roundtrip: got {back:?}");
}
