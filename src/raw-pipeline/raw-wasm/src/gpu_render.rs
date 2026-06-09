//! `render_bytes_gpu` — the GPU-resident web live-render entry (epic #925,
//! P4b-web / #1029).
//!
//! The WASM counterpart of [`crate::render_bytes`]: decodes a RAW from bytes and
//! produces the SAME u8 RGB display surface, but routes the scene-linear-subset
//! + view-tail + dither through the merged wgpu+WGSL chain ([`raw_gpu::LiveSession`])
//! instead of `raw-core`'s CPU pipeline. Gated behind `raw-wasm`'s `gpu` feature
//! (off by default; the CPU `render_bytes` + WebGL2 paths remain the fallback —
//! deletion is P5).
//!
//! ## The decode boundary (why two develops, and where the split lands)
//!
//! The GPU chain re-applies `white_balance` → … → `nr_color` + the view tail, so
//! its INPUT must be the post-`auto_exposure` (develop stage 05), pre-`white_balance`
//! (stage 06) scene-linear Rec.2020 buffer. raw-core exposes no such split point,
//! so we obtain it by developing through the EXISTING
//! [`develop_scene_linear_from_raw_with_quality`] with a STRIPPED model: the
//! stages the GPU chain re-runs (WB / tone / vibrance / … / sharpen / nr) are set
//! to their no-op defaults so each `apply` short-circuits BIT-EXACTLY, while the
//! upstream stages the GPU chain does NOT do (`highlight_recovery`,
//! `capture_sharpening`, `profile`, the `auto_exposure` MODE) keep the real
//! model's values. The develop output then IS the post-AE buffer (zero-drift —
//! identical upstream math), and the GPU chain re-applies the real model's WB /
//! tone / … absolutely. `capture_sharpening` is baked in this prefix, so the GPU
//! chain gets `capture_sharpening: None` (the Apple decode-boundary contract).
//!
//! ## auto-exposure decision (the one wholesale-parity risk)
//!
//! [`crate::render_bytes`] forces `auto_exposure: Off` when Auto Profile WILL fit
//! (the `auto_will_fit` probe — a cache hit or an extractable embedded JPEG), so
//! the fitted tail owns the scene→JPEG brightness mapping (#871). The stripped
//! prefix MUST honour the SAME effective AE mode, or brightness diverges
//! wholesale. We mirror the probe exactly ([`auto_will_fit`]) rather than using
//! the fit RESULT, which diverges in the degenerate "extractable preview but the
//! fit returns None" case.

// The decode-boundary + GPU-chain CORE and its helpers are platform-neutral
// (they run on Metal too) and are exercised by the native host parity test, so
// they compile for `wasm32` OR `test`. The `#[wasm_bindgen] async` entry
// (`render_bytes_gpu`) is wasm-only — its macro expansion references
// `wasm_bindgen_futures`, a wasm-only dep.
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, fit_auto_profile_from_raw, RawInput, RenderQuality,
};
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::types::adjustment::{AutoExposureMode, Profile};
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::view::auto_profile;
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::xmp::AdjustmentModel;
#[cfg(any(target_arch = "wasm32", test))]
use raw_gpu::{CurveMode, FullChainInputs, GpuContext, LiveSession, ToneCurveInputs};

#[cfg(target_arch = "wasm32")]
use crate::MapleRender;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Mirror [`crate::render_bytes`]'s `auto_will_fit` probe: Auto Profile will fit
/// for this RAW iff `Profile::Auto` AND (the shared `auto_profile::cache` already
/// holds a curve/LUT for these bytes OR an embedded preview is extractable). The
/// probe drives the develop's effective `auto_exposure` mode, so it MUST match
/// the CPU render's gate byte-for-byte — see the module docs on why the fit
/// RESULT is not a sound substitute.
#[cfg(any(target_arch = "wasm32", test))]
fn auto_will_fit(model: &AdjustmentModel, bytes: &[u8], ext: &str) -> bool {
    if model.profile != Profile::Auto {
        return false;
    }
    let key = auto_profile::cache::CacheKey::from_bytes(bytes);
    auto_profile::cache::get(&key).is_some()
        || auto_profile::cache::get_lut(&key).is_some()
        || auto_profile::preview::extract_preview_from_bytes(bytes, ext).is_some()
}

