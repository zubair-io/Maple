//! `WebLiveSession` — the persistent, zero-readback web live-render handle (epic
//! #925, P4b-web / #1038).
//!
//! The web analog of the Apple `GpuLiveSession`: the editor renders the SAME image
//! every slider tick, so this handle holds the GPU-resident state across ticks —
//! the cached [`GpuContext`] (its ~35 compiled pipelines), the upload-once
//! [`LiveSession`], the decoded [`raw_core::image::RawImage`], and the WebGPU
//! `OffscreenCanvas` surface — and presents each tick DIRECTLY to that surface with
//! NO CPU readback (via the persistent [`raw_gpu::WebPresentSurface`]). Contrast the one-shot
//! [`crate::gpu_render::render_bytes_gpu`], which rebuilds the context (recompiling
//! every pipeline), re-decodes, AND reads back to u8 per call.
//!
//! ## The render lifecycle: open → render(xmp)* → drop
//!
//! - [`WebLiveSession::open`] decodes the RAW ONCE, develops the stripped prefix to
//!   the post-`auto_exposure` scene-linear buffer, fits the Auto Profile artifacts,
//!   uploads the buffer to a [`LiveSession`], and configures the canvas surface.
//!   The develop is VIEWPORT-SIZED (#1080): the caller passes its canvas/viewport
//!   `max_long_edge` (real pixels) and the buffer + canvas are fit to it — never
//!   full sensor res, which on a 100 MP frame exceeds the downlevel 2048 texture
//!   baseline (black canvas) and burns ~2.8 GB of transient f32 in the wasm heap.
//! - [`WebLiveSession::render`] re-applies the user's WB / tone / … on the GPU and
//!   presents. It re-develops + re-uploads ONLY when a prefix-affecting field
//!   changes (see below); the hot-path sliders just rebuild [`FullChainInputs`] and
//!   re-run the resident chain — allocating zero new GPU buffers and recompiling no
//!   pipelines (the CLAUDE.md render-loop invariant; the zero-alloc re-render is
//!   proven on the shared `raw_gpu::LiveSession` substrate in
//!   `raw-gpu/src/live_session/tests.rs`).
//! - Drop releases the GPU context + session.
//!
//! ## Re-develop boundary (correct by construction)
//!
//! The stripped-prefix develop zeroes every GPU-rerun slider, so the developed
//! buffer is a function of ONLY the surviving prefix fields (`highlight_recovery`,
//! `capture_sharpening`, `profile`, the effective AE mode the `auto_will_fit` probe
//! pins, and the decode-upstream fields). We cache the EXACT prefix model the
//! current upload was developed from and re-develop iff the newly-derived prefix
//! model is not equal to it. An identical prefix model ⇒ an identical buffer (same
//! deterministic upstream math), so reuse is sound; a different one (e.g. the user
//! toggled the Profile or moved capture-sharpening) re-develops + re-uploads, once.
//! The hot-path WB/tone/vibrance/… sliders never change the prefix model, so they
//! stay on the zero-re-upload fast path.
//!
//! ## Parity
//!
//! `render` rides the IDENTICAL develop + fit + chain as the one-shot
//! `render_bytes_gpu` (shared [`crate::gpu_render::develop_prefix_rgba`] /
//! [`crate::gpu_render::chain_inputs_for_model`]), then the same f32 chain
//! ([`LiveSession::render_chain_to_f32_async`]) the headless C4 path runs; the
//! surface present applies the same `dither_and_quantize` math `dither.wgsl` does
//! (`present_chain.wgsl`, gated offscreen vs the CPU oracle in
//! `present_chain/tests.rs`). So the on-screen pixels match the one-shot u8 surface
//! within the epic's ≤ 1 LSB dither-boundary tolerance — the W1 gate's number,
//! carried through by construction. The real-WebGPU-browser 16 ms measurement is
//! the #1029-W3 maintainer checkpoint.

use crate::gpu_render::{
    chain_inputs_for_model, develop_prefix_rgba, effective_target_long_edge, prefix_model_for,
};
use raw_core::xmp::AdjustmentModel;
use raw_gpu::{GpuContext, LiveSession, WebPresentSurface};
use wasm_bindgen::prelude::*;
use web_sys::OffscreenCanvas;

