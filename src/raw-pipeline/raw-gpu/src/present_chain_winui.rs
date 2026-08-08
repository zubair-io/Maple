//! Chain-output present for the Windows WinUI 3 host (#2561): the live chain's
//! final f32 buffer → a DXGI composition swapchain bound to a `SwapChainPanel`.
//!
//! The Windows twin of `present_chain.rs`'s Apple `CAMetalLayer` path, sharing
//! the device-agnostic dither/quantize pipeline (`present_chain_pipeline`) so
//! the drawn pixels are single-sourced across Apple + web + Windows. The wgpu
//! surface target is [`wgpu::SurfaceTargetUnsafe::SwapChainPanel`]: wgpu's DX12
//! HAL creates the composition swapchain (`CreateSwapChainForComposition`,
//! FLIP_DISCARD) and calls `ISwapChainPanelNative::SetSwapChain` itself, so the
//! host never touches DXGI directly.
//!
//! The pointer the host passes is an **`ISwapChainPanelNative*`** (the WinUI 3 /
//! Windows App SDK `Microsoft.UI.Xaml.Media.DXInterop` interface, IID
//! `63AAD0B8-7C24-40FF-85A8-640D944CC325`) obtained by QI on the
//! `SwapChainPanel`, NOT the panel's IInspectable. wgpu takes its own COM
//! reference for the surface's lifetime.
//!
//! Cache semantics are identical to the Apple path (#1742/#1769): the surface is
//! process-wide, keyed on `(generation, panel, dims)`; a panel/generation change
//! forces a deterministic teardown-then-create, a dims-only change reconfigures
//! in place, and every (re)configure is followed by a settle double-present so
//! the caller-visible frame lands on a fully handed-off flip-model buffer. A
//! failed present clears the cache so a lost/outdated swapchain (display change,
//! device removal) is recreated on the next call instead of failing forever.

#![cfg(all(target_os = "windows", not(target_arch = "wasm32")))]

use crate::context::GpuContext;
use crate::live_session::LiveSession;
use crate::present_chain_pipeline::{
    build_present_pipeline, encode_present_pass, pick_surface_format, PresentDispatchCache,
};
use std::ffi::c_void;

/// A persistent `SwapChainPanel` present surface, cached across presents.
/// Bound to one `(panel pointer, generation, width, height)` at a time; created
/// once, reconfigured only when that identity changes — the same zero-per-tick-
/// reconfiguration shape as [`crate::PersistentPresentSurface`] on Apple.
pub struct PersistentSwapChainPanelSurface {
    surface: wgpu::Surface<'static>,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    /// Identity of the `ISwapChainPanelNative*` this surface was created from,
    /// stored as an address token (`usize`, never dereferenced) so the cache
    /// stays `Send` for the process-wide shared slot.
    panel: usize,
    /// Host-supplied generation: bumped when the host registers a DIFFERENT
    /// `SwapChainPanel` (covers COM pointer reuse) or detects external state
    /// wgpu cannot see (composition-scale change). A mismatch forces a fresh
    /// surface + the settle double-present, exactly like a panel change.
    generation: u64,
    /// Cached present-pass uniform + bind group keyed on the sampled
    /// `chain_buf` identity (the ping-pong parity), invalidated on reconfigure.
    present_cache: PresentDispatchCache,
}

impl PersistentSwapChainPanelSurface {
    /// Create + configure a new surface from `panel` at `(width, height)` on
    /// `ctx`'s existing device/adapter/instance (never a sibling instance —
    /// adapters belong to the instance that produced them, #1240).
    ///
    /// # Safety
    /// `panel` must be a valid, non-null `ISwapChainPanelNative*` outliving this
    /// cached surface — the FFI contract requires the host to keep the
    /// `SwapChainPanel` alive for as long as the same pointer keeps being passed.
    unsafe fn create(
        ctx: &GpuContext,
        panel: *mut c_void,
        width: u32,
        height: u32,
        generation: u64,
    ) -> Result<Self, String> {
        let surface = ctx
            .instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::SwapChainPanel(panel))
            .map_err(|e| format!("create_surface_unsafe(SwapChainPanel) failed: {e}"))?;

        let caps = surface.get_capabilities(&ctx.adapter);
        if caps.formats.is_empty() {
            // The classic symptom of a non-DX12 adapter (the SwapChainPanel
            // surface only carries a DX12 handle) — see GpuContext::new_async's
            // Windows backend pin.
            return Err("surface advertised no formats (adapter is not DX12?)".to_string());
        }
        // MUST be a non-sRGB format: the present shader's dither/quantize output
        // is already gamma-encoded, and an `*Srgb` view would apply a second
        // OETF on store (see present_chain_pipeline::pick_surface_format).
        let format = pick_surface_format(&caps);

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

        let (pipeline, bind_group_layout) = build_present_pipeline(ctx, format);

