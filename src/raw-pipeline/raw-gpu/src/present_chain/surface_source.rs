//! The present surface's per-source draw and its configure-on-demand, split
//! out of `present_chain.rs` (file budget). Shared by the live chain's
//! present and the canvas placeholder's (#5758).

use super::{encode_present_pass, PersistentPresentSurface, PresentGeometry};
use crate::context::GpuContext;
use crate::live_session::LiveSession;
use std::ffi::c_void;

impl PersistentPresentSurface {
    /// Draw `source` into the reserved drawable and present it. Allocates
    /// nothing once the source's dispatch is cached.
    pub(super) fn present_reserved_source(
        &self,
        ctx: &GpuContext,
        source: PresentSource<'_>,
        geometry: PresentGeometry,
        frame: wgpu::SurfaceTexture,
    ) {
        // Preserve Apple's existing policy of releasing the previous source's
        // dispatch bindings on a switch. The stable key protects all targets
        // without changing this surface's session-lifetime policy.
        if self.last_session.replace(source.identity.0) != source.identity.0 {
            self.present_cache.invalidate();
        }
        // Both persistent ping-pong directions stay cached, so crossing a
        // slider's no-op threshold does not rebuild the present dispatch.
        let (_uniform, bind_group) = self.present_cache.get_or_build_scaled(
            ctx,
            &self.bind_group_layout,
            source.buffer,
            source.identity,
            ((self.width, self.height), source.dims),
            geometry,
        );
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("present-chain-encoder"),
            });
        if let Some((session, final_idx)) = source.histogram {
            session.histogram.encode(ctx, &mut encoder, final_idx);
        }
        encode_present_pass(&mut encoder, &self.pipeline, &bind_group, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
    }

    /// Make `cache` a surface for `layer` at `dims`: a new layer or
    /// generation creates one, new dims reconfigure it in place. Returns
    /// whether it was just (re)configured, which the caller settles with a
    /// second present (see [`present_chain_to_surface`]).
    pub(super) fn ensure(
        ctx: &GpuContext,
        layer: *mut c_void,
        cache: &mut Option<Self>,
        generation: u64,
        dims: (u32, u32),
    ) -> Result<bool, String> {
        if layer.is_null() {
            return Err("present_chain: layer pointer is null".to_string());
        }
        let (width, height) = dims;
        if width == 0 || height == 0 {
            return Err(format!(
                "present_chain: invalid image size {width}x{height}"
            ));
        }
        // Validate the surface dims against the DEVICE's actual texture limit
        // BEFORE configuring (#1079): a >limit configure trips wgpu's
        // `handle_error_fatal` panic, which unwinds through the `extern "C"`
        // FFI and aborts the app. A clean Err lets the Swift host fall back.
        let max_dim = ctx.device.limits().max_texture_dimension_2d;
        if width > max_dim || height > max_dim {
            return Err(format!(
                "present_chain: surface {width}x{height} exceeds the device's max texture \
                 dimension {max_dim}"
            ));
        }
        let needs_fresh_surface = match cache {
            Some(existing) => existing.layer != layer as usize || existing.generation != generation,
            None => true,
        };
        if needs_fresh_surface {
            // Drop any stale surface BEFORE creating its replacement: if the
            // caller swapped CAMetalLayers (or bumped the generation over a
            // suspect surface), the old wgpu::Surface is bound to a
            // possibly-destroyed layer and must not outlive a failed create.
            // Deterministic teardown-then-create, never two surfaces (two
            // devices) racing on the same live layer.
            *cache = None;
            *cache = Some(Self::create(ctx, layer, width, height, generation)?);
            return Ok(true);
        }
        let existing = cache.as_mut().expect("checked Some above");
        if (existing.width, existing.height) == dims {
            return Ok(false);
        }
        existing.reconfigure(ctx, width, height);
        Ok(true)
    }

    pub(super) fn acquire(&self) -> Result<wgpu::SurfaceTexture, String> {
        self.surface
            .get_current_texture()
            .map_err(|error| format!("get_current_texture failed: {error}"))
    }
}

/// What one present draws: a display-encoded f32 RGBA buffer, the identity
/// its dispatch is cached under, its dims when they differ from the surface
/// (`(0, 0)` = equal, the 1:1 load), and the live session whose displayed
/// histogram rides the same submit, if any.
#[cfg(target_vendor = "apple")]
pub(super) struct PresentSource<'a> {
    pub(super) buffer: &'a wgpu::Buffer,
    pub(super) identity: (u64, usize),
    pub(super) dims: (u32, u32),
    pub(super) histogram: Option<(&'a LiveSession, usize)>,
}