/// A persistent web live-render session: the GPU-resident state for ONE image,
/// driven across slider ticks via [`WebLiveSession::render`]. Owns the cached
/// context, the upload-once session, the decoded RAW (for re-develop without
/// re-decode), and the WebGPU `OffscreenCanvas` surface.
///
/// Not `Send`/`Sync` (like [`GpuContext`] / [`LiveSession`]) — single-threaded
/// around the GPU, which matches the Web Worker that owns it.
#[wasm_bindgen]
pub struct WebLiveSession {
    ctx: GpuContext,
    /// The decoded RAW, retained so a prefix-affecting edit re-develops WITHOUT
    /// re-decoding (decode is the multi-hundred-ms cost the one-shot path repays
    /// every call).
    raw_img: raw_core::image::RawImage,
    /// Original RAW bytes + extension — needed for the `auto_will_fit` probe and
    /// the Auto Profile fit (both read the embedded JPEG).
    raw: Vec<u8>,
    ext: String,
    /// The persistent WebGPU present surface over the `OffscreenCanvas` (transferred
    /// from the main thread via `transferControlToOffscreen`). Owns the surface +
    /// the compiled present pipeline; created ONCE in `open`, so a per-tick present
    /// recompiles nothing and reconfigures no swapchain (#1038).
    present: WebPresentSurface,
    /// The upload-once image + persistent ping-pong / dither buffers. Recreated
    /// only on a prefix-affecting edit (re-develop) — never per hot-path tick.
    session: LiveSession,
    /// The EXACT stripped-prefix model `session`'s uploaded buffer was developed
    /// from. A render re-develops iff its newly-derived prefix model differs.
    prefix_model: AdjustmentModel,
    /// The EFFECTIVE develop long-edge cap (#1080): the caller's viewport target
    /// normalized + clamped to the device texture cap in `open`. Fixed for the
    /// session's lifetime, so a prefix re-develop reproduces the same dims and
    /// the canvas surface never needs resizing.
    target_long_edge: u32,
    /// Developed (viewport-sized, sensor-framing) image dims — also the canvas +
    /// surface dims. ≤ `target_long_edge` on the long edge (#1080). The present
    /// asserts canvas dims == session dims; dims never change across ticks (same
    /// image, same target), so the canvas is sized once on open.
    width: u32,
    height: u32,
    /// NATIVE oriented dims (`native_render_dims`) — what a full-res render of
    /// this RAW would produce. Surfaced to JS (#1080) so the editor records the
    /// native dims for its fit/100% zoom math (the `render_bytes_sized`
    /// contract, #1101) while the session itself stays viewport-sized.
    full_width: u32,
    full_height: u32,
    /// Camera As-Shot WB, surfaced to JS so the UI can seed the sliders exactly
    /// like the one-shot `render_bytes` / `render_bytes_gpu` paths do.
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

/// Parse the XMP model with the SAME fresh-open WB substitution `render_bytes` /
/// `render_bytes_gpu` apply: a brand-new import (no XMP) renders at the camera's
/// As-Shot WB, not the 6500K default. Shared by `open` + `render` so a session
/// behaves identically to the one-shot path at every tick.
fn parse_model_with_as_shot_wb(
    xmp: &Option<String>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
) -> Result<AdjustmentModel, String> {
    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => raw_core::xmp::parse(x).map_err(|e| e.to_string())?,
        None => AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }
    Ok(model)
}

