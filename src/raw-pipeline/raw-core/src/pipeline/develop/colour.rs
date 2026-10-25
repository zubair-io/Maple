//! The colour segment full and sized develop share: the profile-ready
//! camera buffer in, the auto-exposed, white-balanced scene out, through the
//! capture-first split (#5213).

use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::Result,
    image::{Image, RawImage},
    pipeline::{
        capture_first::{self, Chain, CreativeAnchors, CreativeStage, Site},
        dump_after,
    },
    stages::wb_camera,
    xmp::AdjustmentModel,
};

pub(crate) struct ColourInput<'a> {
    pub raw: &'a RawImage,
    pub model: &'a AdjustmentModel,
    pub profile: DcpProfile,
    pub profile_source: dcp::ProfileSource,
    /// 8-bit lossy LinearRaw, whose WB stays baked (see `develop`).
    pub skip_pre_gain: bool,
    pub whites_anchor_ev: f32,
    pub chain: Chain,
    pub cancel: CancelToken<'a>,
}

/// Returns the scene and the auto-exposure gain applied to it.
pub(crate) fn develop_colour(camera_rgb: Image, input: ColourInput<'_>) -> Result<(Image, f32)> {
    let ColourInput {
        raw,
        model,
        profile,
        profile_source,
        skip_pre_gain,
        whites_anchor_ev,
        chain,
        cancel,
    } = input;
    let calibrated =
        !skip_pre_gain && !matches!(profile_source, dcp::ProfileSource::RawlerFallback);
    let frame = calibrated.then(|| wb_camera::SliderFrame::resolve(raw, &profile));
    let (capture, space) =
        capture_first::capture(camera_rgb, &profile, model, Site::Frame, chain, cancel)?;
    let creative = CreativeStage {
        profile,
        frame,
        as_shot_neutral: raw.as_shot_neutral,
        anchors: CreativeAnchors::Measure,
    };
    let (mut scene, ae_gain) = creative.render(capture, space, model, chain)?;
    scene.whites_anchor_ev = Some(whites_anchor_ev);
    dump_after("06_white_balance", &scene);
    Ok((scene, ae_gain))
}
