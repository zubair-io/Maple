//! The Apple overlay surface: a `CAMetalLayer` of its own, above the image
//! layer, configured once per `(layer, generation, dims)` like
//! [`crate::PersistentPresentSurface`] and redrawn on every overlay change.
//!
//! One surface is cached per process: two overlay layers presenting at once
//! (two editor windows in crop) would each recreate it. wgpu retains the
//! layer, so the host releases the cache when its overlay layer goes away.

use super::{pick_overlay_alpha_mode, pick_overlay_format, OverlayParams, OverlayPipeline};
use crate::context::GpuContext;
use std::ffi::c_void;

/// A cached overlay surface. `layer` is the layer's address, kept only to
/// detect a different layer; the `wgpu::Surface` holds its own reference.
pub struct PersistentOverlaySurface {
    surface: wgpu::Surface<'static>,
    pipeline: OverlayPipeline,
    alpha_mode: wgpu::CompositeAlphaMode,
    width: u32,
    height: u32,
    layer: usize,
    generation: u64,
}

impl PersistentOverlaySurface {
    fn create(
        ctx: &GpuContext,
        layer: *mut c_void,
        width: u32,
        height: u32,
        generation: u64,
    ) -> Result<Self, String> {
        // SAFETY: `layer` is a non-null CAMetalLayer* that outlives the cache,
        // per `present_overlay_to_surface`'s contract.
        let surface = unsafe {
            ctx.instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
                .map_err(|e| format!("overlay create_surface_unsafe failed: {e}"))?
        };
        let caps = surface.get_capabilities(&ctx.adapter);
        let format = pick_overlay_format(&caps.formats)
            .ok_or_else(|| "overlay surface has no 8-bit unorm format".to_string())?;
        let alpha_mode = pick_overlay_alpha_mode(&caps.alpha_modes)
            .ok_or_else(|| "overlay surface cannot composite transparently".to_string())?;
        let overlay = Self {
            surface,
            pipeline: OverlayPipeline::new(ctx, format),
            alpha_mode,
            width,
            height,
            layer: layer as usize,
            generation,
        };
        overlay.configure(ctx);
        Ok(overlay)
    }

    fn configure(&self, ctx: &GpuContext) {
        self.surface.configure(
            &ctx.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: self.pipeline.format(),
                width: self.width,
                height: self.height,
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: self.alpha_mode,
                view_formats: vec![],
            },
        );
    }

    fn draw(&self, ctx: &GpuContext, params: &OverlayParams) -> Result<(), String> {
        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| format!("overlay get_current_texture failed: {e}"))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("canvas-overlay-encoder"),
            });
        self.pipeline.encode(ctx, &mut encoder, params, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}

/// Draw `params` into `layer` at `width × height` pixels. A new layer or
/// generation creates the surface; a dims change reconfigures it; either is
/// followed by a second present so the visible frame lands on a settled
/// drawable, the same settle rule as the image present. A failure clears the
/// cache so the next call starts fresh.
///
/// # Safety
/// `layer` must be a valid, non-null `CAMetalLayer*` that outlives `cache`
/// for as long as the same pointer keeps being passed.
pub unsafe fn present_overlay_to_surface(
    ctx: &GpuContext,
    layer: *mut c_void,
    cache: &mut Option<PersistentOverlaySurface>,
    generation: u64,
    (width, height): (u32, u32),
    params: &OverlayParams,
) -> Result<(), String> {
    if layer.is_null() {
        return Err("present_overlay: layer pointer is null".to_string());
    }
    let max_dim = ctx.device.limits().max_texture_dimension_2d;
    if width == 0 || height == 0 || width > max_dim || height > max_dim {
        return Err(format!(
            "present_overlay: surface {width}x{height} outside 1..={max_dim}"
        ));
    }
    let reusable = cache
        .take()
        .filter(|existing| existing.layer == layer as usize && existing.generation == generation);
    let (surface, just_configured) = match reusable {
        Some(mut existing) if (existing.width, existing.height) != (width, height) => {
            existing.width = width;
            existing.height = height;
            existing.configure(ctx);
            (existing, true)
        }
        Some(existing) => (existing, false),
        None => (
            PersistentOverlaySurface::create(ctx, layer, width, height, generation)?,
            true,
        ),
    };
    let surface = cache.insert(surface);
    let result = surface.draw(ctx, params).and_then(|()| {
        if just_configured {
            surface.draw(ctx, params)
        } else {
            Ok(())
        }
    });
    if result.is_err() {
        *cache = None;
    }
    result
}

/// Drop the cached surface if it belongs to `generation`, releasing wgpu's
/// reference to that overlay layer and its drawables.
pub fn release_overlay_surface(cache: &mut Option<PersistentOverlaySurface>, generation: u64) {
    if cache
        .as_ref()
        .is_some_and(|existing| existing.generation == generation)
    {
        *cache = None;
    }
}
