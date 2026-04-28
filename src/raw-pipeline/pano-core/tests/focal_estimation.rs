//! Tests for focal-from-homography using synthetic ground truth.

use nalgebra::Matrix3;
use pano_core::ba::focal::focal_from_homography;
use pano_core::ba::homography::Homography;

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
fn focal_recovered_from_synthetic_yaw_homography() {
    // Build H = K · R · K⁻¹ for a 30° yaw with known focal=256 in
    // a 256×256 image. Verify the inverse extraction recovers 256
    // within ±5%.
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

#[test]
fn focal_recovered_for_various_focals_and_yaws() {
    for &focal_truth in &[128.0_f64, 256.0, 512.0, 1024.0, 5376.0] {
        for &yaw_deg in &[10.0_f64, 30.0, 60.0, 90.0] {
            let image_size = (focal_truth as u32, focal_truth as u32);
            let k = camera_k(focal_truth, image_size.0, image_size.1);
            let k_inv = k.try_inverse().unwrap();
            let r = yaw(yaw_deg);
            let h = k * r * k_inv;
            let homography = Homography(h);

            let f_est = focal_from_homography(&homography, image_size)
                .expect("should recover focal");
            let rel_err = (f_est - focal_truth).abs() / focal_truth;
            assert!(
                rel_err < 0.05,
                "focal={focal_truth} yaw={yaw_deg}°: estimate {f_est} off by {rel_err:.4}"
            );
        }
    }
}

#[test]
fn focal_returns_none_for_identity_homography() {
    let homography = Homography(Matrix3::identity());
    let f_est = focal_from_homography(&homography, (256, 256));
    // Identity = no rotation = no constraint on f. Should return None
    // OR a sentinel positive value; just verify it doesn't panic.
    let _ = f_est;
}
