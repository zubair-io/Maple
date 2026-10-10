//! Resolve imported axis intent in the live binding through existing core math (#3434).
//! The camera calibration is owned once per persistent session; a slider tick
//! neither decodes metadata again nor adds another WASM round-trip.
use crate::{
    color::dcp::{self, DcpProfile, ProfileSource},
    image::{CfaPattern, RawImage},
    stages::{wb_camera, white_balance},
    types::WbMethod,
    xmp::AdjustmentModel,
};

pub struct GpuWhiteBalance {
    calibration: Option<(
        DcpProfile,
        wb_camera::SliderFrame,
        wb_camera::SliderFrameExport,
    )>,
    as_shot_neutral: [f32; 3],
}

impl GpuWhiteBalance {
    pub fn resolve(raw: &RawImage) -> Result<Self, String> {
        let (profile, source) = dcp::profile_for_with_source(raw).map_err(|e| e.to_string())?;
        let fallback = matches!(source, ProfileSource::RawlerFallback)
            || (matches!(raw.cfa, CfaPattern::LinearRgb) && raw.white_level <= 255);
        let calibration = if fallback {
            None
        } else {
            let frame = wb_camera::SliderFrame::resolve(raw, &profile);
            let export = wb_camera::SliderFrameExport::resolve(raw, &profile);
            Some((profile, frame, export))
        };
        Ok(Self {
            calibration,
            as_shot_neutral: raw.as_shot_neutral,
        })
    }

    pub fn apply(&self, model: &AdjustmentModel, inputs: &mut raw_gpu::FullChainInputs<'_>) {
        if let Some((profile, frame, export)) = &self.calibration {
            let target =
                wb_camera::resolve_target_versioned(model, frame, profile, self.as_shot_neutral);
            let anchor = (export.scene_cct, export.as_shot_tint);
            inputs.wb_matrix = export.rec2020_delta_matrix(target, anchor).0;
            // The GPU gate is expressed relative to its 6500/0 identity; the
            // matrix itself uses the actual camera frame, exactly as Apple.
            inputs.wb_temperature = 6500.0 + (target.0 - anchor.0);
            inputs.wb_tint = target.1 - anchor.1;
        } else {
            let (temperature, tint) = white_balance::resolve_wb(model);
            inputs.wb_matrix = match model.wb_method {
                WbMethod::Cat16 => white_balance::wb_cat16_matrix(temperature, tint).0,
                WbMethod::DiagonalRec2020 => {
                    let g = white_balance::wb_gains(temperature, tint);
                    [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
                }
            };
            inputs.wb_temperature = temperature;
            inputs.wb_tint = tint;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{build_full_chain_inputs, NoiseProfileInputs};
    use super::*;

    #[test]
    fn cached_camera_binding_preserves_partial_flags_scales_and_explicit_defaults() {
        for name in ["source.dng", "target.dng"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/batch-transfer")
                .join(name);
            let raw = crate::decode::decode(&path).unwrap();
            let cached = GpuWhiteBalance::resolve(&raw).unwrap();
            let profile = dcp::profile_for(&raw).unwrap();
            let frame = wb_camera::SliderFrame::resolve(&raw, &profile);
            let export = wb_camera::SliderFrameExport::resolve(&raw, &profile);
            assert!(frame.scene_tint.abs() > 0.5);
            for version in 1..=5 {
                for axis in [
                    "crs:Temperature=\"8500\"",
                    "crs:Tint=\"40\"",
                    "crs:Temperature=\"6500\"",
                    "crs:Tint=\"0\"",
                ] {
                    let xml = format!("<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" crs:WhiteBalance=\"Custom\" {axis} papp:WbScaleVersion=\"{version}\"/>");
                    let model = crate::xmp::parse(&xml).unwrap();
                    let mut inputs = build_full_chain_inputs(
                        &model,
                        Vec::new(),
                        0,
                        Vec::new(),
                        NoiseProfileInputs {
                            profile: Vec::new(),
                            iso: 0,
                        },
                        None,
                        0,
                        0.0,
                        1,
                    );
                    cached.apply(&model, &mut inputs);
                    let target = wb_camera::resolve_target_versioned(
                        &model,
                        &frame,
                        &profile,
                        raw.as_shot_neutral,
                    );
                    let anchor = (frame.scene_cct, frame.scene_tint);
                    assert_eq!(
                        inputs.wb_matrix,
                        export.rec2020_delta_matrix(target, anchor).0,
                        "{name} V{version} {axis}"
                    );
                    assert_eq!(inputs.wb_temperature, 6500.0 + (target.0 - anchor.0));
                    assert_eq!(inputs.wb_tint, target.1 - anchor.1);
                    let prefix =
                        super::super::model::stripped_prefix_model(&model, model.auto_exposure);
                    assert!(!prefix.temperature_seen && !prefix.tint_seen);
                    assert_eq!(prefix.wb_scale_version, crate::types::WbScaleVersion::V5);
                    assert_eq!(wb_camera::resolve_target(&prefix, &frame), anchor);
                }
            }
        }
    }
}