#[wasm_bindgen]
impl WebLiveSession {
    /// Open a persistent live session for `raw` and present its first frame to
    /// `canvas`. Decodes ONCE, develops the stripped prefix FIT TO the caller's
    /// viewport target (#1080), fits the Auto Profile artifacts, uploads to a
    /// [`LiveSession`], sizes the canvas to the developed dims, and presents.
    /// `xmp` is optional sidecar content (the model); `None` ⇒ a fresh import at
    /// the camera As-Shot WB. `ext` is a lowercase extension (`"dng"`, `"cr2"`, …).
    ///
    /// `max_long_edge` is the viewport target in REAL (backing-store) pixels: the
    /// develop fits the image to it (long-edge fit, aspect preserved, never
    /// upscaled), so the GPU session + canvas are viewport-sized instead of full
    /// sensor res. ADDITIVE: omitting it (`undefined`/`null` — the pre-#1080 call
    /// shape) or passing `0` caps the long edge at
    /// [`crate::gpu_render::DEFAULT_TARGET_LONG_EDGE`] (2048, the downlevel WebGPU
    /// texture baseline) so the no-target path can't configure an over-limit
    /// surface; explicit values are clamped to the device's actual texture cap.
    ///
    /// Async (WebGPU adapter/device request + present are async). Returns the
    /// opened handle; subsequent edits drive [`WebLiveSession::render`].
    #[wasm_bindgen]
    pub async fn open(
        raw: Vec<u8>,
        ext: String,
        xmp: Option<String>,
        canvas: OffscreenCanvas,
        max_long_edge: Option<u32>,
    ) -> Result<WebLiveSession, JsError> {
        let raw_img =
            raw_core::decode::decode_bytes(&raw, &ext).map_err(|e| JsError::new(&e.to_string()))?;

        // As-shot derivation + fresh-open WB substitution — IDENTICAL to
        // `render_bytes` / `render_bytes_gpu`.
        let as_shot_temperature = raw_img
            .as_shot_cct
            .unwrap_or_else(|| crate::estimate_cct_from_neutral(raw_img.as_shot_neutral));
        let as_shot_tint = 0.0_f32;
        let model = parse_model_with_as_shot_wb(&xmp, as_shot_temperature, as_shot_tint)
            .map_err(|e| JsError::new(&e))?;

        // Context BEFORE develop: the effective develop target clamps to this
        // device's texture cap (#1080, composing with #1079's adapter-clamped
        // limits + validation). Fallible (#1079): no WebGPU adapter/device
        // surfaces as a JsError — the worker falls back to the CPU render path
        // instead of trapping.
        let ctx = GpuContext::new_async()
            .await
            .map_err(|e| JsError::new(&e))?;
        let target_long_edge = effective_target_long_edge(max_long_edge, &ctx);

        // Develop the stripped prefix ONCE — fit to the viewport target — and
        // upload it. `prefix_model` is the exact model this buffer reflects,
        // cached for the re-develop check. Native dims ride the handle so the
        // editor's zoom math stays full-res-aware (#1101 contract).
        let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
        let (rgba, width, height, prefix_model) =
            develop_prefix_rgba(&raw_img, &raw, &ext, &model, target_long_edge)
                .map_err(|e| JsError::new(&e))?;

        // Fallible (#1079): an image past the device's buffer/binding limits
        // surfaces as a JsError for the same CPU fallback.
        let session = LiveSession::new(&ctx, &rgba, width, height).map_err(|e| JsError::new(&e))?;

        // Size the canvas to the developed (viewport-sized) dims so the present's
        // surface-dims == image-dims invariant holds (the FS recovers each pixel
        // from the fragment position; a mismatch desyncs the dither cell). CSS
        // scales the element to the layout box on the main thread. Then build the
        // persistent present surface ONCE (surface + configure + display-p3 retag
        // + present-pipeline compile) — every tick reuses it.
        canvas.set_width(width);
        canvas.set_height(height);
        let present = WebPresentSurface::create(&ctx, &canvas, width, height)
            .map_err(|e| JsError::new(&e))?;

        let handle = WebLiveSession {
            ctx,
            raw_img,
            raw,
            ext,
            present,
            session,
            prefix_model,
            target_long_edge,
            width,
            height,
            full_width,
            full_height,
            as_shot_temperature,
            as_shot_tint,
        };
        handle
            .present_for_model(&model)
            .await
            .map_err(|e| JsError::new(&e))?;
        Ok(handle)
    }

    /// Re-render the live canvas for `xmp` and present to the surface — the hot
    /// path. Rebuilds [`FullChainInputs`] from the model, re-develops + re-uploads
    /// ONLY when the prefix model changes (see the module docs), runs the resident
    /// GPU chain to its f32 buffer, and presents with NO readback.
    ///
    /// Returns the achieved canvas colour-space tag (`"display-p3"` / `"srgb"` /
    /// `"unknown"`) so the worker can self-report it. `xmp` is the serialized model
    /// (always present after `open`; `None` is treated as a fresh As-Shot import).
    #[wasm_bindgen]
    pub async fn render(&mut self, xmp: Option<String>) -> Result<String, JsError> {
        let model = parse_model_with_as_shot_wb(&xmp, self.as_shot_temperature, self.as_shot_tint)
            .map_err(|e| JsError::new(&e))?;

        // Re-develop + re-upload iff the prefix model changed. The hot-path sliders
        // are zeroed in the prefix, so a WB/tone/vibrance/… tick takes the cheap
        // branch: same buffer, same LiveSession, zero new GPU buffers.
        let new_prefix = prefix_model_for(&self.raw_img, &self.raw, &self.ext, &model);
        if new_prefix != self.prefix_model {
            let (rgba, w, h, prefix_model) = develop_prefix_rgba(
                &self.raw_img,
                &self.raw,
                &self.ext,
                &model,
                self.target_long_edge,
            )
            .map_err(|e| JsError::new(&e))?;
            // Dims are stable across ticks (same image, same session-pinned
            // target), but assert so a future quality/target switch can't
            // silently desync the canvas surface.
            if (w, h) != (self.width, self.height) {
                return Err(JsError::new(&format!(
                    "WebLiveSession::render: re-develop dims {w}x{h} != {}x{} (canvas not resized)",
                    self.width, self.height
                )));
            }
            self.session.update_image(&self.ctx, &rgba);
            self.prefix_model = prefix_model;
        }

        self.present_for_model(&model)
            .await
            .map_err(|e| JsError::new(&e))
    }

