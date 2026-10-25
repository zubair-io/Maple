//! The tile chain's colour segment: the clipped camera crop in, the
//! auto-exposed, white-balanced scene out, through the capture-first split
//! (#5213).

use super::region::TileWindow;
use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::Result,
    image::{Image, RawImage},
    pipeline::capture_first::{self, Chain, CreativeAnchors, CreativeStage, Site},
    stages::wb_camera,
    xmp::AdjustmentModel,
};

pub(super) struct TileColour<'a> {
    pub raw: &'a RawImage,
    pub model: &'a AdjustmentModel,
    pub profile: DcpProfile,
    pub profile_source: dcp::ProfileSource,
    /// See `develop_scene_linear_from_padded_mosaic`.
    pub decoded_wb_anchor: Option<(f32, f32)>,
    /// See `develop_scene_linear_from_padded_mosaic`.
    pub ae_gain: f32,
    pub window: TileWindow,
    pub cancel: CancelToken<'a>,
}

/// The tile's capture result in the fixed as-shot basis (#5377): the half of
/// [`develop_colour`] a host's per-tick creative stage does not run.
pub(super) fn capture_colour(
    camera_rgb: Image,
    profile: &DcpProfile,
    model: &AdjustmentModel,
    window: TileWindow,
    cancel: CancelToken<'_>,
) -> Result<Image> {
    let site = Site::Window {
        origin: window.origin,
        full: window.full,
    };
    capture_first::capture_in_basis(camera_rgb, profile, model, site, Chain::Tile, cancel)
}

pub(super) fn develop_colour(camera_rgb: Image, input: TileColour<'_>) -> Result<Image> {
    let TileColour {
        raw,
        model,
        profile,
        profile_source,
        decoded_wb_anchor,
        ae_gain,
        window,
        cancel,
    } = input;
    // LinearRaw never reaches a tile, so the fallback tier is the only one
    // without a calibrated frame.
    let frame = (!matches!(profile_source, dcp::ProfileSource::RawlerFallback))
        .then(|| wb_camera::SliderFrame::resolve(raw, &profile));
    let site = Site::Window {
        origin: window.origin,
        full: window.full,
    };
    let (capture, space) =
        capture_first::capture(camera_rgb, &profile, model, site, Chain::Tile, cancel)?;
    let creative = CreativeStage {
        profile,
        frame,
        as_shot_neutral: raw.as_shot_neutral,
        anchors: CreativeAnchors::Given {
            ae_gain,
            decoded_wb: decoded_wb_anchor,
        },
    };
    Ok(creative.render(capture, space, model, Chain::Tile)?.0)
}