/// Build the STRIPPED prefix model (see the module docs): the GPU-chain-re-run
/// stages are zeroed to their no-op defaults so develop short-circuits them
/// BIT-EXACTLY, leaving only the upstream stages the GPU chain does NOT do
/// (`highlight_recovery`, `capture_sharpening`, `profile`, and — via
/// `ae_mode` — the `auto_exposure` mode the [`auto_will_fit`] probe pins).
///
/// WB is pinned to the 6500K/0 neutral so `white_balance::apply` returns at its
/// identity short-circuit (`(temp-6500).abs()<0.5 && tint.abs()<0.5`); the GPU
/// chain applies the user's ABSOLUTE WB instead.
#[cfg(any(target_arch = "wasm32", test))]
fn stripped_prefix_model(full: &AdjustmentModel, ae_mode: AutoExposureMode) -> AdjustmentModel {
    AdjustmentModel {
        // Neutral WB → the stage no-ops; the GPU chain re-applies absolute WB.
        temperature: 6500.0,
        tint: 0.0,
        // Effective AE mode from the probe (Off when Auto Profile will fit).
        auto_exposure: ae_mode,
        // Every stage the GPU chain re-runs → no-op default so develop skips it.
        exposure: 0.0,
        contrast: 0.0,
        highlights: 0.0,
        shadows: 0.0,
        whites: 0.0,
        blacks: 0.0,
        parametric_highlights: 0.0,
        parametric_lights: 0.0,
        parametric_darks: 0.0,
        parametric_shadows: 0.0,
        tone_curve_luma: Default::default(),
        tone_curve_red: Default::default(),
        tone_curve_green: Default::default(),
        tone_curve_blue: Default::default(),
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        dehaze: 0.0,
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        // KEEP: highlight_recovery, capture_sharpening_*, profile, wb_method,
        // and every decode-upstream field — they shape the post-AE buffer the
        // GPU chain consumes.
        ..full.clone()
    }
}

