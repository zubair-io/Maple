//! Locate the AliceVision binaries on disk.
//!
//! Resolution order:
//! 1. Explicit path passed to `locate_binaries(Some(path))`.
//! 2. `MAPLE_ALICEVISION_BIN` environment variable.
//! 3. `~/opt/alicevision/bin` (the default install prefix from
//!    docs/setup/alicevision-build.md).

use std::path::PathBuf;

use crate::error::PanoError;

/// Resolved paths to the 10 panorama-pipeline binaries we drive.
#[derive(Debug, Clone)]
pub struct AlicevisionBinaries {
    pub camera_init: PathBuf,
    pub feature_extraction: PathBuf,
    pub image_matching: PathBuf,
    pub feature_matching: PathBuf,
    pub panorama_estimation: PathBuf,
    pub panorama_warping: PathBuf,
    pub panorama_seams: PathBuf,
    pub panorama_compositing: PathBuf,
    pub panorama_merging: PathBuf,
    pub image_processing: PathBuf,
}

const REQUIRED: &[&str] = &[
    "aliceVision_cameraInit",
    "aliceVision_featureExtraction",
    "aliceVision_imageMatching",
    "aliceVision_featureMatching",
    "aliceVision_panoramaEstimation",
    "aliceVision_panoramaWarping",
    "aliceVision_panoramaSeams",
    "aliceVision_panoramaCompositing",
    "aliceVision_panoramaMerging",
    "aliceVision_imageProcessing",
];

pub fn locate_binaries(explicit_dir: Option<PathBuf>) -> Result<AlicevisionBinaries, PanoError> {
    let dir = explicit_dir
        .or_else(|| std::env::var("MAPLE_ALICEVISION_BIN").ok().map(PathBuf::from))
        .or_else(|| dirs_home().map(|h| h.join("opt/alicevision/bin")))
        .ok_or_else(|| {
            PanoError::Other(
                "AliceVision binary directory not found; set MAPLE_ALICEVISION_BIN".into(),
            )
        })?;

    if !dir.is_dir() {
        return Err(PanoError::Other(format!(
            "AliceVision binary directory does not exist: {}",
            dir.display()
        )));
    }

    let mut paths = Vec::with_capacity(REQUIRED.len());
    for name in REQUIRED {
        let p = dir.join(name);
        if !p.is_file() {
            return Err(PanoError::Other(format!(
                "AliceVision binary missing: {}",
                p.display()
            )));
        }
        paths.push(p);
    }

    Ok(AlicevisionBinaries {
        camera_init: paths[0].clone(),
        feature_extraction: paths[1].clone(),
        image_matching: paths[2].clone(),
        feature_matching: paths[3].clone(),
        panorama_estimation: paths[4].clone(),
        panorama_warping: paths[5].clone(),
        panorama_seams: paths[6].clone(),
        panorama_compositing: paths[7].clone(),
        panorama_merging: paths[8].clone(),
        image_processing: paths[9].clone(),
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}
