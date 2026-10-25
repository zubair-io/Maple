//! The capture-first prefix for hosts that drive `raw_gpu::LiveSession`
//! themselves (#5379): the capture decode in sensor framing, uploaded once,
//! and the creative stage every tick renders it with in place of the
//! white-balance pass. See docs/pipeline.md § "The capture decode".
pub mod refine;

use super::creative::creative_inputs;
use super::model::stripped_prefix_model;
use super::prepare::effective_ae_mode;
use crate::pipeline::{
    intern_creative_tables, render_capture_sized_sensor_framed_f32, CreativeHeader, RenderQuality,
};
use crate::xmp::AdjustmentModel;
use raw_gpu::FullChainInputs;

/// A decode's creative stage as a live session keeps it: the plain-number
/// header and the profile's interned table wire.
#[derive(Clone, Copy, Debug)]
pub struct LiveCreative {
    pub header: CreativeHeader,
    pub tables: &'static [f32],
}

impl LiveCreative {
    /// Point `inputs` at this stage for `model`'s white balance and leave the
    /// white-balance pass at its no-op. Allocates nothing: the plan borrows
    /// the interned tables.
    pub fn apply(
        &self,
        model: &AdjustmentModel,
        inputs: &mut FullChainInputs<'static>,
    ) -> Result<(), String> {
        let plan = self
            .header
            .gpu_plan(self.tables, self.header.tick(model))
            .map_err(|e| e.to_string())?;
        inputs.creative = Some(creative_inputs(&plan));
        inputs.wb_matrix = crate::math::Matrix3::IDENTITY.0;
        inputs.wb_temperature = 6500.0;
        inputs.wb_tint = 0.0;
        inputs.wb_hsm = None;
        Ok(())
    }
}

/// One capture decode, ready to upload.
pub struct CapturePrefix {
    /// Interleaved RGBA f32 in sensor framing, alpha 1.
    pub rgba: Vec<f32>,
    pub width: u32,
    pub height: u32,
    /// The exact stripped model the decode ran with; equal to
    /// [`super::prepare::prefix_model_for`], so a host re-decodes only when it
    /// changes.
    pub prefix_model: AdjustmentModel,
    pub whites_anchor_ev: f32,
    pub nr_sampling_scale: f32,
    pub creative: LiveCreative,
}

/// The capture decode of `model`'s stripped prefix, fit to `max_long_edge`,
/// with the auto-exposure mode the browser CPU render uses (`auto_will_fit`).
pub fn develop_capture_prefix_rgba(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    max_long_edge: u32,
) -> Result<CapturePrefix, String> {
    let prefix_model = stripped_prefix_model(model, effective_ae_mode(model, raw, ext));
    let capture = render_capture_sized_sensor_framed_f32(
        raw_img,
        &prefix_model,
        RenderQuality::Amaze,
        max_long_edge,
        crate::CancelToken::never(),
    )
    .map_err(|e| e.to_string())?;
    Ok(CapturePrefix {
        creative: LiveCreative {
            header: capture.creative,
            tables: intern_creative_tables(capture.tables.floats()),
        },
        rgba: capture.rgba,
        width: capture.width,
        height: capture.height,
        prefix_model,
        whites_anchor_ev: capture.whites_anchor_ev,
        nr_sampling_scale: capture.nr_sampling_scale,
    })
}
