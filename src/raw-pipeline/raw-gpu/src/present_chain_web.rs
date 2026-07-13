//! Web chain-output present — the live chain's final f32 buffer → a WebGPU
//! `OffscreenCanvas` surface (epic #925, P4b-web / #1029, #1038).
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
//! ## Persistent surface (the per-tick zero-recompile invariant — #1038)
//!
//! [`WebPresentSurface`] owns the `wgpu::Surface`, the present `RenderPipeline` +
//! its bind-group layout, and the chosen format — all created/configured/retagged
//! ONCE in [`WebPresentSurface::create`]. [`WebPresentSurface::present`] then does
//! only `get_current_texture` → [`encode_present_pass`] → `present` per frame: it
//! recompiles NO pipeline and reconfigures NO swapchain. (The naive
//! "create-surface-and-pipeline-per-frame" shape would recompile `present_chain.wgsl`
//! and reconfigure the canvas context every slider tick — see the persistence
//! invariant in [`crate::live_session`].) The held surface is bound to ONE set of
//! image dims; the caller asserts dims are stable across the session.
//!
//! ## The device is the session's, not a fresh one
//!
//! Like the Apple surface present, this MUST run on the SAME [`GpuContext`] device
//! the [`LiveSession`] rendered on — the f32 chain buffer lives there, and a buffer
//! can only be bound to a pipeline on its own device. The surface is created from a
//! fresh `wgpu::Instance` (`SurfaceTarget::OffscreenCanvas`, the *safe* web variant
//! — wgpu reads the canvas handle itself, no `raw-window-handle` unsafe) but
//! configured with the context's EXISTING device/adapter. The `OffscreenCanvas`
//! variant stores no borrowed handle (`handle_source = None`), so the `Surface` is
//! `'static`-storable.
//!
//! ## Surface dims == image dims (parity invariant)
//!
//! `present_chain.wgsl`'s FS recovers each pixel's `(x, y)` from the fragment
//! position and indexes the f32 buffer `i = y*width + x`, so the surface MUST be
//! configured at the image's exact dims or the Bayer dither cell + the buffer index
//! desync. [`WebPresentSurface::create`] sizes the surface to the image dims; the
//! caller sizes the `OffscreenCanvas` to match (the present never rescales).
//!
//! ## Colour-space (`display-p3`)
//!
//! The live web canvas in this project is tagged **`display-p3`**. As in P1c,
//! wgpu-23 hardcodes `colorSpace` absent in its own `configure()` call (→ browser
//! default `srgb`), so after wgpu configures the surface we re-`configure()` the
//! SAME canvas context to `display-p3`, reusing wgpu's device/format read back via
//! `getConfiguration()`. The dance runs through `js_sys` on untyped values (see
//! [`crate::present_web_colorspace::retag_display_p3_context`]) — NOT typed
//! `web_sys::Gpu*` bindings, which would collide with wgpu-23's vendored WebGPU
//! bindings (`duplicate string enums`). The retag is done ONCE in `create` (it
//! survives to every present: `get_current_texture` never re-configures). A failed
//! re-tag degrades to `srgb` and the present still succeeds.

use crate::context::GpuContext;
use crate::live_session::LiveSession;
use crate::present_chain_pipeline::{
    build_present_pipeline, encode_present_pass, pick_surface_format, PresentDispatchCache,
};
use wasm_bindgen::JsValue;
use web_sys::OffscreenCanvas;

/// A persistent WebGPU present surface bound to one `OffscreenCanvas` at one set of
/// image dims. Created ONCE (surface + configure + display-p3 retag + present
/// pipeline compile); every [`Self::present`] reuses all of it. The web sibling of
/// the Apple `present_chain_to_surface` — but stateful, so the per-tick path
/// recompiles nothing (the #1038 zero-recompile invariant).
pub struct WebPresentSurface {
    /// The WebGPU surface over the canvas. `'static` — the `OffscreenCanvas`
    /// variant stores no borrowed handle (wgpu copies the canvas internally).
    surface: wgpu::Surface<'static>,
    /// The chain-present pipeline (`present_chain.wgsl`) compiled for `format`.
    /// Built once; reused every present (the `GpuContext` compute pipelines persist
    /// in their `OnceCell`s, and so does this one here).
    pipeline: wgpu::RenderPipeline,
    /// The pipeline's bind-group layout (params uniform @0 + f32 chain buffer @1).
    bind_group_layout: wgpu::BindGroupLayout,
    /// Image (= surface) dims. Pinned; the present asserts the session matches.
    width: u32,
    height: u32,
    /// The colour-space tag the browser reported after the one-time retag
    /// (`"display-p3"` / `"srgb"` / `"unknown"`) — surfaced for self-reporting.
    color_space: String,
    /// Cached present-pass uniform + bind group (#1930), keyed on the sampled
    /// `chain_buf`'s identity — see [`PresentDispatchCache`] for why identity
    /// (not "build once forever") is the right cache shape: `chain_buf`
    /// alternates between the session's two persistent ping-pong buffers
    /// depending on the chain's pass-count parity. This surface has no
    /// `reconfigure` (a dims change is a whole new `WebPresentSurface`), so
    /// there's no format/layout-change path that needs to invalidate it.
    present_cache: PresentDispatchCache,
}

