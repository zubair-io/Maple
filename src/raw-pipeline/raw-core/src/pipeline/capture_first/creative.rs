//! The creative half of the capture-first order (#5213 amendment 1): inverse
//! basis → camera WB → DCP (HueSatMap and LookTable in ProPhoto D50, soft
//! floor) → Oklab highlight recovery at the pre-AE ceiling → auto exposure →
//! the post-DCP CAT16 WB the uncalibrated tiers use.

use super::{basis_inverse, dump, label, transform, Chain};
use crate::pipeline::stage;
use crate::{
    color::dcp::{self, DcpProfile},
    error::Result,
    image::{ColorSpace, Image},
    stages::{
        auto_exposure, highlight_recovery_oklab,
        wb_camera::{self, SliderFrame},
        white_balance,
    },
    xmp::{AdjustmentModel, AutoExposureMode},
};

/// Where a [`super::capture`] result sits.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureSpace {
    /// No capture stage ran: the as-shot camera buffer itself.
    Camera,
    /// The fixed as-shot Rec.2020 basis the capture stages run in.
    Basis,
}

/// How the creative stage anchors white balance and exposure.
#[derive(Clone, Copy)]
pub enum CreativeAnchors {
    /// Full and sized develop: white balance is the model's absolute target
    /// and auto exposure is measured here, on the as-shot render.
    Measure,
    /// Tile and per-tick renders: the host already measured the exposure
    /// gain, and `decoded_wb` (#1725) makes the model's white balance a
    /// delta against the pair the host's buffer was decoded at.
    Given {
        ae_gain: f32,
        decoded_wb: Option<(f32, f32)>,
    },
}

/// Everything the creative stage needs from the RAW.
pub struct CreativeStage {
    /// The as-shot render profile (`dcp::profile_for_with_source`).
    pub profile: DcpProfile,
    /// The calibrated camera-space WB frame, or `None` for the LinearRaw and
    /// `RawlerFallback` tiers, which keep the post-DCP CAT16 path.
    pub frame: Option<SliderFrame>,
    pub as_shot_neutral: [f32; 3],
    pub anchors: CreativeAnchors,
}

impl CreativeStage {
    /// Render a [`super::capture`] result to the post-AE scene the rest of
    /// the chain consumes, returning the auto-exposure gain applied.
    pub(crate) fn render(
        &self,
        capture: Image,
        space: CaptureSpace,
        model: &AdjustmentModel,
        chain: Chain,
    ) -> Result<(Image, f32)> {
        let mut camera = capture;
        if space == CaptureSpace::Basis {
            let inverse = basis_inverse(&dcp::camera_to_rec2020_matrix(&self.profile)?)?;
            stage(label!(chain, "creative_inverse_basis"), || {
                transform(&mut camera, &inverse)
            });
            camera.space = ColorSpace::CameraNativeLinearRgb;
        }
        let decoded_wb = match self.anchors {
            CreativeAnchors::Measure => None,
            CreativeAnchors::Given { decoded_wb, .. } => decoded_wb,
        };
        let target = self.frame.as_ref().map(|frame| match decoded_wb {
            Some(_) => (model.temperature, model.tint),
            None => wb_camera::resolve_target_versioned(
                model,
                frame,
                &self.profile,
                self.as_shot_neutral,
            ),
        });
        let as_shot_gain = match (self.anchors, &self.frame, target) {
            (CreativeAnchors::Measure, Some(frame), Some((temperature, tint)))
                if model.auto_exposure == AutoExposureMode::On
                    && !wb_camera::is_as_shot_target(frame, temperature, tint) =>
            {
                Some(stage(label!(chain, "creative_as_shot_anchor"), || {
                    as_shot_anchor_gain(&camera, &self.profile, model)
                })?)
            }
            _ => None,
        };
        let dcp_profile = match (&self.frame, target) {
            (Some(frame), Some((temperature, tint))) => {
                stage(label!(chain, "creative_wb_camera"), || match decoded_wb {
                    Some(decoded) => wb_camera::apply_delta(
                        &mut camera,
                        frame,
                        self.as_shot_neutral,
                        (temperature, tint),
                        decoded,
                    ),
                    None => wb_camera::apply(
                        &mut camera,
                        frame,
                        self.as_shot_neutral,
                        temperature,
                        tint,
                    ),
                });
                wb_camera::retargeted_render_profile(frame, self.profile.clone(), temperature, tint)
            }
            _ => self.profile.clone(),
        };
        dump(chain, "02b_wb_camera", &camera);
        let mut scene = stage(label!(chain, "creative_dcp_apply"), || {
            dcp::apply_colorimetry(&camera, &dcp_profile)
        })?;
        drop(camera);
        dump(chain, "03_dcp_apply", &scene);
        stage(label!(chain, "creative_highlight_recovery_oklab"), || {
            highlight_recovery_oklab::apply_post_dcp(&mut scene, model.highlight_recovery)
        });
        dump(chain, "03b_oklab_highlight_recovery", &scene);
        let ae_gain = match self.anchors {
            CreativeAnchors::Given { ae_gain, .. } => ae_gain,
            CreativeAnchors::Measure => match model.auto_exposure {
                AutoExposureMode::Off => 1.0,
                AutoExposureMode::On => {
                    as_shot_gain.unwrap_or_else(|| auto_exposure::compute_scene_anchor_gain(&scene))
                }
            },
        };
        stage(label!(chain, "creative_auto_exposure"), || {
            auto_exposure::apply_gain(&mut scene, ae_gain)
        });
        dump(chain, "05_auto_exposure", &scene);
        if self.frame.is_none() {
            stage(
                label!(chain, "creative_white_balance"),
                || match decoded_wb {
                    Some((decoded_temperature, decoded_tint)) => white_balance::apply_delta(
                        &mut scene,
                        model.temperature,
                        model.tint,
                        decoded_temperature,
                        decoded_tint,
                        model.wb_method,
                    ),
                    None => {
                        let (temperature, tint) = white_balance::resolve_wb(model);
                        white_balance::apply(&mut scene, temperature, tint, model.wb_method)
                    }
                },
            );
        }
        Ok((scene, ae_gain))
    }
}

/// The auto-exposure anchor of the as-shot render of `camera` (owner decision
/// 5 on #5213), measured without materialising that render: rows go through
/// the as-shot DCP and Oklab recovery a slab at a time and only their luma is
/// kept, which is the list `compute_scene_anchor_gain` would rank.
fn as_shot_anchor_gain(
    camera: &Image,
    profile: &DcpProfile,
    model: &AdjustmentModel,
) -> Result<f32> {
    const SLAB_PIXELS: usize = 1 << 20;
    let width = camera.width as usize;
    let rows = (SLAB_PIXELS / width.max(1)).max(1);
    // Filled slab by slab so only one rendered slab is ever alive.
    let mut luma = Vec::with_capacity(camera.pixels.len());
    for slab in camera.pixels.chunks(rows * width.max(1)) {
        let camera_slab = Image {
            width: camera.width,
            height: (slab.len() / width.max(1)) as u32,
            pixels: slab.to_vec(),
            space: ColorSpace::CameraNativeLinearRgb,
            whites_anchor_ev: None,
            nr_sampling_scale: camera.nr_sampling_scale,
        };
        let mut rendered = dcp::apply_colorimetry(&camera_slab, profile)?;
        highlight_recovery_oklab::apply_post_dcp(&mut rendered, model.highlight_recovery);
        luma.extend(
            rendered
                .pixels
                .iter()
                .map(|&p| auto_exposure::scene_luma(p)),
        );
    }
    Ok(auto_exposure::anchor_gain_from_luma(luma))
}
