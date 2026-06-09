//! Web chain-output present — the live chain's final f32 buffer → a WebGPU
//! `OffscreenCanvas` surface (epic #925, P4b-web / #1029).
//!
//! The **web counterpart** of [`crate::present_chain::present_chain_to_surface`]
//! (P4b-apple #1028 `CAMetalLayer`): SAMPLES the [`LiveSession`]'s final f32-RGBA
//! chain output (left resident by [`LiveSession::render_chain_to_f32_async`]) and
//! writes the dithered/quantized 8-bit result straight to the canvas surface — with
//! **NO CPU readback**. Shares `present_chain.wgsl` + the device-agnostic
//! [`crate::present_chain_pipeline`] helpers with the Apple path, so the
//! dither/quantize draw is single-sourced and its colour correctness is already
//! covered by `present_chain/tests.rs`' host offscreen parity gate.
//!
//! ## The device is the session's, not a fresh one
//!
//! Like the Apple surface present, this MUST run on the SAME [`GpuContext`] device
//! the [`LiveSession`] rendered on — the f32 chain buffer lives there, and a buffer
//! can only be bound to a pipeline on its own device. So the surface is created from
//! a fresh `wgpu::Instance` (`SurfaceTarget::OffscreenCanvas`, the *safe* web
//! variant — wgpu reads the canvas handle itself, no `raw-window-handle` unsafe) but
//! configured with the context's EXISTING device/adapter.
//!
//! ## Surface dims == image dims (parity invariant)
//!
//! `present_chain.wgsl`'s FS recovers each pixel's `(x, y)` from the fragment
//! position and indexes the f32 buffer `i = y*width + x`, so the surface MUST be
//! configured at the image's exact dims or the Bayer dither cell + the buffer index
//! desync. This asserts `canvas dims == session dims` (the caller sizes the
//! `OffscreenCanvas` to the uploaded image before presenting — the present never
//! rescales).
//!
//! ## Colour-space (`display-p3`)
//!
//! The live web canvas in this project is tagged **`display-p3`** (mirrors the
//! WebGL pipeline's `colorSpace: 'display-p3'`). As in P1c, wgpu-23 hardcodes
//! `colorSpace` absent in its own `configure()` call (→ browser default `srgb`), so
//! after wgpu configures the surface we re-`configure()` the SAME canvas context to
//! `display-p3`, reusing wgpu's device/format read back via `getConfiguration()`.
//! The whole dance runs through `js_sys` on untyped values (see
//! [`crate::present_web_colorspace::retag_display_p3_context`]) — NOT typed
//! `web_sys::Gpu*` bindings, which would collide with wgpu-23's vendored WebGPU
//! bindings (`duplicate string enums`). A failed re-tag degrades to `srgb` and the
//! present still succeeds.

use crate::context::GpuContext;
use crate::live_session::LiveSession;
use crate::present_chain_pipeline::{build_present_pipeline, encode_present_pass, pick_surface_format};
use wasm_bindgen::JsValue;
use web_sys::OffscreenCanvas;

/// Present the live chain's final f32 buffer (left resident by
/// [`LiveSession::render_chain_to_f32_async`] at ping-pong index `final_idx`) into
/// `canvas` (a `web_sys::OffscreenCanvas`) — the dithered/quantized 8-bit display
/// surface, with NO CPU readback.
///
/// Creates a wgpu surface from `canvas` configured with `ctx`'s EXISTING device
/// (the f32 buffer lives there), at the session's dims (asserted == canvas dims),
/// re-tags the canvas context to `display-p3`, runs `present_chain.wgsl`, and
/// presents one frame. Returns the achieved colour-space tag (`"display-p3"` /
/// `"srgb"` / `"unknown"`) so the caller can self-report it, or `Err(message)`
/// describing the first failing step.
///
/// Async (awaited from JS via `wasm-bindgen-futures`): the adapter request is async
/// on web. The surface created from `canvas` is dropped before this returns.
pub async fn present_chain_to_canvas(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
    canvas: &OffscreenCanvas,
) -> Result<String, String> {
    let (width, height) = session.dims();
    if width == 0 || height == 0 {
        return Err(format!("present_chain_web: invalid image size {width}x{height}"));
    }
    let (cw, ch) = (canvas.width(), canvas.height());
    if (cw, ch) != (width, height) {
        return Err(format!(
            "present_chain_web: canvas {cw}x{ch} != image {width}x{height} (caller must size the \
             OffscreenCanvas to the uploaded image — the present never rescales)"
        ));
    }

    let instance = wgpu::Instance::default();
    // `SurfaceTarget::OffscreenCanvas` is the safe web variant — wgpu reads the
    // canvas handle itself; no `raw-window-handle` unsafe juggling.
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|e| format!("create_surface(OffscreenCanvas) failed: {e}"))?;

    // Reuse the context's adapter (the live chain rendered on its device). On web
    // the adapter was requested without a `compatible_surface`; re-confirm this
    // surface is compatible so a present on an incompatible canvas fails loudly
    // rather than at configure time.
    let caps = surface.get_capabilities(&ctx.adapter);
    if caps.formats.is_empty() {
        return Err("present_chain_web: surface advertised no formats".to_string());
    }
    let format = pick_surface_format(&caps);

    // The f32 chain buffer is bound in the present pass, so the surface MUST be
    // configured with the context's DEVICE (same device the buffer lives on).
    surface.configure(
        &ctx.device,
        &wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        },
    );

    // Re-tag the canvas context to display-p3 (gated; see module docs). Runs AFTER
    // wgpu's configure and BEFORE get_current_texture, reusing wgpu's device, so it
    // survives to present without a device mismatch. `get_context("webgpu")` hands
    // back the SAME singleton context wgpu configured; we re-tag it through untyped
    // `js_sys`. A failure degrades to `srgb`.
    let color_space = match canvas.get_context("webgpu") {
        Ok(Some(obj)) => {
            crate::present_web_colorspace::retag_display_p3_context(&JsValue::from(obj))
        }
        _ => "unknown".to_string(),
    };

    let (pipeline, bgl) = build_present_pipeline(ctx, format);
    let chain_buf = session.ping_pong_buffer(final_idx);

    let frame = surface
        .get_current_texture()
        .map_err(|e| format!("present_chain_web: get_current_texture failed: {e}"))?;
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("present-chain-web-encoder"),
        });
    encode_present_pass(ctx, &mut encoder, &pipeline, &bgl, chain_buf, &view, (width, height));
    ctx.queue.submit(Some(encoder.finish()));
    frame.present();
    Ok(color_space)
}
