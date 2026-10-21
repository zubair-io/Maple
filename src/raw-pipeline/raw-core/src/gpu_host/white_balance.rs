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
    hsm: Option<(wb_camera::WbHsmRetarget, std::sync::Arc<[f32]>)>,
    as_shot_neutral: [f32; 3],
}

/// The GPU WB pass inputs carrying the retargeted HueSatMap (#5099) for a
/// drag from `decoded` to `target`; `None` inside the identity band.
pub fn wb_hsm_inputs<'a>(
    view: wb_camera::HsmRetargetView<'_>,
    tables: raw_gpu::WbHsmTables<'a>,
    frame: &wb_camera::SliderFrameExport,
    slider: ((f32, f32), (f32, f32)),
) -> Option<raw_gpu::WbHsmInputs<'a>> {
    let (target, decoded) = slider;
    let d = view.live_delta(frame, target, decoded)?;
    Some(raw_gpu::WbHsmInputs {
        dims: view.dims,
        srgb: view.encoding == crate::color::hsm::HsmEncoding::Srgb,
        tables,
        to_pro: d.to_pro.0,
        delta_pro: d.delta_pro.0,
        from_pro: d.from_pro.0,
        w_target: d.w_target,
        w_anchor: d.w_anchor,
    })
}

impl GpuWhiteBalance {
    /// Camera-anchored values in the current slider scale, including imported
    /// legacy-pair conversion. Hosts use these when first displaying the sliders.
    pub fn slider_values(&self, model: &AdjustmentModel) -> (f32, f32) {
        if let Some((profile, frame, _)) = &self.calibration {
            wb_camera::resolve_target_versioned(model, frame, profile, self.as_shot_neutral)
        } else {
            white_balance::resolve_wb(model)
        }
    }

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
        let hsm = calibration
            .as_ref()
            .and_then(|(profile, _, _)| wb_camera::WbHsmRetarget::resolve(profile))
            .map(|hsm| {
                let tables = std::sync::Arc::from(hsm.view().tables);
                (hsm, tables)
            });
        Ok(Self {
            calibration,
            hsm,
            as_shot_neutral: raw.as_shot_neutral,
        })
    }

    pub fn apply(&self, model: &AdjustmentModel, inputs: &mut raw_gpu::FullChainInputs<'_>) {
        if let Some((_, _, export)) = &self.calibration {
            let target = self.slider_values(model);
            let anchor = (export.scene_cct, export.as_shot_tint);
            inputs.wb_matrix = export.rec2020_delta_matrix(target, anchor).0;
            inputs.wb_hsm = self.hsm.as_ref().and_then(|(hsm, tables)| {
                wb_hsm_inputs(
                    hsm.view(),
                    raw_gpu::WbHsmTables::Shared(tables.clone()),
                    export,
                    (target, anchor),
                )
            });
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
            inputs.wb_hsm = None;
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

    /// #5099: on a dual-HueSatMap ForwardMatrix body the cached binding hands
    /// the WB pass the shared endpoint tables (no per-tick copy) and the
    /// same per-tick constants the CPU chain derives; inside the identity
    /// band it hands none.
    #[test]
    #[cfg_attr(
        not(feature = "fixtures"),
        ignore = "needs test-fixtures/raws (fixtures feature)"
    )]
    fn cached_binding_carries_the_retargeted_hue_sat_map_test_0007() {
        let path = crate::test_support::fixtures::require_raw("test_0007.DNG");
        let raw = crate::decode::decode(&path).unwrap();
        let cached = GpuWhiteBalance::resolve(&raw).unwrap();
        let profile = dcp::profile_for(&raw).unwrap();
        let export = wb_camera::SliderFrameExport::resolve(&raw, &profile);
        let hsm = wb_camera::WbHsmRetarget::resolve(&profile).expect("dual HSM + FM");
        let anchor = (export.scene_cct, export.as_shot_tint);
        let inputs_for = |temperature: f32, tint: f32| {
            let model = AdjustmentModel {
                temperature,
                tint,
                temperature_seen: true,
                tint_seen: true,
                ..AdjustmentModel::default()
            };
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
            (model, inputs)
        };

        let (model, inputs) = inputs_for(2850.0, 0.0);
        let target = cached.slider_values(&model);
        let live = inputs
            .wb_hsm
            .as_ref()
            .expect("a drag carries the HueSatMap");
        let delta = hsm.view().live_delta(&export, target, anchor).unwrap();
        assert_eq!(live.tables.as_slice(), hsm.view().tables);
        assert_eq!(
            (live.w_target, live.w_anchor),
            (delta.w_target, delta.w_anchor)
        );
        assert_eq!(live.delta_pro, delta.delta_pro.0);
        let (_, again) = inputs_for(2850.0, 0.0);
        assert_eq!(
            again.wb_hsm.unwrap().tables.as_slice().as_ptr(),
            live.tables.as_slice().as_ptr(),
            "every tick shares one table allocation"
        );

        let (_, at_anchor) = inputs_for(anchor.0, anchor.1);
        assert!(at_anchor.wb_hsm.is_none());
    }
}
