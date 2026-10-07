//! Camera-aware UI values, resolved exclusively through raw-core (#4317).
use crate::controls::Control;
use raw_core::{
    color::dcp::{self, DcpProfile, ProfileSource},
    stages::{
        wb_camera::{self, SliderFrame},
        white_balance,
    },
    types::adjustment::{AdjustmentModel, WbScaleVersion},
    RawImage,
};

pub enum WhiteBalance {
    Camera(Box<CameraReference>),
    Display,
}
pub struct CameraReference {
    frame: SliderFrame,
    profile: DcpProfile,
    neutral: [f32; 3],
}
impl WhiteBalance {
    pub fn from_raw(raw: &RawImage) -> Result<Self, String> {
        let (profile, source) = dcp::profile_for_with_source(raw).map_err(|e| e.to_string())?;
        // Match the develop entry's camera-space versus post-DCP WB dispatch.
        let baked =
            matches!(raw.cfa, raw_core::image::CfaPattern::LinearRgb) && raw.white_level <= 255;
        if baked || matches!(source, ProfileSource::RawlerFallback) {
            return Ok(Self::Display);
        }
        Ok(Self::Camera(Box::new(CameraReference {
            frame: SliderFrame::resolve(raw, &profile),
            profile,
            neutral: raw.as_shot_neutral,
        })))
    }

    pub fn values(&self, model: &AdjustmentModel) -> (f32, f32) {
        match self {
            Self::Camera(reference) => wb_camera::resolve_target_versioned(
                model,
                &reference.frame,
                &reference.profile,
                reference.neutral,
            ),
            Self::Display => white_balance::resolve_wb(model),
        }
    }

    pub fn edit(
        &self,
        model: &mut AdjustmentModel,
        control: Control,
        value: f32,
    ) -> Result<(), String> {
        if !matches!(control, Control::Temperature | Control::Tint) {
            return Err("Expected a white-balance control".into());
        }
        let (temperature, tint) = self.values(model);
        if !temperature.is_finite() || !tint.is_finite() {
            return Err("The source has no finite white-balance reference".into());
        }
        // Convert the pair together only when the user authors a WB edit. Merely
        // opening, rendering or changing exposure must retain imported provenance.
        let mut edited = model.clone();
        edited.temperature = temperature;
        edited.tint = tint;
        edited.wb_scale_version = WbScaleVersion::V5;
        control.set(&mut edited, value)?;
        *model = edited;
        Ok(())
    }
}
