//! Fixed linear-calibration seam qualification (#3955, part of #1472).
//!
//! These entries deliberately do not consume saved removal records: the older
//! post-DCP experiments are a different plate and cannot be reinterpreted.
//! Authoring remains disabled until bounded contexts, upstream repair, all
//! rendering consumers, CPU/GPU parity and hardware budgets qualify.

use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::{Error, Result},
    image::{ColorSpace, Image, RawImage},
    math::Matrix3,
    stages::inpaint_composite,
    types::InpaintPatch,
    xmp::{AdjustmentModel, LensProfileEnable},
};

use super::{develop, removal_context::anchor_model, RenderQuality};

fn invalid(reason: &str) -> Error {
    Error::Pipeline(format!("removal linear calibration: {reason}"))
}

fn matrices(profile: &DcpProfile) -> Result<(Matrix3, Matrix3)> {
    let to_scene = dcp::camera_to_rec2020_matrix(profile)?;
    if !to_scene.0.iter().flatten().all(|value| value.is_finite()) {
        return Err(invalid("non-finite calibration"));
    }
    let to_camera = to_scene
        .inverse()
        .filter(|matrix| matrix.0.iter().flatten().all(|value| value.is_finite()))
        .ok_or_else(|| invalid("calibration cannot be inverted"))?;
    Ok((to_scene, to_camera))
}

/// Native, un-oriented DefaultCrop plate for the linear-calibration experiment.
/// This retains signed/HDR Rec.2020 values; HSM and DCP's soft-floor are NOT
/// inverted or applied here. The actual camera As-Shot pre-gain and calibration
/// dispatch are shared with normal development.
///
/// Whole-frame qualification entry, not a bounded 100MP authoring input.
/// Model encoding must be requalified for this plate before accepting patches.
pub fn render_removal_calibration_plate(raw: &RawImage, cancel: CancelToken<'_>) -> Result<Image> {
    let (mut camera, _) =
        develop::camera::prepare(raw, &anchor_model(), RenderQuality::Amaze, cancel)?;
    calibrate(&mut camera, raw, cancel)?;
    Ok(camera)
}

/// Bounded native context in un-oriented DefaultCrop coordinates, using the
/// same linear calibration as the whole-frame qualification plate. Bayer only;
/// unsupported tile formats fail explicitly. Current probe cap is 1024×1024,
/// not a shipping model/context policy. No full-resolution RGB plate is allocated.
pub fn render_removal_calibration_context(
    raw: &RawImage,
    window: crate::types::accepted_removal::NativeWindow,
    cancel: CancelToken<'_>,
) -> Result<Image> {
    let mut camera = super::tile::render_removal_camera_context(raw, window, cancel)?;
    calibrate(&mut camera, raw, cancel)?;
    Ok(camera)
}

fn calibrate(camera: &mut Image, raw: &RawImage, cancel: CancelToken<'_>) -> Result<()> {
    let profile = dcp::profile_for(raw)?;
    let (to_scene, _) = matrices(&profile)?;
    for (index, pixel) in camera.pixels.iter_mut().enumerate() {
        if index % 4096 == 0 && cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        *pixel = to_scene.mul_vec(*pixel);
        if !pixel.iter().all(|value| value.is_finite()) {
            return Err(invalid("calibrated source overflows"));
        }
    }
    camera.space = ColorSpace::SceneLinearRec2020;
    Ok(())
}

/// Run native full development with patches made from the above plate.
/// Empty stacks route through the existing unrestricted entry exactly.
/// Active stacks currently require the experiment's fixed upstream settings;
/// refusing mismatches prevents silently moving a patch onto a different plate.
/// This is not yet the saved-record or live-slider integration (#3955).
pub fn develop_removal_calibration_patches(
    raw: &RawImage,
    model: &AdjustmentModel,
    patches: &[InpaintPatch],
    cancel: CancelToken<'_>,
) -> Result<Image> {
    if !patches.is_empty() {
        let anchor = anchor_model();
        if model.lens_profile_enable != LensProfileEnable::Off
            || model.hot_pixel_suppression != anchor.hot_pixel_suppression
            || model.demosaic != anchor.demosaic
            || model.auto_lateral_ca != anchor.auto_lateral_ca
            || model.highlight_recovery != anchor.highlight_recovery
            || !model.retouch_spots.is_empty()
        {
            return Err(invalid("upstream settings or clone/heal are not qualified"));
        }
        for patch in patches {
            patch.validate().map_err(|reason| invalid(&reason))?;
        }
    }
    develop::develop_with_calibration_patches(raw, model, RenderQuality::Amaze, cancel, patches)
        .map(|(scene, _gain)| scene)
}

/// Preserve untouched camera samples; transform only coverage-supported patch
/// RGB. Validation precedes every write, including a later invalid operation.
pub(super) fn composite_camera(
    camera: &mut Image,
    patches: &[InpaintPatch],
    profile: &DcpProfile,
) -> Result<()> {
    let (_, to_camera) = matrices(profile)?;
    for patch in patches {
        patch.validate().map_err(|reason| invalid(&reason))?;
        // Bounded f32 arithmetic must remain finite in both the interpolation
        // and transport. A sum of absolute terms bounds every bilinear sample.
        for pixel in &patch.pixels {
            if pixel.iter().any(|value| value.abs() > f32::MAX / 4.0)
                || !to_camera.0.iter().all(|row| {
                    row.iter()
                        .zip(pixel)
                        .map(|(coefficient, value)| {
                            f64::from(*coefficient).abs() * f64::from(*value).abs()
                        })
                        .sum::<f64>()
                        <= f64::from(f32::MAX) / 4.0
                })
            {
                return Err(invalid("patch transport overflows camera RGB"));
            }
        }
    }
    inpaint_composite::apply_camera_patches(camera, patches, to_camera);
    Ok(())
}

#[cfg(test)]
#[path = "removal_calibration_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "removal_calibration_context_tests.rs"]
mod context_tests;
