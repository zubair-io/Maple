//! Retained GPU prefix with complete saved RAW edits (#3955).
use super::{develop_capture_prefix_rgba, CapturePrefix};
use raw_core::{
    cancel::CancelToken,
    gpu_host::{capture::LiveCreative, model::stripped_prefix_model, prepare::effective_ae_mode},
    pipeline::{intern_creative_tables, RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    xmp::AdjustmentModel,
};

/// No model run, file read, serialization or digest allocation on a slider tick.
/// The retained session owns the immutable RAW to which preparation was bound.
pub(crate) fn require_prepared_removals(
    stack: Option<&ResolvedCalibrationRemovals>,
    model: &AdjustmentModel,
) -> Result<(), String> {
    if !model.inpaint_removals.is_empty()
        && !stack.is_some_and(|s| s.matches_records(&model.inpaint_removals))
    {
        return Err(
            "saved removal assets are missing or changed; prepare the complete stack".into(),
        );
    }
    Ok(())
}

/// Authoring/stack changes rebuild once; hot sliders reuse the uploaded prefix.
/// An empty stack is exactly [`develop_capture_prefix_rgba`].
pub(crate) fn develop_capture_prefix_rgba_saved(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    original: &ContentDigest,
    model: &AdjustmentModel,
    max_long_edge: u32,
    stack: Option<&ResolvedCalibrationRemovals>,
) -> Result<CapturePrefix, String> {
    require_prepared_removals(stack, model)?;
    if model.inpaint_removals.is_empty() {
        return develop_capture_prefix_rgba(raw_img, raw, ext, model, max_long_edge);
    }
    let prefix_model = stripped_prefix_model(model, effective_ae_mode(model, raw, ext));
    let capture = stack
        .ok_or("saved removals have not been prepared")?
        .render_capture_sized_sensor_framed(
            raw_img,
            original,
            &prefix_model,
            RenderQuality::Amaze,
            max_long_edge,
            CancelToken::never(),
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
