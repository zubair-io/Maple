//! Source-framed SDR input for selection models (#3934 / #3942 / #1472).
//! Reconstruction continues to use native signed/HDR calibration context.
use crate::{
    image::{apply_orientation, ExifOrientation, RawImage},
    pipeline::{RawInput, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::{AdjustmentModel, AutoExposureMode, LensProfileEnable},
};

pub fn render_removal_selection_proxy(
    raw: &RawImage,
    original: &ContentDigest,
    input: Option<RawInput<'_>>,
    stack: Option<&ResolvedCalibrationRemovals>,
    removals: &[crate::types::Removal],
) -> crate::Result<(u32, u32, Vec<u8>)> {
    if stack.is_some_and(|stack| !stack.matches_records(removals)) {
        return Err(crate::Error::Pipeline(
            "selection proxy's saved stack changed".into(),
        ));
    }
    // A fixed As-Shot view excludes creative geometry and optical warps so
    // detector boxes and SAM prompts refer to the durable source coordinates.
    // Auto remains the default view, including its shared embedded-JPEG fit.
    let model = AdjustmentModel {
        inpaint_removals: removals.to_vec(),
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        lens_profile_enable: LensProfileEnable::Off,
        ..Default::default()
    };
    let (width, height, rgb) = if model.inpaint_removals.is_empty() {
        super::render_sized_from_raw_with_quality_and_source(
            raw,
            &model,
            RenderQuality::Auto,
            input,
            1024,
        )
    } else {
        stack
            .ok_or_else(|| {
                crate::Error::Pipeline("saved removals have not been prepared for selection".into())
            })?
            .render_display(
                raw,
                original,
                &model,
                RenderQuality::Auto,
                input,
                Some(1024),
                None,
            )
    }?;
    let inverse = match raw.orientation {
        ExifOrientation::Rotate90 => ExifOrientation::Rotate270,
        ExifOrientation::Rotate270 => ExifOrientation::Rotate90,
        other => other,
    };
    let (width, height, rgb) = if inverse == ExifOrientation::Normal {
        (width, height, rgb)
    } else {
        apply_orientation(&rgb, width, height, inverse)
    };
    Ok((width, height, rgb))
}
