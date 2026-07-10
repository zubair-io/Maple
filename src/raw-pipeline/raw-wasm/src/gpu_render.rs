//! `render_bytes_gpu` — the GPU-resident web live-render entry (epic #925,
//! P4b-web / #1029).
//!
//! The WASM counterpart of [`crate::render_bytes`]: decodes a RAW from bytes and
//! produces the SAME u8 RGB display surface, but routes the scene-linear-subset +
//! view-tail + dither through the merged wgpu+WGSL chain ([`raw_gpu::LiveSession`])
//! instead of `raw-core`'s CPU pipeline. Gated behind `raw-wasm`'s `gpu` feature
//! (off by default; the CPU `render_bytes` + WebGL2 paths remain the fallback —
//! deletion is P5).
//!
//! Unlike the CPU path, the GPU develop is VIEWPORT-SIZED (#1080): the caller
//! passes a `max_long_edge` target (real pixels) and the prefix develop fits the
//! image to it via raw-core's sized chain — full sensor res would exceed the
//! device texture cap on 100 MP frames AND materialize ~2.8 GB of transient f32
//! inside wasm32's permanently-grown heap. No target ⇒ the
//! [`DEFAULT_TARGET_LONG_EDGE`] (2048) cap.
//!
//! ## The decode boundary (why two develops, and where the split lands)
//!
//! The GPU chain re-applies `white_balance` → … → `nr_color` + the view tail, so
//! its INPUT must be the post-`auto_exposure` (develop stage 05), pre-`white_balance`
//! (stage 06) scene-linear Rec.2020 buffer. raw-core exposes no such split point,
//! so we obtain it by developing through the EXISTING
//! [`develop_scene_linear_sized_from_raw_with_quality`] with a STRIPPED model: the
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
    develop_scene_linear_sized_from_raw_with_quality, fit_auto_profile_from_raw, RawInput,
    RenderQuality,
};
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::types::adjustment::{AutoExposureMode, Profile};
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::view::auto_profile;
#[cfg(any(target_arch = "wasm32", test))]
use raw_core::xmp::AdjustmentModel;
#[cfg(any(target_arch = "wasm32", test))]
use raw_gpu::{FullChainInputs, GpuContext, LiveSession};

#[cfg(target_arch = "wasm32")]
use crate::MapleRender;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Default long-edge cap for the GPU live develop when the JS caller passes no
/// viewport target (#1080). Equal to `wgpu::Limits::downlevel_defaults()`'s
/// `max_texture_dimension_2d` — the baseline every adapter meets, and the floor
/// of the adapter-clamped limits [`GpuContext::new_async`] requests (#1079) —
/// so the no-target path can never configure an over-limit canvas surface, and
/// its storage upload (`2048² × 16 B/px ≈ 67 MB`) stays well inside the
/// downlevel 128 MiB storage-binding cap. Before #1080 this path developed at
/// FULL sensor resolution: a 100 MP frame is ~5.7× this cap (browser validation
/// error → black canvas) and ~2.8 GB of transient f32 inside wasm32's 4 GiB
/// heap (wasm memory growth is permanent).
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) const DEFAULT_TARGET_LONG_EDGE: u32 = 2048;

/// Normalize the JS-side `max_long_edge` request: `None` (the legacy no-arg
/// call shape) and `0` (a degenerate viewport measurement) both fall back to
/// [`DEFAULT_TARGET_LONG_EDGE`]. Pure — the device clamp lives in
/// [`effective_target_long_edge`].
#[cfg(any(target_arch = "wasm32", test))]
fn normalize_target_long_edge(requested: Option<u32>) -> u32 {
    match requested {
        Some(0) | None => DEFAULT_TARGET_LONG_EDGE,
        Some(v) => v,
    }
}

/// The long-edge cap the sized develop actually uses: the normalized request,
/// clamped to the device's `max_texture_dimension_2d` so the canvas surface a
/// [`crate::web_live_session::WebLiveSession`] configures at the developed dims
/// can never exceed what THIS device accepts. The context requests
/// adapter-clamped limits (#1079 — the downlevel 2048 baseline raised to
/// whatever the adapter supports), so the clamp follows the REAL device cap;
/// the two compose: #1079 makes a genuinely-oversize request FAIL CLEANLY, this
/// keeps the web path from producing one at all.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn effective_target_long_edge(requested: Option<u32>, ctx: &GpuContext) -> u32 {
    normalize_target_long_edge(requested).min(ctx.device.limits().max_texture_dimension_2d.max(1))
}

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

// The stripped-prefix model + FullChainInputs assembly (pure model
// arithmetic, no GPU calls) live in the sibling `gpu_render/model.rs` —
// split out to keep this file under the 600-LOC budget (#1170).
#[cfg(any(target_arch = "wasm32", test))]
#[path = "gpu_render/model.rs"]
mod model;
#[cfg(any(target_arch = "wasm32", test))]
use model::{build_full_chain_inputs, stripped_prefix_model};

