//! The capture base (#5381): the input of the GPU-refinable capture stages,
//! kept beside a capture decode so a change to chroma prefilter, BM3D or
//! capture sharpening re-runs only those stages (on the GPU, raw-gpu's
//! capture passes) instead of re-developing the RAW. Retouch runs before
//! them and stays on the CPU, so a retouch edit still re-develops.
//!
//! The buffer is the as-shot basis after retouch, in the sensor frame: the
//! stages run there on the CPU too, so a BM3D patch grid and every stencil
//! see the same pixels whatever the EXIF orientation.

use super::creative::as_shot_anchor_gain;
use super::{
    basis_inverse, capture_prefix, capture_spatial, label, Chain, CreativeAnchors, CreativeStage,
    Site,
};
use crate::{
    cancel::CancelToken,
    color::dcp,
    error::{Error, Result},
    image::{ColorSpace, ExifOrientation, Image},
    pipeline::{capture_sharpening_helper::capture_sharpening_params_from_model, stage},
    stages::capture_sharpening::CaptureSharpeningParams,
    xmp::{AdjustmentModel, AutoExposureMode},
};

/// The input of the refinable capture stages for one decode.
pub struct CaptureBase {
    pub(crate) image: Image,
    pub(crate) creative: CreativeStage,
    /// Applied when a refine is packed for the host, as the decode does.
    pub(crate) orientation: ExifOrientation,
    /// The model as loaded, before the decode's own adjustments (the Auto
    /// Profile exposure override), which a refine is compared against.
    loaded: AdjustmentModel,
    /// The model the decode developed at.
    developed: AdjustmentModel,
}

/// The refinable stages' parameters, at the thresholds the CPU stages
/// early-return on.
#[derive(Clone, Copy, Debug)]
pub struct CaptureRefineStages {
    pub chroma_prefilter: f32,
    pub deep_denoise: f32,
    pub sharpening: Option<CaptureSharpeningParams>,
}

/// `model` with the refinable stages at their defaults.
fn without_refinable(model: &AdjustmentModel) -> AdjustmentModel {
    with_refinable(model, &AdjustmentModel::default())
}

/// `target` with `source`'s refinable stages. The deprecated radius alias
/// travels with the sigma it mirrors.
#[allow(deprecated)]
fn with_refinable(target: &AdjustmentModel, source: &AdjustmentModel) -> AdjustmentModel {
    let capture_sharpening_radius = source.capture_sharpening_radius;
    AdjustmentModel {
        chroma_prefilter: source.chroma_prefilter,
        deep_denoise: source.deep_denoise,
        capture_sharpening_amount: source.capture_sharpening_amount,
        capture_sharpening_sigma: source.capture_sharpening_sigma,
        capture_sharpening_radius,
        ..target.clone()
    }
}

impl CaptureRefineStages {
    pub fn of(model: &AdjustmentModel) -> Self {
        Self {
            chroma_prefilter: model.chroma_prefilter,
            deep_denoise: model.deep_denoise,
            sharpening: capture_sharpening_params_from_model(model),
        }
    }
}

impl CaptureBase {
    /// Develop the base from the profile-ready camera buffer, recording the
    /// frame's Whites anchor and EXIF orientation for every refine of it.
    pub(crate) fn develop(
        camera: Image,
        creative: CreativeStage,
        (loaded, developed): (&AdjustmentModel, &AdjustmentModel),
        (orientation, whites_anchor_ev): (ExifOrientation, f32),
        (chain, cancel): (Chain, CancelToken<'_>),
    ) -> Result<Self> {
        let image = capture_prefix(
            camera,
            &creative.profile,
            developed,
            Site::Frame,
            chain,
            cancel,
        )?;
        Ok(Self {
            image: Image {
                whites_anchor_ev: Some(whites_anchor_ev),
                ..image
            },
            creative,
            orientation,
            loaded: loaded.clone(),
            developed: developed.clone(),
        })
    }

    /// Sensor-frame dimensions of the base (before EXIF orientation).
    pub fn dims(&self) -> (u32, u32) {
        (self.image.width, self.image.height)
    }

    /// The base as interleaved RGBA f32 (alpha 1), the GPU passes' input.
    pub fn rgba(&self) -> Vec<f32> {
        self.image
            .pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 1.0])
            .collect()
    }

    /// The model a refine to `loaded` develops at, or `None` when `loaded`
    /// differs from this base's model in anything but the refinable stages
    /// (a retouch, profile or exposure-mode change needs a fresh decode).
    pub fn refine_model(&self, loaded: &AdjustmentModel) -> Option<AdjustmentModel> {
        (without_refinable(loaded) == without_refinable(&self.loaded))
            .then(|| with_refinable(&self.developed, loaded))
    }

    /// Run the refinable stages on the CPU, as the capture decode does.
    pub(crate) fn refine_cpu(
        &self,
        model: &AdjustmentModel,
        chain: Chain,
        cancel: CancelToken<'_>,
    ) -> Result<Image> {
        let mut capture = self.image.clone();
        capture_spatial(&mut capture, model, chain, cancel)?;
        Ok(capture)
    }

    /// A refined RGBA buffer (the GPU passes' output) as a capture image.
    pub fn image_from_rgba(&self, rgba: &[f32]) -> Result<Image> {
        if rgba.len() != self.image.pixels.len() * 4 {
            return Err(Error::Pipeline(format!(
                "capture refine: {} lanes for a {}x{} base",
                rgba.len(),
                self.image.width,
                self.image.height
            )));
        }
        Ok(Image {
            pixels: rgba.chunks_exact(4).map(|p| [p[0], p[1], p[2]]).collect(),
            ..self.image.empty_in_space(ColorSpace::SceneLinearRec2020)
        })
    }

    /// The creative stage for `capture`, a refine of this base at `model`,
    /// with the exposure gain measured on its as-shot render as
    /// `export_capture` measures it.
    pub(crate) fn creative_for(
        &self,
        capture: &Image,
        model: &AdjustmentModel,
        chain: Chain,
    ) -> Result<CreativeStage> {
        let ae_gain = match model.auto_exposure {
            AutoExposureMode::Off => 1.0,
            AutoExposureMode::On => {
                let to_camera =
                    basis_inverse(&dcp::camera_to_rec2020_matrix(&self.creative.profile)?)?;
                stage(label!(chain, "capture_export_anchor"), || {
                    as_shot_anchor_gain(capture, Some(&to_camera), &self.creative.profile, model)
                })?
            }
        };
        Ok(CreativeStage {
            profile: self.creative.profile.clone(),
            frame: self.creative.frame,
            as_shot_neutral: self.creative.as_shot_neutral,
            anchors: CreativeAnchors::Given {
                ae_gain,
                decoded_wb: None,
            },
        })
    }
}

#[cfg(test)]
#[path = "tests_base.rs"]
mod tests;