impl WebPresentSurface {
    /// Create the persistent present surface for `canvas` at the `LiveSession`'s
    /// dims, on `ctx`'s EXISTING device (the f32 buffer lives there). Configures the
    /// surface, re-tags it to `display-p3`, and compiles the present pipeline —
    /// ALL ONCE. `canvas` must already be sized to `(width, height)` (asserted).
    ///
    /// Async (the surface-compatible-adapter confirmation is cheap; kept async for
    /// symmetry with the wasm present flow). Returns `Err(message)` describing the
    /// first failing step.
    pub fn create(
        ctx: &GpuContext,
        canvas: &OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err(format!(
                "WebPresentSurface: invalid image size {width}x{height}"
            ));
        }
        // Validate against the DEVICE's actual texture limit BEFORE configuring
        // (#1079): a >limit configure is a fatal wgpu validation error; a clean
        // Err lets the worker fall back to the CPU render path.
        let max_dim = ctx.device.limits().max_texture_dimension_2d;
        if width > max_dim || height > max_dim {
            return Err(format!(
                "WebPresentSurface: canvas {width}x{height} exceeds the device's max \
                 texture dimension {max_dim}"
            ));
        }
        let (cw, ch) = (canvas.width(), canvas.height());
        if (cw, ch) != (width, height) {
            return Err(format!(
                "WebPresentSurface: canvas {cw}x{ch} != image {width}x{height} (caller must size \
                 the OffscreenCanvas to the uploaded image — the present never rescales)"
            ));
        }

        let instance = wgpu::Instance::default();
        // `SurfaceTarget::OffscreenCanvas` is the safe web variant — wgpu reads the
        // canvas handle itself; no `raw-window-handle` unsafe juggling.
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .map_err(|e| format!("create_surface(OffscreenCanvas) failed: {e}"))?;

        // Reuse the context's adapter (the live chain rendered on its device).
        let caps = surface.get_capabilities(&ctx.adapter);
        if caps.formats.is_empty() {
            return Err("WebPresentSurface: surface advertised no formats".to_string());
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

        // One-time display-p3 retag (gated; see module docs). `get_context("webgpu")`
        // hands back the SAME singleton context wgpu configured; we re-tag it through
        // untyped `js_sys`. Survives every subsequent present (`get_current_texture`
        // never re-configures). A failure degrades to `srgb`.
        let color_space = match canvas.get_context("webgpu") {
            Ok(Some(obj)) => {
                crate::present_web_colorspace::retag_display_p3_context(&JsValue::from(obj))
            }
            _ => "unknown".to_string(),
        };

        let (pipeline, bind_group_layout) = build_present_pipeline(ctx, format);

        Ok(Self {
            surface,
            pipeline,
            bind_group_layout,
            width,
            height,
            color_space,
            present_cache: PresentDispatchCache::new(),
        })
    }

    /// The achieved canvas colour-space tag from the one-time retag.
    pub fn color_space(&self) -> &str {
        &self.color_space
    }

    /// Present the live chain's resident f32 buffer (`session`'s ping-pong index
    /// `final_idx`, left by [`LiveSession::render_chain_to_f32_async`]) to the held
    /// surface — the dithered/quantized 8-bit display surface, NO CPU readback,
    /// recompiling NOTHING. Asserts `session` dims == the surface dims.
    pub fn present(
        &self,
        ctx: &GpuContext,
        session: &LiveSession,
        final_idx: usize,
    ) -> Result<(), String> {
        let dims = session.dims();
        if dims != (self.width, self.height) {
            return Err(format!(
                "WebPresentSurface::present: session {}x{} != surface {}x{}",
                dims.0, dims.1, self.width, self.height
            ));
        }
        let chain_buf = session.ping_pong_buffer(final_idx);
        // Get-or-build the present dispatch for THIS chain buffer identity
        // (#1930) — a same-identity re-present (the steady state while
        // dragging one slider) is zero-alloc; only an identity change (a
        // pass-count parity flip, or a re-open's fresh buffers) rebuilds.
        let (_uniform, bind_group) =
            self.present_cache
                .get_or_build(ctx, &self.bind_group_layout, chain_buf, (self.width, self.height));
        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| format!("WebPresentSurface: get_current_texture failed: {e}"))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("present-chain-web-encoder"),
            });
        encode_present_pass(&mut encoder, &self.pipeline, &bind_group, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}