/// The effective auto-exposure mode the stripped-prefix develop must use — the
/// SAME one the CPU render uses (`auto_will_fit` → Off when Auto Profile fits,
/// else the model's mode). Pulled out so [`render_gpu_core`] and the persistent
/// [`crate::web_live_session::WebLiveSession`] derive the prefix model identically.
#[cfg(any(target_arch = "wasm32", test))]
fn effective_ae_mode(model: &AdjustmentModel, raw: &[u8], ext: &str) -> AutoExposureMode {
    if auto_will_fit(model, raw, ext) {
        AutoExposureMode::Off
    } else {
        model.auto_exposure
    }
}

/// Derive the stripped-prefix model for `model` WITHOUT developing — the cheap
/// change-detector the persistent [`crate::web_live_session::WebLiveSession`] uses
/// to decide whether a render must re-develop + re-upload. Equal to the
/// `prefix_model` [`develop_prefix_rgba`] returns (BOTH call `effective_ae_mode` +
/// `stripped_prefix_model`, so the equivalence is by construction), making a
/// compare against the cached prefix model the sound re-upload boundary. Pure model
/// arithmetic + the `auto_will_fit` probe (a cache / embedded-JPEG check); no
/// develop, no upload.
///
/// wasm-only: the persistent session (its only caller) is wasm-only. The host
/// parity/boundary tests exercise its components (`effective_ae_mode` +
/// `stripped_prefix_model`) directly.
#[cfg(target_arch = "wasm32")]
pub(crate) fn prefix_model_for(
    raw_img: &raw_core::image::RawImage,
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
/// upload shape [`LiveSession::new`] expects. Returns `(rgba, w, h, prefix_model)`;
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
) -> Result<(Vec<f32>, u32, u32, AdjustmentModel), String> {
    let ae_mode = effective_ae_mode(model, raw, ext);
    let prefix_model = stripped_prefix_model(model, ae_mode);
    // AMaZE by default (#940): this develop runs once per live-session open
    // (the GPU keeps the uploaded frame; per-tick edits are uniform pushes),
    // so the demosaic upgrade is a per-open cost, not per-tick. With the
    // `parallel` wasm feature + crossOriginIsolated the tiled kernel (#1887)
    // costs the same as bilinear; single-threaded fallbacks pay the serial
    // kernel once per open.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw_img,
        &prefix_model,
        RenderQuality::Amaze,
        max_long_edge,
    )
    .map_err(|e| e.to_string())?;
    let (w, h) = (scene.width, scene.height);
    // Pack scene RGB (12 B/px) → upload RGBA (16 B/px). Both are briefly alive
    // here; a chunk-wise `drain` would NOT lower that peak (a `Vec` never releases
    // partial capacity, so the source allocation stays resident until the final
    // drop regardless of how it is consumed). The sized develop above is what
    // bounds the transient: ≤ ~80 MB at the 2048 default vs ~2.8 GB at full
    // sensor res on a 100 MP frame (#1080).
    let mut rgba: Vec<f32> = Vec::with_capacity(scene.pixels.len() * 4);
    for p in &scene.pixels {
        rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
    }
    Ok((rgba, w, h, prefix_model))
}

