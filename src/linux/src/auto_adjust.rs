//! Apply the shared estimator's recommendation as one canonical model snapshot.
use crate::controls::Control;
use raw_core::{
    stages::auto_adjustments::{AutoAdjustments, AUTO_WB_ALGORITHM_VERSION},
    types::adjustment::{AdjustmentModel, AutoExposureMode, WbScaleVersion, WbSource},
};

pub fn apply(model: &AdjustmentModel, result: AutoAdjustments) -> Result<AdjustmentModel, String> {
    let mut edited = model.clone();
    for (control, value) in [
        (Control::Exposure, result.exposure),
        (Control::Contrast, result.contrast),
        (Control::Highlights, result.highlights),
        (Control::Shadows, result.shadows),
        (Control::Whites, result.whites),
        (Control::Blacks, result.blacks),
        (Control::Temperature, result.temperature),
        (Control::Tint, result.tint),
    ] {
        if !value.is_finite() {
            return Err("AUTO returned a non-finite recommendation".into());
        }
        let (min, max) = control.spec().range;
        control.set(&mut edited, value.clamp(min, max))?;
    }
    edited.auto_exposure = AutoExposureMode::Off;
    edited.wb_scale_version = WbScaleVersion::V5;
    edited.wb_source = WbSource::Auto;
    edited.wb_algorithm_version = AUTO_WB_ALGORITHM_VERSION as f32;
    Ok(edited)
}