    /// Re-render the live canvas with a flat parameters array (avoiding XML parsing on hot path).
    #[wasm_bindgen]
    pub async fn render_with_params(&mut self, params: &[f32]) -> Result<String, JsError> {
        if params.len() < 19 {
            return Err(JsError::new("render_with_params: params slice too short (expected at least 19 elements)"));
        }

        // We clone the prefix model to preserve the base (such as auto exposure, local adjustments, crop, etc.)
        let mut model = self.prefix_model.clone();

        model.exposure = params[0];
        model.brightness = params[1];
        model.contrast = params[2];
        model.highlights = params[3];
        model.shadows = params[4];
        model.whites = params[5];
        model.blacks = params[6];
        model.vibrance = params[7];
        model.saturation = params[8];
        model.temperature = params[9];
        model.tint = params[10];
        model.clarity = params[11];
        model.texture = params[12];
        model.dehaze = params[13];
        model.vignette_amount = params[14];
        model.vignette_feather = params[15];
        model.grain_amount = params[16];
        model.grain_size = params[17];
        model.grain_roughness = params[18];

        self.present_for_model(&model)
            .await
            .map_err(|e| JsError::new(&e))
    }

    /// Camera-side "As Shot" CCT in Kelvin (rawler-derived) — same value the
    /// one-shot paths return in [`MapleRender`].
    #[wasm_bindgen(getter, js_name = asShotTemperature)]
    pub fn as_shot_temperature(&self) -> f32 {
        self.as_shot_temperature
    }

    /// Camera-side "As Shot" tint in slider units.
    #[wasm_bindgen(getter, js_name = asShotTint)]
    pub fn as_shot_tint(&self) -> f32 {
        self.as_shot_tint
    }

    /// The developed (viewport-sized) image width (== canvas width). ≤ the
    /// session's effective `max_long_edge` target on the long edge (#1080).
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// The developed (viewport-sized) image height (== canvas height). ≤ the
    /// session's effective `max_long_edge` target on the long edge (#1080).
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// NATIVE oriented width — what a full-res render of this RAW would produce
    /// (`native_render_dims`). The session is viewport-sized (#1080), so the
    /// editor records THESE dims for its fit/100% zoom math (#1101 contract).
    #[wasm_bindgen(getter, js_name = fullWidth)]
    pub fn full_width(&self) -> u32 {
        self.full_width
    }

    /// NATIVE oriented height — see [`WebLiveSession::full_width`].
    #[wasm_bindgen(getter, js_name = fullHeight)]
    pub fn full_height(&self) -> u32 {
        self.full_height
    }

    /// The achieved canvas colour-space tag from the one-time display-p3 retag
    /// (`"display-p3"` / `"srgb"` / `"unknown"`) — surfaced so the worker reports
    /// the TRUTH the browser configured after `open`, never an assumption.
    #[wasm_bindgen(getter, js_name = colorSpace)]
    pub fn color_space(&self) -> String {
        self.present.color_space().to_string()
    }
}

impl WebLiveSession {
    /// Build the chain inputs for `model`, run the resident chain to its f32
    /// buffer, and present to the held canvas surface. The shared tail of `open` +
    /// `render`. Returns the achieved colour-space tag (from the one-time retag).
    async fn present_for_model(&self, model: &AdjustmentModel) -> Result<String, String> {
        let inputs = chain_inputs_for_model(&self.raw_img, &self.raw, &self.ext, model);
        let final_idx = self
            .session
            .render_chain_to_f32_async(&self.ctx, &inputs, None)
            .await
            .map_err(|e| format!("WebLiveSession: {e}"))?
            .ok_or_else(|| "WebLiveSession: live chain returned no buffer".to_string())?;
        // The present recompiles nothing (the pipeline + surface are session-owned);
        // it only fetches the next surface texture, encodes the dither/quantize pass,
        // and presents — zero readback.
        self.present.present(&self.ctx, &self.session, final_idx)?;
        Ok(self.present.color_space().to_string())
    }
}
