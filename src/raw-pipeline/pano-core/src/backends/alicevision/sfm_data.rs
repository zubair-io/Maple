//! Minimum SfMData v1.2.7 JSON writer for AliceVision pano init.
//!
//! We only emit the fields the panorama pipeline reads:
//! - top-level `version` triple
//! - per-image `views[]`
//! - per-image `intrinsics[]` (assumes one intrinsic per image —
//!   correct for DJI panos where every frame is from the same lens)
//! - per-image `poses[]` (initial rotation from gimbal Euler angles).
//!
//! The Euler→rotation convention follows AliceVision's:
//! R = Rz(roll) · Rx(pitch) · Ry(yaw) — verify against
//! `aliceVision_cameraInit --useExifCameraOrientation` output on a
//! known fixture during Phase 1.

use std::path::{Path, PathBuf};

use nalgebra::Matrix3;
use serde::Serialize;

use crate::error::PanoError;

/// One image's worth of SfMData input.
#[derive(Debug, Clone)]
pub struct SfmInput {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub focal_pixels: f32,
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
}

/// Convert DJI Euler angles (yaw around Y, pitch around X, roll
/// around Z) to a 3×3 rotation matrix in AliceVision's convention.
pub fn euler_to_rotation(yaw_deg: f32, pitch_deg: f32, roll_deg: f32) -> Matrix3<f64> {
    let yaw = (yaw_deg as f64).to_radians();
    let pitch = (pitch_deg as f64).to_radians();
    let roll = (roll_deg as f64).to_radians();
    let rz = Matrix3::new(
        roll.cos(), -roll.sin(), 0.0,
        roll.sin(),  roll.cos(), 0.0,
        0.0,         0.0,        1.0,
    );
    let rx = Matrix3::new(
        1.0, 0.0,           0.0,
        0.0, pitch.cos(), -pitch.sin(),
        0.0, pitch.sin(),  pitch.cos(),
    );
    let ry = Matrix3::new(
         yaw.cos(), 0.0, yaw.sin(),
         0.0,       1.0, 0.0,
        -yaw.sin(), 0.0, yaw.cos(),
    );
    rz * rx * ry
}

#[derive(Serialize)]
struct SfmDataDoc {
    version: [&'static str; 3],
    views: Vec<View>,
    intrinsics: Vec<Intrinsic>,
    poses: Vec<Pose>,
    #[serde(rename = "featuresFolders")]
    features_folders: Vec<String>,
    #[serde(rename = "matchesFolders")]
    matches_folders: Vec<String>,
}

#[derive(Serialize)]
struct View {
    #[serde(rename = "viewId")]
    view_id: String,
    #[serde(rename = "poseId")]
    pose_id: String,
    #[serde(rename = "intrinsicId")]
    intrinsic_id: String,
    width: String,
    height: String,
    path: String,
}

#[derive(Serialize)]
struct Intrinsic {
    #[serde(rename = "intrinsicId")]
    intrinsic_id: String,
    width: String,
    height: String,
    #[serde(rename = "sensorWidth")]
    sensor_width: String,
    #[serde(rename = "sensorHeight")]
    sensor_height: String,
    #[serde(rename = "type")]
    intrinsic_type: String,
    #[serde(rename = "pxInitialFocalLength")]
    px_initial_focal_length: String,
    #[serde(rename = "pxFocalLength")]
    px_focal_length: String,
    #[serde(rename = "principalPoint")]
    principal_point: [String; 2],
    #[serde(rename = "distortionParams")]
    distortion_params: Vec<String>,
}

#[derive(Serialize)]
struct Pose {
    #[serde(rename = "poseId")]
    pose_id: String,
    pose: PoseInner,
}

#[derive(Serialize)]
struct PoseInner {
    transform: PoseTransform,
    locked: String,
}

#[derive(Serialize)]
struct PoseTransform {
    rotation: [String; 9],
    center: [String; 3],
}

pub fn write_camera_init_sfm(out: &Path, inputs: &[SfmInput]) -> Result<(), PanoError> {
    let mut views = Vec::with_capacity(inputs.len());
    let mut intrinsics = Vec::with_capacity(inputs.len());
    let mut poses = Vec::with_capacity(inputs.len());

    for (i, input) in inputs.iter().enumerate() {
        let id = (i as u64 + 1).to_string();
        let path = input
            .path
            .canonicalize()
            .unwrap_or_else(|_| input.path.clone())
            .to_string_lossy()
            .into_owned();

        views.push(View {
            view_id: id.clone(),
            pose_id: id.clone(),
            intrinsic_id: id.clone(),
            width: input.width.to_string(),
            height: input.height.to_string(),
            path,
        });

        // Sensor size: DJI L2D-20c 4/3" sensor is ~17.3 × 13 mm.
        // Use a placeholder; AliceVision recomputes from focal pixels +
        // image width if `pxFocalLength` is set.
        intrinsics.push(Intrinsic {
            intrinsic_id: id.clone(),
            width: input.width.to_string(),
            height: input.height.to_string(),
            sensor_width: "36.0".into(),
            sensor_height: "24.0".into(),
            intrinsic_type: "pinhole".into(),
            px_initial_focal_length: input.focal_pixels.to_string(),
            px_focal_length: input.focal_pixels.to_string(),
            principal_point: [
                (input.width as f32 / 2.0).to_string(),
                (input.height as f32 / 2.0).to_string(),
            ],
            distortion_params: vec![],
        });

        let r = euler_to_rotation(input.yaw_deg, input.pitch_deg, input.roll_deg);
        let rotation = [
            r[(0, 0)].to_string(), r[(0, 1)].to_string(), r[(0, 2)].to_string(),
            r[(1, 0)].to_string(), r[(1, 1)].to_string(), r[(1, 2)].to_string(),
            r[(2, 0)].to_string(), r[(2, 1)].to_string(), r[(2, 2)].to_string(),
        ];
        poses.push(Pose {
            pose_id: id,
            pose: PoseInner {
                transform: PoseTransform {
                    rotation,
                    center: ["0".into(), "0".into(), "0".into()],
                },
                locked: "0".into(),
            },
        });
    }

    let doc = SfmDataDoc {
        version: ["1", "2", "7"],
        views,
        intrinsics,
        poses,
        features_folders: vec![],
        matches_folders: vec![],
    };

    let json = serde_json::to_string_pretty(&doc)
        .map_err(|e| PanoError::Other(format!("SfMData serialise: {e}")))?;
    std::fs::write(out, json)
        .map_err(|e| PanoError::Other(format!("write {}: {e}", out.display())))?;
    Ok(())
}
