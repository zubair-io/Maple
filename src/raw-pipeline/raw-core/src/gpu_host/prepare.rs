//! Shared RAW preparation for native and browser GPU sessions (#4317).
//! The prefix, AE probe and Auto fit are the existing browser implementation.
use super::model::{build_full_chain_inputs, stripped_prefix_model, NoiseProfileInputs};
use crate::pipeline::{
    develop_scene_linear_sized_from_raw_with_quality_cancellable, fit_auto_profile_from_raw,
    RawInput, RenderQuality,
};
use crate::types::adjustment::{AutoExposureMode, Profile};
use crate::view::auto_profile;
use crate::xmp::AdjustmentModel;
use raw_gpu::FullChainInputs;

/// Mirror the browser CPU renderer's `auto_will_fit` probe: Auto Profile will fit
/// for this RAW iff `Profile::Auto` AND (the shared `auto_profile::cache` already
/// holds a curve/LUT for these bytes OR an embedded preview is extractable). The
/// probe drives the develop's effective `auto_exposure` mode, so it MUST match
/// the CPU render's gate byte-for-byte — see the module docs on why the fit
/// RESULT is not a sound substitute.
pub fn auto_will_fit(model: &AdjustmentModel, bytes: &[u8], ext: &str) -> bool {
    if model.profile != Profile::Auto {
        return false;
    }
    // `RenderQuality::Amaze` — the quality THIS path's fit runs at (see
    // `fit_profile_artifacts_with_status`), matching browser CPU render/export
    // and the live session prefix develop (#4092).
    let key = auto_profile::cache::CacheKey::from_bytes(bytes, RenderQuality::Amaze);
    auto_profile::cache::get(&key).is_some()
        || auto_profile::cache::get_lut(&key).is_some()
        || auto_profile::preview::extract_preview_from_bytes(bytes, ext).is_some()
}

/// The effective auto-exposure mode the stripped-prefix develop must use — the
/// SAME one the CPU render uses (`auto_will_fit` → Off when Auto Profile fits,
/// else the model's mode). Pulled out so the one-shot GPU renderer and the persistent
/// browser/native live sessions derive the prefix model identically.
pub fn effective_ae_mode(model: &AdjustmentModel, raw: &[u8], ext: &str) -> AutoExposureMode {
    if auto_will_fit(model, raw, ext) {
        AutoExposureMode::Off
    } else {
        model.auto_exposure
    }
}