        Ok(Self {
            surface,
            pipeline,
            bind_group_layout,
            format,
            width,
            height,
            panel: panel as usize,
            generation,
            present_cache: PresentDispatchCache::new(),
        })
    }

    /// Reconfigure the EXISTING surface (same panel identity) at new dims.
    fn reconfigure(&mut self, ctx: &GpuContext, width: u32, height: u32) {
        let caps = self.surface.get_capabilities(&ctx.adapter);
        let format = pick_surface_format(&caps);
        self.surface.configure(
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
        if format != self.format {
            let (pipeline, bgl) = build_present_pipeline(ctx, format);
            self.pipeline = pipeline;
            self.bind_group_layout = bgl;
            self.format = format;
        }
        self.width = width;
        self.height = height;
        self.present_cache.invalidate();
    }

    /// Draw the session's final f32 chain buffer into the surface's current
    /// backbuffer and present it. No configure — pure per-frame draw work.
    /// When the session is SMALLER than the surface (#2587's half-res fast
    /// pass into the fixed full-size surface), the present shader upscales
    /// bilinearly — the surface never reconfigures across phase swaps.
    fn draw_and_present(
        &self,
        ctx: &GpuContext,
        session: &LiveSession,
        final_idx: usize,
    ) -> Result<(), String> {
        let chain_buf = session.ping_pong_buffer(final_idx);
        let (sw, sh) = session.dims();
        let src_dims = if (sw, sh) == (self.width, self.height) {
            (0, 0) // 1:1 — the parity-critical legacy path
        } else {
            (sw, sh)
        };
        let (_uniform, bind_group) = self.present_cache.get_or_build_scaled(
            ctx,
            &self.bind_group_layout,
            chain_buf,
            (self.width, self.height),
            src_dims,
        );
        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| format!("get_current_texture failed: {e}"))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("present-chain-winui-encoder"),
            });
        encode_present_pass(&mut encoder, &self.pipeline, &bind_group, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}

/// Present the live chain's final f32 buffer (left resident by
/// [`LiveSession::render_chain_to_f32`] at ping-pong index `final_idx`) into
/// the composition swapchain bound to `panel` — no CPU readback.
///
/// The surface dims are the SESSION dims: the present never rescales, and the
/// SwapChainPanel surface has no `current_extent`, so the host must size the
/// decoded image to the panel's physical pixels (`ActualSize × CompositionScale`)
/// before opening the session.
///
/// # Safety
/// `panel` must be a valid, non-null `ISwapChainPanelNative*` that outlives
/// `cache` for as long as the same pointer keeps being passed in.
pub unsafe fn present_chain_to_swapchain_panel(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
    panel: *mut c_void,
    cache: &mut Option<PersistentSwapChainPanelSurface>,
    generation: u64,
) -> Result<(), String> {
    present_chain_to_swapchain_panel_scaled(ctx, session, final_idx, panel, cache, generation, 0, 0)
}

/// [`present_chain_to_swapchain_panel`] with an explicit SURFACE size
/// (#2587): the surface stays configured at `(target_w, target_h)` while
/// sessions of any smaller size present into it via the shader's bilinear
/// upscale — so the half-res fast pass and the full-res refine share ONE
/// configured swapchain and phase swaps never pay a reconfigure.
/// `target_w/target_h = 0` falls back to the session dims (the old behavior).
///
/// # Safety
/// As for [`present_chain_to_swapchain_panel`].
#[allow(clippy::too_many_arguments)]
pub unsafe fn present_chain_to_swapchain_panel_scaled(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
    panel: *mut c_void,
    cache: &mut Option<PersistentSwapChainPanelSurface>,
    generation: u64,
    target_w: u32,
    target_h: u32,
) -> Result<(), String> {
    if panel.is_null() {
        return Err("present_chain_winui: panel pointer is null".to_string());
    }
    let (session_w, session_h) = session.dims();
    if session_w == 0 || session_h == 0 {
        return Err(format!(
            "present_chain_winui: invalid image size {session_w}x{session_h}"
        ));
    }
    let (width, height) = if target_w == 0 || target_h == 0 {
        (session_w, session_h)
    } else {
        (target_w, target_h)
    };
    if session_w > width || session_h > height {
        return Err(format!(
            "present_chain_winui: session {session_w}x{session_h} larger than the \
             target surface {width}x{height} (downscale presents are not supported)"
        ));
    }
    // Validate against the device's real texture limit BEFORE configuring
    // (#1079): a >limit configure trips wgpu's fatal error handler, which would
    // unwind through the extern "C" FFI frame.
    let max_dim = ctx.device.limits().max_texture_dimension_2d;
    if width > max_dim || height > max_dim {
        return Err(format!(
            "present_chain_winui: surface {width}x{height} exceeds the device's max \
             texture dimension {max_dim}"
        ));
    }

    let needs_fresh_surface = match cache {
        Some(existing) => existing.panel != panel as usize || existing.generation != generation,
        None => true,
    };

    let just_configured = if needs_fresh_surface {
        // Deterministic teardown-then-create — never two surfaces (two
        // swapchains) racing SetSwapChain on the same live panel.
        *cache = None;
        *cache = Some(PersistentSwapChainPanelSurface::create(
            ctx, panel, width, height, generation,
        )?);
        true
    } else {
        let existing = cache.as_mut().expect("checked Some above");
        if (existing.width, existing.height) != (width, height) {
            existing.reconfigure(ctx, width, height);
            true
        } else {
            false
        }
    };

    let surface = cache.as_ref().expect("populated above");
    if let Err(e) = surface.draw_and_present(ctx, session, final_idx) {
        // Poisoned-surface guard: a lost/outdated swapchain (display change,
        // device removal) must be recreated next call, not retried forever.
        *cache = None;
        return Err(e);
    }
    if just_configured {
        // Settle double-present: the first frame after a (re)configure of a
        // flip-model composition swapchain has the same mid-handoff hazard as
        // the Core Animation drawable (#1742) — draw a second complete frame.
        let surface = cache.as_ref().expect("populated above");
        if let Err(e) = surface.draw_and_present(ctx, session, final_idx) {
            *cache = None;
            return Err(e);
        }
    }
    Ok(())
}