/// Fit the Auto Profile curve + residual LUT against the embedded JPEG (the SAME
/// entry `apply_auto_profile` shares a cache with — see #924 / #972) and flatten
/// them into the `(profile_curve_flat, residual_lut_size, residual_lut_data)` shape
/// [`build_full_chain_inputs`] consumes. A `None` (Neutral, no preview, degenerate
/// fit) collapses to identity → the chain's view tail is pure AgX, matching
/// `Profile::Neutral`. The fit is keyed on the RAW BYTES (not the model), so after
/// the first call it is cache-served — re-running it per slider tick is cheap.
#[cfg(any(target_arch = "wasm32", test))]
fn fit_profile_artifacts(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> (Vec<f32>, usize, Vec<f32>) {
    let (curve, lut) = match model.profile {
        // Deliberately `Full` (not AMaZE, #940): the fit compares a
        // downscaled develop against the embedded JPEG to derive a global
        // tone curve — demosaic quality cannot move that fit, and the
        // cheaper develop keeps the (bytes-keyed, cached) fit fast.
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
    (profile_curve_flat, residual_lut_size, residual_lut_data)
}

/// Assemble the [`FullChainInputs`] for `model` from the RAW + the (cache-served)
/// Auto Profile fit. The view-tail-and-WB shape the live chain re-applies every
/// render; cheap (no decode, no GPU compile), so the persistent session rebuilds
/// it per tick from the latest model while reusing the uploaded prefix buffer.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn chain_inputs_for_model(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> FullChainInputs {
    let (profile_curve_flat, residual_lut_size, residual_lut_data) =
        fit_profile_artifacts(raw_img, raw, ext, model);
    build_full_chain_inputs(
        model,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
    )
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
///
/// This is the ONE-SHOT u8-readback path (the W1 parity gate + the gpu-off-bundle
/// fallback). The persistent zero-readback path
/// ([`crate::web_live_session::WebLiveSession`]) reuses the SAME
/// [`develop_prefix_rgba`] / [`chain_inputs_for_model`] helpers but uploads once
/// and presents to a surface instead of reading back.
///
/// `max_long_edge` (#1080): optional viewport target from the JS caller, in real
/// (backing-store) pixels. The develop is fit to it (aspect preserved, never
/// upscaled), so the returned surface is viewport-sized, not full sensor res.
/// `None`/`0` → [`DEFAULT_TARGET_LONG_EDGE`]; either way the target is clamped to
/// the device's texture cap via [`effective_target_long_edge`].
#[cfg(any(target_arch = "wasm32", test))]
async fn render_gpu_core(
    raw_img: &raw_core::image::RawImage,
    raw: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    max_long_edge: Option<u32>,
) -> Result<(u32, u32, Vec<u8>), String> {
    // Context FIRST: the effective develop target clamps to this device's
    // texture cap, so the device must exist before the sized develop runs.
    // Fallible (#1079): no adapter / device surfaces as an Err so the worker
    // falls back to the CPU `render_bytes` path instead of trapping.
    let ctx = GpuContext::new_async()
        .await
        .map_err(|e| format!("render_bytes_gpu: {e}"))?;
    let target = effective_target_long_edge(max_long_edge, &ctx);

    let (rgba, w, h, _prefix_model) = develop_prefix_rgba(raw_img, raw, ext, model, target)?;
    let inputs = chain_inputs_for_model(raw_img, raw, ext, model);

    // Upload ONCE, run the gated live chain + the WGSL terminal dither, read the
    // u8 RGB surface back. wasm has no blocking poll, so we await the async core.
    // Every GPU step is fallible (#1079): dims past the device's limits, a failed
    // readback — each surfaces as an Err for the same CPU fallback.
    let session =
        LiveSession::new(&ctx, &rgba, w, h).map_err(|e| format!("render_bytes_gpu: {e}"))?;
    let rgb = session
        .render_async(&ctx, &inputs, None)
        .await
        .map_err(|e| format!("render_bytes_gpu: {e}"))?
        .ok_or_else(|| "render_bytes_gpu: live chain returned no buffer".to_string())?;

    // EXIF-orient the u8 surface last, exactly as `render_bytes` does (the GPU
    // chain is orientation-agnostic; the develop buffer is in sensor framing).
    Ok(raw_core::image::apply_orientation(
        &rgb,
        w,
        h,
        raw_img.orientation,
    ))
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
/// `max_long_edge` (#1080): the caller's viewport target in REAL (backing-store)
/// pixels — the develop fits the image to it (long-edge fit, aspect preserved,
/// never upscaled) so a 100 MP frame no longer materializes ~2.8 GB of transient
/// f32 in the wasm heap or exceeds the texture cap. ADDITIVE: omitting it
/// (`undefined`/`null` from JS — the pre-#1080 call shape) or passing `0` caps
/// the long edge at [`DEFAULT_TARGET_LONG_EDGE`] (2048, the downlevel WebGPU
/// texture baseline) instead of restoring the old full-res behavior; explicit
/// values are clamped to the device's actual texture cap. The returned
/// [`MapleRender`] carries the sized buffer in `width`/`height` and the NATIVE
/// oriented dims in `full_width`/`full_height` (`native_render_dims` — the same
/// contract as `render_bytes_sized`, #1101), so the editor keeps its fit/100%
/// zoom math.
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
    max_long_edge: Option<u32>,
) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(&raw, &ext).map_err(|e| JsError::new(&e.to_string()))?;

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

    let (ow, oh, oriented) = render_gpu_core(&raw_img, &raw, &ext, &model, max_long_edge)
        .await
        .map_err(|e| JsError::new(&e))?;

    // Native oriented dims for `full_width`/`full_height` — the develop above is
    // viewport-sized (#1080), so the editor's fit/100% zoom math needs the dims a
    // full-res render would produce (the `render_bytes_sized` contract, #1101).
    let (full_w, full_h) = raw_core::pipeline::native_render_dims(&raw_img);

    Ok(MapleRender::new(
        ow,
        oh,
        full_w,
        full_h,
        oriented,
        as_shot_temperature,
        as_shot_tint,
    ))
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
// The #1080 viewport-sized develop gates live in their own file (600-LOC file
// budget); they reuse `tests::{synthetic_dng_path, gpu_available, cpu_reference}`
// (pub(super) there).
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "gpu_render/tests_sizing.rs"]
mod tests_sizing;