/// Derive the stripped-prefix model for `model` WITHOUT developing — the cheap
/// change-detector the persistent browser/native live sessions uses
/// to decide whether a render must re-develop + re-upload. Equal to the
/// `prefix_model` [`develop_prefix_rgba`] returns (BOTH call `effective_ae_mode` +
/// `stripped_prefix_model`, so the equivalence is by construction), making a
/// compare against the cached prefix model the sound re-upload boundary. Pure model
/// arithmetic + the `auto_will_fit` probe (a cache / embedded-JPEG check); no
/// develop, no upload.
///
pub fn prefix_model_for(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> AdjustmentModel {
    let _ = raw_img; // symmetry with develop_prefix_rgba; the probe reads bytes, not the image
    let ae_mode = effective_ae_mode(model, raw, ext);
    stripped_prefix_model(model, ae_mode)
}

/// Develop the STRIPPED PREFIX to the post-`auto_exposure` scene-linear Rec.2020
/// buffer the GPU chain consumes, packed to interleaved RGBA f32 (alpha 1.0) — the
/// upload shape [`LiveSession::new`] expects, with model, white anchor and sampling scale.
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
pub fn develop_prefix_rgba(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    max_long_edge: u32,
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel, f32, f32), String> {
    develop_prefix_rgba_cancellable(
        raw_img,
        raw,
        ext,
        model,
        max_long_edge,
        crate::CancelToken::never(),
    )
}

/// Native preparation shares the worker's cancellation flag with expensive
/// CPU kernels. Never-cancel preserves the browser wrapper's exact pixels.
pub fn develop_prefix_rgba_cancellable(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    max_long_edge: u32,
    cancel: crate::CancelToken<'_>,
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel, f32, f32), String> {
    if cancel.is_cancelled() {
        return Err(crate::Error::Cancelled.to_string());
    }
    let ae_mode = effective_ae_mode(model, raw, ext);
    let prefix_model = stripped_prefix_model(model, ae_mode);
    // AMaZE by default (#940): this develop runs at live-session open and
    // again only when a prefix-affecting field changes (highlight recovery,
    // pins, decode-upstream settings — see `WebLiveSession`'s prefix-model
    // cache); the hot-path sliders re-run GPU stages only and never reach
    // it. With the `parallel` wasm feature + crossOriginIsolated the tiled
    // kernel (#1887) costs the same as bilinear; single-threaded fallbacks
    // pay the serial kernel at the same (open / prefix-change) cadence.
    let scene = develop_scene_linear_sized_from_raw_with_quality_cancellable(
        raw_img,
        &prefix_model,
        RenderQuality::Amaze,
        max_long_edge,
        cancel,
    )
    .map_err(|e| e.to_string())?;
    let whites_anchor_ev = scene
        .whites_anchor_ev
        .ok_or("RAW prefix develop did not produce a Whites anchor")?;
    let (w, h) = (scene.width, scene.height);
    let nr_sampling_scale = scene.nr_sampling_scale;
    // Pack RGB → RGBA; sized develop bounds both resident buffers (#1080).
    let mut rgba: Vec<f32> = Vec::with_capacity(scene.pixels.len() * 4);
    for chunk in scene.pixels.chunks(4096) {
        if cancel.is_cancelled() {
            return Err(crate::Error::Cancelled.to_string());
        }
        for p in chunk {
            rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
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

/// Fit the Auto Profile curve + residual LUT against the embedded JPEG (the SAME
/// entry `apply_auto_profile` shares a cache with — see #924 / #972) and flatten
/// them into the `(profile_curve_flat, residual_lut_size, residual_lut_data)` shape
/// [`build_full_chain_inputs`] consumes, plus the achieved Auto outcome (#4096):
/// `Some(fitted)` for `Profile::Auto`, `None` otherwise. An absent curve or LUT
/// stays ABSENT (empty flat / size-0 LUT) so the chain omits that look pass
/// (#4216), matching raw-core's `if let Some` skips; never substitute identity,
/// whose curve knee crushes white 1.0 → 0.975. The fit is keyed on the RAW BYTES
/// (not the model), so after the first call it is cache-served.
pub fn fit_profile_artifacts_with_status(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> (Vec<f32>, usize, Vec<f32>, Option<bool>) {
    let (curve, lut) = match model.profile {
        // AMaZE develop/export quality (#4092): matches the quality used by
        // browser CPU render/export and the live session prefix develop.
        Profile::Auto => fit_auto_profile_from_raw(
            raw_img,
            model,
            RenderQuality::Amaze,
            RawInput::Bytes { bytes: raw, ext },
        )
        .unwrap_or((None, None)),
        _ => (None, None),
    };
    flatten_profile_artifacts(curve, lut, model.profile)
}

pub(crate) fn flatten_profile_artifacts(
    curve: Option<auto_profile::curve::ProfileCurve>,
    lut: Option<auto_profile::lut::ColorLut>,
    profile: Profile,
) -> (Vec<f32>, usize, Vec<f32>, Option<bool>) {
    let auto_fit = (profile == Profile::Auto).then_some(curve.is_some() || lut.is_some());
    let profile_curve_flat = curve.map(|c| c.to_flat()).unwrap_or_default();
    let (residual_lut_size, residual_lut_data) = lut.map_or((0, Vec::new()), |l| (l.size, l.data));
    (
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        auto_fit,
    )
}

/// Assemble the [`FullChainInputs`] for `model` from the RAW + the (cache-served)
/// Auto Profile fit, with the achieved Auto outcome (#4096). The view-tail-and-WB
/// shape the live chain re-applies every render; cheap (no decode, no GPU
/// compile), so a persistent session rebuilds it from the latest model while
/// reusing the uploaded prefix buffer.
///
/// `film_lut` / `film_lut_key` (epic #2683, Task 9) are the session-resident
/// baked film-look grid + its content-identity key — see
/// [`super::model::build_full_chain_inputs`]'s doc for why they ride alongside the
/// model instead of inside it. One-shot callers with no loaded look pass
/// `(None, 0)`.
pub fn chain_inputs_with_status(
    raw_img: &crate::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    film_lut: Option<&crate::film::FilmLut>,
    film_lut_key: u32,
    whites_anchor_ev: f32,
) -> (FullChainInputs<'static>, Option<bool>) {
    let (profile_curve_flat, residual_lut_size, residual_lut_data, auto_fit) =
        fit_profile_artifacts_with_status(raw_img, raw, ext, model);
    let inputs = build_full_chain_inputs(
        model,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        // The decoded frame's own noise characterisation drives the NR stages'
        // per-pixel modulation on the GPU exactly as it does in `develop`
        // (#1714) — both read `RawImage::{noise_profile, iso}`.
        NoiseProfileInputs {
            profile: raw_img.noise_profile.clone().unwrap_or_default(),
            iso: raw_img.iso,
        },
        film_lut,
        film_lut_key,
        whites_anchor_ev,
    );
    (inputs, auto_fit)
}
