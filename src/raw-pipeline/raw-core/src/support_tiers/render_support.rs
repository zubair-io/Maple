//! Per-open support facts from the same resolver used by the develop chain.
//! No make/model heuristic and no qualification promotion happen here.

use super::{LensSupport, ProfileResolution};
use crate::{
    color::{dcp, profile_loader},
    image::RawImage,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderSupport {
    pub camera_key: String,
    pub resolution: ProfileResolution,
    pub lens: LensSupport,
}

impl RenderSupport {
    pub fn resolve(raw: &RawImage) -> crate::Result<Self> {
        let (_, source) = dcp::profile_for_with_source(raw)?;
        Ok(Self::from_source(raw, &source))
    }

    /// Reuse the provenance from a profile the caller already resolved.
    pub fn from_source(raw: &RawImage, source: &dcp::ProfileSource) -> Self {
        Self {
            camera_key: profile_loader::camera_key_for(raw).unique_camera_model,
            resolution: ProfileResolution::from(source),
            lens: if raw.has_lens_corrections() {
                LensSupport::EmbeddedCorrection
            } else {
                LensSupport::NoCorrectionData
            },
        }
    }

    /// Shared transport for WASM and C-FFI. The vocabulary is generated for
    /// consumers; the file's resolver result is never reconstructed there.
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "cameraKey": self.camera_key,
            "resolution": self.resolution.id(),
            "lens": self.lens.id(),
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        color::illuminant::Illuminant,
        image::{CfaPattern, ExifOrientation},
        math::Matrix3,
    };
    use std::collections::HashMap;

    fn raw() -> RawImage {
        RawImage {
            width: 1,
            height: 1,
            cfa: CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: 1,
            raw_data: vec![0],
            as_shot_neutral: [1.; 3],
            as_shot_cct: None,
            camera_make: "Unregistered".into(),
            camera_model: "Test camera".into(),
            unique_camera_model: Some("Unknown lens-specific body".into()),
            color_matrices: HashMap::new(),
            forward_matrices: HashMap::new(),
            orientation: ExifOrientation::Normal,
            baseline_exposure: 0.,
            hsm_data: HashMap::new(),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
            opcode_list3: None,
            aperture: None,
            focal_length: None,
            lens_metadata: Default::default(),
        }
    }

    #[test]
    fn source_is_resolved_from_file_calibration_not_camera_name() {
        let mut raw = raw();
        let missing = RenderSupport::resolve(&raw).unwrap();
        assert_eq!(missing.resolution, ProfileResolution::RawlerFallback);
        assert_eq!(missing.lens, LensSupport::NoCorrectionData);
        raw.color_matrices.insert(
            Illuminant::D65,
            Matrix3([[0.7, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.6]]),
        );
        let calibrated = RenderSupport::resolve(&raw).unwrap();
        assert_eq!(calibrated.resolution, ProfileResolution::EmbeddedCmOnly);
        assert_eq!(missing.camera_key, calibrated.camera_key);
        assert_eq!(calibrated.camera_key, "Unknown lens-specific body");
        let wire: serde_json::Value = serde_json::from_str(&calibrated.to_json()).unwrap();
        assert_eq!(wire["resolution"], "embedded_cm_only");
        assert_eq!(wire["lens"], "no_correction_data");
    }
}
