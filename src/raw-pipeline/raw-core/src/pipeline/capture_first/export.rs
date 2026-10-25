//! The capture-first decode product (#5377): the capture result in the fixed
//! as-shot basis and the creative stage that renders it, so a host runs the
//! creative half per tick instead of re-developing.

use super::creative::as_shot_anchor_gain;
use super::{basis_inverse, capture, label, transform, CaptureSpace, Chain, Site};
use super::{CreativeAnchors, CreativeStage};
use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::Result,
    image::{ColorSpace, Image},
    pipeline::stage,
    xmp::{AdjustmentModel, AutoExposureMode},
};

/// Run the capture stages and move the result into the basis whether or not
/// one engaged: the per-tick creative stage always starts from the basis.
pub(crate) fn capture_in_basis(
    camera: Image,
    profile: &DcpProfile,
    model: &AdjustmentModel,
    site: Site,
    chain: Chain,
    cancel: CancelToken<'_>,
) -> Result<Image> {
    let (capture, space) = capture(camera, profile, model, site, chain, cancel)?;
    into_basis(capture, space, profile, chain)
}

fn into_basis(
    mut capture: Image,
    space: CaptureSpace,
    profile: &DcpProfile,
    chain: Chain,
) -> Result<Image> {
    if space == CaptureSpace::Camera {
        let basis = dcp::camera_to_rec2020_matrix(profile)?;
        // The per-tick creative stage inverts the basis; refuse one it cannot.
        basis_inverse(&basis)?;
        stage(label!(chain, "capture_export_basis"), || {
            transform(&mut capture, &basis)
        });
        capture.space = ColorSpace::SceneLinearRec2020;
    }
    Ok(capture)
}

/// The whole-frame decode product: the capture in the basis and `creative`
/// with the exposure gain a full develop of `model` would measure, which is
/// the anchor of the as-shot render (owner decision 5 on #5213). The gain is
/// measured on the camera buffer as the develop measures it, before the move
/// into the basis.
pub(crate) fn export_capture(
    camera: Image,
    creative: CreativeStage,
    model: &AdjustmentModel,
    chain: Chain,
    cancel: CancelToken<'_>,
) -> Result<(Image, CreativeStage)> {
    let (capture, space) = capture(camera, &creative.profile, model, Site::Frame, chain, cancel)?;
    let ae_gain = match model.auto_exposure {
        AutoExposureMode::Off => 1.0,
        AutoExposureMode::On => {
            let to_camera = match space {
                CaptureSpace::Camera => None,
                CaptureSpace::Basis => Some(basis_inverse(&dcp::camera_to_rec2020_matrix(
                    &creative.profile,
                )?)?),
            };
            stage(label!(chain, "capture_export_anchor"), || {
                as_shot_anchor_gain(&capture, to_camera.as_ref(), &creative.profile, model)
            })?
        }
    };
    let capture = into_basis(capture, space, &creative.profile, chain)?;
    Ok((
        capture,
        CreativeStage {
            anchors: CreativeAnchors::Given {
                ae_gain,
                decoded_wb: None,
            },
            ..creative
        },
    ))
}