/// Assemble the [`FullChainInputs`] the live chain consumes from the FULL user
/// model + the fitted Auto Profile artifacts. Mirrors `raw_gpu`'s `Case::gpu_inputs`
/// / the FFI `inputs_from_params` exactly: the WB matrix is derived from the
/// model's temp/tint via the SAME `wb_cat16_matrix` / `wb_gains` the CPU stage
/// uses, and `capture_sharpening` is `None` (baked in the develop prefix).
#[cfg(any(target_arch = "wasm32", test))]
fn build_full_chain_inputs(
    model: &AdjustmentModel,
    profile_curve_flat: Vec<f32>,
    residual_lut_size: usize,
    residual_lut_data: Vec<f32>,
) -> FullChainInputs {
    use raw_core::types::WbMethod;

    let wb_matrix = match model.wb_method {
        WbMethod::Cat16 => {
            raw_core::stages::white_balance::wb_cat16_matrix(model.temperature, model.tint).0
        }
        WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(model.temperature, model.tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    };

    FullChainInputs {
        wb_matrix,
        wb_temperature: model.temperature,
        wb_tint: model.tint,
        tone: [
            model.exposure,
            model.highlights,
            model.shadows,
            model.whites,
            model.blacks,
        ],
        tone_curves: ToneCurveInputs {
            parametric: [
                model.parametric_shadows,
                model.parametric_darks,
                model.parametric_lights,
                model.parametric_highlights,
            ],
            luma: model.tone_curve_luma.points.clone(),
            red: model.tone_curve_red.points.clone(),
            green: model.tone_curve_green.points.clone(),
            blue: model.tone_curve_blue.points.clone(),
            mode: match model.tone_curve_mode {
                raw_core::types::ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                raw_core::types::ToneCurveMode::PerChannel => CurveMode::PerChannel,
            },
        },
        vibrance: model.vibrance,
        saturation: model.saturation,
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        contrast: model.contrast,
        // Baked into the develop prefix (`capture_sharpening` runs at its
        // canonical 04b position there) → omit on the GPU chain to avoid a
        // double-apply, mirroring the Apple decode-boundary contract.
        capture_sharpening: None,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
    }
}

/// The decode-boundary + GPU-chain CORE, factored out of [`render_bytes_gpu`] so
/// a NATIVE (Metal) host test can drive the exact same plumbing the wasm entry
/// runs — `render_bytes_gpu` is `#[wasm_bindgen]` (wasm-only), but everything
/// below the `async` boundary is platform-neutral (`GpuContext::new_async` +
/// `LiveSession::render_async` run on Metal too). Takes the ALREADY-decoded
/// `raw_img` + the parsed `model` (with the fresh-open WB substitution applied by
/// the caller) and returns the EXIF-oriented `(w, h, u8 RGB)` surface — the same
/// bytes `render_from_raw_with_quality_and_source` produces, but via the GPU.
///
/// `raw` / `ext` are the original RAW bytes + extension, needed for the
/// `auto_will_fit` probe and the Auto Profile fit (which read the embedded JPEG).
#[cfg(any(target_arch = "wasm32", test))]
async fn render_gpu_core(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> Result<(u32, u32, Vec<u8>), String> {
    // Pin auto-exposure to the SAME effective mode the CPU render uses (the
    // `auto_will_fit` probe), then develop the stripped prefix to the post-AE
    // buffer the GPU chain consumes.
    let ae_mode = if auto_will_fit(model, raw, ext) {
        AutoExposureMode::Off
    } else {
        model.auto_exposure
    };
    let prefix_model = stripped_prefix_model(model, ae_mode);
    let scene =
        develop_scene_linear_from_raw_with_quality(raw_img, &prefix_model, RenderQuality::Full)
            .map_err(|e| e.to_string())?;
    let (w, h) = (scene.width, scene.height);

    // Fit the Auto Profile curve + residual LUT against the embedded JPEG (the
    // SAME entry `apply_auto_profile` shares a cache with — see #924 / #972). The
    // GPU chain applies them as separate curve + LUT passes in the view tail. A
    // `None` (Neutral, no preview, degenerate fit) collapses to identity → the
    // chain's view tail is pure AgX, matching `Profile::Neutral`.
    let (curve, lut) = match model.profile {
        Profile::Auto => fit_auto_profile_from_raw(
            raw_img,
            model,
            RenderQuality::Full,
            RawInput::Bytes { bytes: raw, ext },
        )
        .unwrap_or((None, None)),
        _ => (None, None),
    };
    let profile_curve_flat = curve
        .map(|c| c.to_flat())
        .unwrap_or_else(|| auto_profile::curve::ProfileCurve::identity().to_flat());
    let (residual_lut_size, residual_lut_data) = match lut {
        Some(l) => (l.size, l.data),
        None => {
            let id = auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE);
            (id.size, id.data)
        }
    };

    let inputs = build_full_chain_inputs(
        model,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
    );

    // Pack the developed scene-linear buffer to interleaved RGBA f32 (alpha 1.0)
    // — the upload shape `LiveSession::new` expects.
    let mut rgba: Vec<f32> = Vec::with_capacity(scene.pixels.len() * 4);
    for p in &scene.pixels {
        rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }

    // Upload ONCE, run the gated live chain + the WGSL terminal dither, read the
    // u8 RGB surface back. wasm has no blocking poll, so we await the async core.
    let ctx = GpuContext::new_async().await;
    let session = LiveSession::new(&ctx, &rgba, w, h);
    let rgb = session
        .render_async(&ctx, &inputs, None)
        .await
        .ok_or_else(|| "render_bytes_gpu: live chain returned no buffer".to_string())?;

    // EXIF-orient the u8 surface last, exactly as `render_bytes` does (the GPU
    // chain is orientation-agnostic; the develop buffer is in sensor framing).
    Ok(raw_core::image::apply_orientation(&rgb, w, h, raw_img.orientation))
}

/// Render a RAW from bytes to a u8 RGB display surface via the GPU live chain
/// (epic #925, P4b-web / #1029) — the GPU-resident counterpart of
/// [`crate::render_bytes`], returning the SAME [`MapleRender`] shape.
///
/// Pipeline: decode → develop the STRIPPED prefix (post-`auto_exposure`,
/// pre-`white_balance` scene-linear Rec.2020 buffer) → fit the Auto Profile
/// curve + residual LUT → upload to a [`LiveSession`] → drive the gated live
/// chain + the WGSL terminal dither (async; wasm uses `GpuContext::new_async` +
/// `LiveSession::render_async`) → EXIF-orient → u8 RGB.
///
/// The fresh-open WB substitution + as-shot derivation match `render_bytes`
/// byte-for-byte, so the GPU path renders a brand-new import at the camera's
/// As-Shot WB (not the 6500K default), exactly like the CPU path.
///
/// `xmp` is optional XMP sidecar content (a UTF-8 string, not a path). `ext` is a
/// lowercase extension (`"dng"`, `"cr2"`, …) for format disambiguation.
///
/// wasm-only: the `async` `#[wasm_bindgen]` export references `wasm_bindgen_futures`
/// (a wasm-only dep) and presents to WebGPU. The native host parity test
/// (`gpu_render/tests.rs`) drives [`render_gpu_core`] directly instead.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn render_bytes_gpu(
    raw: Vec<u8>,
    ext: String,
    xmp: Option<String>,
) -> Result<MapleRender, JsError> {
    let raw_img = raw_core::decode::decode_bytes(&raw, &ext)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // As-shot derivation + fresh-open WB substitution — IDENTICAL to
    // `render_bytes` (see crate::render_bytes for the rationale), so the GPU
    // path's white balance on a cold open matches the CPU path's.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| crate::estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match &xmp {
        Some(x) => raw_core::xmp::parse(x).map_err(|e| JsError::new(&e.to_string()))?,
        None => AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let (ow, oh, oriented) = render_gpu_core(&raw_img, &raw, &ext, &model)
        .await
        .map_err(|e| JsError::new(&e))?;

    Ok(MapleRender::new(ow, oh, oriented, as_shot_temperature, as_shot_tint))
}

// Native (Metal) host parity gate for the decode-boundary + GPU-chain plumbing
// `render_bytes_gpu` adds on top of the merged P4b-core. wasm-only entry can't
// run on the host, so the test drives `render_gpu_core` (platform-neutral) via
// pollster and compares to the CPU `render_bytes` equivalent. Native test builds
// only; skips when the synthetic DNG fixture is absent (mirrors the color-harness
// skip-pass pattern).
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "gpu_render/tests.rs"]
mod tests;
