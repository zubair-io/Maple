//! Integration tests for the AliceVision subprocess backend.
//!
//! Tests are skip-passed if the binaries can't be located (e.g. in CI
//! without an AliceVision install). Mirrors the test_pano_pipeline.sh
//! "no fixtures, skipping" pattern.

use pano_core::backends::alicevision::{locate_binaries, AlicevisionBackend};
use pano_core::backends::alicevision::sfm_data::{write_camera_init_sfm, SfmInput};
use std::path::PathBuf;

#[test]
fn locate_binaries_skips_when_absent() {
    // If MAPLE_ALICEVISION_BIN points at a nonsense path, we should
    // get a clear error rather than panicking.
    std::env::set_var("MAPLE_ALICEVISION_BIN", "/nonexistent/av/bin");
    let result = locate_binaries(None);
    assert!(result.is_err(), "expected error for missing dir");
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("does not exist"), "msg={msg}");
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
}

#[test]
fn backend_from_env_skips_cleanly_when_unset() {
    // With no env + no default install, expect a clear error not panic.
    std::env::remove_var("MAPLE_ALICEVISION_BIN");
    if std::path::PathBuf::from(format!(
        "{}/opt/alicevision/bin",
        std::env::var("HOME").unwrap_or_default()
    ))
    .exists()
    {
        // Skip — engineer has AV installed; the happy-path test covers this.
        return;
    }
    let result = AlicevisionBackend::from_env();
    assert!(result.is_err(), "expected error when AV is not installed");
}

#[test]
fn write_camera_init_sfm_produces_valid_json() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("cameraInit.sfm");
    let inputs = vec![
        SfmInput {
            path: PathBuf::from("/tmp/img1.dng"),
            width: 5376,
            height: 3956,
            focal_pixels: 5376.0,
            yaw_deg: 87.9,
            pitch_deg: -1.3,
            roll_deg: 0.0,
        },
        SfmInput {
            path: PathBuf::from("/tmp/img2.dng"),
            width: 5376,
            height: 3956,
            focal_pixels: 5376.0,
            yaw_deg: 55.6,
            pitch_deg: 19.8,
            roll_deg: 0.0,
        },
    ];
    write_camera_init_sfm(&out, &inputs).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["version"], serde_json::json!(["1", "2", "7"]));
    assert_eq!(parsed["views"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["intrinsics"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["poses"].as_array().unwrap().len(), 2);
}

#[test]
fn euler_zero_angles_is_identity() {
    let r = pano_core::backends::alicevision::euler_to_rotation(0.0, 0.0, 0.0);
    let i = nalgebra::Matrix3::<f64>::identity();
    let max_diff = (r - i).abs().max();
    assert!(max_diff < 1e-9, "expected identity, got {r}");
}

#[test]
fn euler_90_yaw_rotates_x_to_minus_z() {
    let r = pano_core::backends::alicevision::euler_to_rotation(90.0, 0.0, 0.0);
    let v = nalgebra::Vector3::new(1.0, 0.0, 0.0);
    let v2 = r * v;
    // R_y(90) maps (1,0,0) -> (cos90, 0, -sin90) = (0, 0, -1)
    assert!((v2.x - 0.0).abs() < 1e-9, "x={}", v2.x);
    assert!((v2.y - 0.0).abs() < 1e-9, "y={}", v2.y);
    assert!((v2.z + 1.0).abs() < 1e-9, "z={}", v2.z);
}
