//! AliceVision 3.3.0 panorama pipeline as a subprocess backend.
//!
//! AliceVision ships 10 standalone CLI tools (cameraInit,
//! featureExtraction, imageMatching, featureMatching,
//! panoramaEstimation, panoramaWarping, panoramaSeams,
//! panoramaCompositing, panoramaMerging, imageProcessing for
//! EXR→PNG conversion). They exchange SfMData JSON between stages.
//! We invoke them in sequence via std::process::Command, writing
//! intermediates to a tempdir.
//!
//! Build setup: see docs/setup/alicevision-build.md.
//! Binary location: configured via env var MAPLE_ALICEVISION_BIN
//! (defaults to ~/opt/alicevision/bin) or AlicevisionBackend::new
//! explicit path.

mod locate;
pub mod sfm_data;

pub use locate::{locate_binaries, AlicevisionBinaries};
pub use sfm_data::{euler_to_rotation, write_camera_init_sfm, SfmInput};

use std::path::{Path, PathBuf};

use crate::error::PanoError;
use crate::types::PanoImage;

/// Subprocess-driven AliceVision panorama backend.
pub struct AlicevisionBackend {
    bins: AlicevisionBinaries,
}

impl AlicevisionBackend {
    /// Construct using `MAPLE_ALICEVISION_BIN` env or the default
    /// `~/opt/alicevision/bin` path.
    pub fn from_env() -> Result<Self, PanoError> {
        let bins = locate_binaries(None)?;
        Ok(Self { bins })
    }

    /// Construct from an explicit binary directory.
    pub fn from_path(bin_dir: impl AsRef<Path>) -> Result<Self, PanoError> {
        let bins = locate_binaries(Some(bin_dir.as_ref().to_path_buf()))?;
        Ok(Self { bins })
    }

    /// Stitch — implementation lands in Task 2.4.
    pub fn stitch(
        &self,
        _input_paths: &[PathBuf],
    ) -> Result<PanoImage, PanoError> {
        Err(PanoError::Other("not yet implemented (Task 2.4)".into()))
    }
}
