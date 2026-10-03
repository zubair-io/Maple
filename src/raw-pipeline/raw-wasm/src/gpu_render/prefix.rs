//! Retained GPU prefix with complete saved RAW edits (#3955).
use super::{effective_ae_mode, stripped_prefix_model};
use raw_core::{
    cancel::CancelToken,
    pipeline::{
        develop_scene_linear_sized_from_raw_with_quality, RenderQuality,
        ResolvedCalibrationRemovals,
    },
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
pub(crate) fn develop_prefix_rgba_saved(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    original: &ContentDigest,
    model: &AdjustmentModel,
    max_long_edge: u32,
    stack: Option<&ResolvedCalibrationRemovals>,
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel, f32, f32), String> {
    require_prepared_removals(stack, model)?;
    if model.inpaint_removals.is_empty() {
        return develop_prefix_rgba(raw_img, raw, ext, model, max_long_edge);
    }
    let prefix_model = stripped_prefix_model(model, effective_ae_mode(model, raw, ext));
    let (scene, _) = stack
        .ok_or("saved removals have not been prepared")?
        .develop_with_gain(
            raw_img,
            original,
            &prefix_model,
            RenderQuality::Amaze,
            Some(max_long_edge),
            CancelToken::never(),
        )
        .map_err(|e| e.to_string())?;
    pack(scene, prefix_model)
}

/// Develop the STRIPPED PREFIX to the post-`auto_exposure` scene-linear Rec.2020
/// buffer the GPU chain consumes, packed to interleaved RGBA f32 (alpha 1.0) — the
/// upload shape [`LiveSession::new`] expects. Returns `(rgba, w, h, prefix_model, whites_anchor_ev, nr_sampling_scale)`;
/// the returned `prefix_model` is the EXACT model this buffer was developed from
/// (equal to [`prefix_model_for`]), so a caller can cache it and re-develop ONLY
/// when it changes (the persistent session's zero-re-upload boundary — an identical
/// prefix model + an identical `max_long_edge` ⇒ an identical buffer, by
/// construction). The hot-path GPU-rerun sliders are zeroed in the prefix, so they
/// never change it.
///
/// `max_long_edge` (#1080): the develop runs raw-core's SIZED chain — the buffer is
/// fit to the target long edge (aspect preserved, never upscaled) right after
/// demosaic+crop, so every later stage runs on the viewport-sized buffer and the
/// returned `(w, h)` are the SIZED dims the GPU session + canvas adopt. A cap at
/// or above the source long edge is bit-identical to the old full-res develop
/// (raw-core's `downsample_image_area` early-returns), pinned by the
/// `develop_prefix_rgba_uncapped_matches_unsized_develop` test.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn develop_prefix_rgba(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    max_long_edge: u32,
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel, f32, f32), String> {
    require_prepared_removals(None, model)?;
    let ae_mode = effective_ae_mode(model, raw, ext);
    let prefix_model = stripped_prefix_model(model, ae_mode);
    // AMaZE by default (#940): this develop runs at live-session open and
    // again only when a prefix-affecting field changes (highlight recovery,
    // pins, decode-upstream settings — see `WebLiveSession`'s prefix-model
    // cache); the hot-path sliders re-run GPU stages only and never reach
    // it. With the `parallel` wasm feature + crossOriginIsolated the tiled
    // kernel (#1887) costs the same as bilinear; single-threaded fallbacks
    // pay the serial kernel at the same (open / prefix-change) cadence.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw_img,
        &prefix_model,
        RenderQuality::Amaze,
        max_long_edge,
    )
    .map_err(|e| e.to_string())?;
    pack(scene, prefix_model)
}

fn pack(
    scene: raw_core::image::Image,
    prefix_model: AdjustmentModel,
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel, f32, f32), String> {
    let whites_anchor_ev = scene
        .whites_anchor_ev
        .ok_or("RAW prefix develop did not produce a Whites anchor")?;
    let (w, h) = (scene.width, scene.height);
    let nr_sampling_scale = scene.nr_sampling_scale;
    // Pack RGB → RGBA; sized develop bounds both resident buffers (#1080).
    let mut rgba: Vec<f32> = Vec::with_capacity(scene.pixels.len() * 4);
    for p in &scene.pixels {
        rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }
    Ok((
        rgba,
        w,
        h,
        prefix_model,
        whites_anchor_ev,
        nr_sampling_scale,
    ))
}
