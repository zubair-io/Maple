//! The colour segment full and sized develop share: the profile-ready
//! camera buffer in, the auto-exposed, white-balanced scene out, through the
//! capture-first split (#5213).

use crate::{
    cancel::CancelToken,
    color::dcp::{self, DcpProfile},
    error::Result,
    image::{Image, RawImage},
    pipeline::{
        capture_first::{self, CaptureBase, Chain, CreativeAnchors, CreativeStage, Site},
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

/// The profile-ready camera buffer the shared prefix of full and sized
/// develop produces, and what the colour segment needs from it.
pub(crate) struct CameraReady {
    pub camera_rgb: Image,
    pub profile: DcpProfile,
    pub profile_source: dcp::ProfileSource,
    pub skip_pre_gain: bool,
    pub whites_anchor_ev: f32,
}

impl CameraReady {
    pub(crate) fn colour<'a>(
        self,
        raw: &'a RawImage,
        model: &'a AdjustmentModel,
        chain: Chain,
        cancel: CancelToken<'a>,
    ) -> (Image, ColourInput<'a>) {
        (
            self.camera_rgb,
            ColourInput {
                raw,
                model,
                profile: self.profile,
                profile_source: self.profile_source,
                skip_pre_gain: self.skip_pre_gain,
                whites_anchor_ev: self.whites_anchor_ev,
                chain,
                cancel,
            },
        )
    }
}

/// Returns the scene and the auto-exposure gain applied to it.
pub(crate) fn develop_colour(camera_rgb: Image, input: ColourInput<'_>) -> Result<(Image, f32)> {
    let (creative, rest) = creative_of(input);
    let (capture, space) = capture_first::capture(
        camera_rgb,
        &creative.profile,
        rest.model,
        Site::Frame,
        rest.chain,
        rest.cancel,
    )?;
    let (mut scene, ae_gain) = creative.render(capture, space, rest.model, rest.chain)?;
    scene.whites_anchor_ev = Some(rest.whites_anchor_ev);
    dump_after("06_white_balance", &scene);
    Ok((scene, ae_gain))
}

/// The capture-first decode product (#5377): the capture in the fixed
/// as-shot basis, and the creative stage that renders it with the exposure
/// gain [`develop_colour`] would apply.
pub(crate) fn capture_colour(
    camera_rgb: Image,
    input: ColourInput<'_>,
) -> Result<(Image, CreativeStage)> {
    let (creative, rest) = creative_of(input);
    let (mut capture, creative) =
        capture_first::export_capture(camera_rgb, creative, rest.model, rest.chain, rest.cancel)?;
    capture.whites_anchor_ev = Some(rest.whites_anchor_ev);
    Ok((capture, creative))
}

/// The capture decode's refine base (#5381): the as-shot basis after
/// retouch, developed at `input.model` and compared against `loaded`.
pub(crate) fn capture_base(
    camera_rgb: Image,
    input: ColourInput<'_>,
    loaded: &AdjustmentModel,
) -> Result<CaptureBase> {
    let orientation = input.raw.orientation;
    let (creative, rest) = creative_of(input);
    let mut base = CaptureBase::develop(
        camera_rgb,
        creative,
        (loaded, rest.model),
        rest.chain,
        rest.cancel,
    )?;
    base.image.whites_anchor_ev = Some(rest.whites_anchor_ev);
    base.orientation = orientation;
    Ok(base)
}

struct Rest<'a> {
    model: &'a AdjustmentModel,
    whites_anchor_ev: f32,
    chain: Chain,
    cancel: CancelToken<'a>,
}

fn creative_of(input: ColourInput<'_>) -> (CreativeStage, Rest<'_>) {
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
    (
        CreativeStage {
            profile,
            frame,
            as_shot_neutral: raw.as_shot_neutral,
            anchors: CreativeAnchors::Measure,
        },
        Rest {
            model,
            whites_anchor_ev,
            chain,
            cancel,
        },
    )
}
