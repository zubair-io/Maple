//! Chain-output present — the live chain's final f32 buffer → a display surface
//! (epic #925, P4b-apple #1028).
//!
//! The colour-correct counterpart of P1b's [`crate::present`] passthrough proof.
//! Where `present_test_pattern` draws a deterministic four-quadrant pattern, this
//! module SAMPLES the [`LiveSession`]'s final f32-RGBA chain output (the sRGB-
//! gamma-encoded sRGB-primary buffer left resident by
//! [`LiveSession::render_chain_to_f32`]) and writes the dithered/quantized 8-bit
//! result to a surface texture — the storage-buffer→surface-texture seam.
//!
//! ## The device is the session's, not a fresh one
//!
//! Unlike `present_test_pattern` (a self-contained one-shot that owns its own
//! instance/adapter/device), this present MUST run on the SAME [`GpuContext`]
//! device the [`LiveSession`] rendered on — the f32 chain buffer lives there, and
//! a buffer can only be bound to a pipeline on its own device. So the surface is
//! created from a fresh `wgpu::Instance` but configured with the context's
//! existing device/adapter via [`present_chain_to_surface`]. The render pass runs
//! the [`crate::present_chain`] WGSL (a fullscreen-triangle FS doing the exact
//! `dither_and_quantize` math; see `present_chain.wgsl`).
//!
//! ## Surface dims == image dims (parity invariant)
//!
//! The FS recovers each pixel's `(x, y)` from the fragment position and indexes
//! the f32 buffer `i = y*width + x`, so the surface MUST be configured at the
//! image's exact dims or the Bayer dither cell + the buffer index desync. Both
//! entry points assert `surface_dims == image_dims`. (The caller resizes the
//! image to the viewport BEFORE uploading it to the `LiveSession` — the present
//! never rescales.)
//!
//! Apple-only (gated with [`crate::present`] on `target_vendor = "apple"`): the
//! surface variant uses wgpu's `CoreAnimationLayer` target. The offscreen test
//! entry ([`present_chain_to_offscreen`]) is host-only (any native target) — it
//! renders to an owned `Bgra8Unorm` texture and reads it back so the parity gate
//! needs no `CAMetalLayer`.
//!
//! ## Persistent surface (#1742 — the half-render seam)
//!
//! [`PersistentPresentSurface`] is the Apple counterpart of
//! [`crate::present_chain_web::WebPresentSurface`]: the `wgpu::Surface` (+its
//! present pipeline) is created and `configure`d ONCE per `(CAMetalLayer*, dims)`
//! and cached across every present, instead of being torn down and rebuilt on
//! every single call. The pre-#1742 shape called `create_surface_unsafe` +
//! `surface.configure()` fresh on EVERY present against the SAME persistent
//! `CAMetalLayer` — the only such pattern in the codebase (the web sibling and
//! the P1b test-pattern proof both cache). Reconfiguring a live Metal drawable
//! every frame leaves the compositor mid-transition on the very first present: a
//! freshly `configure`d `CAMetalLayer` starts with an undefined/black drawable
//! pool, so the FIRST frame after a configure can land on a drawable Core
//! Animation hasn't fully handed off yet, splicing old and new content at
//! whatever scanline the compositor happened to be partway through — a stale
//! lower region under a freshly-drawn upper region, sticky to that first
//! present. [`present_chain_to_surface`] reconfigures only when the
//! layer identity or the image dims actually change, and always draws AND
//! presents twice immediately after a (re)configure, so the second present lands
//! on a fully handed-off drawable and the caller-visible frame is always
//! complete.
//!
//! The cache lives on the FFI handle (`LiveHandleInner` in `raw-ffi`), not here —
//! this module only owns the type and the create/reconfigure/present logic.

use crate::context::GpuContext;
use crate::live_session::LiveSession;
// The device-agnostic pipeline + pass-encode helpers are shared with the web
// present (`present_chain_web.rs`) via this module so the dither/quantize draw and
// the bind-group layout are single-sourced across Apple `CAMetalLayer` + web
// `OffscreenCanvas` + the host offscreen parity gate.
use crate::present_chain_pipeline::{
    build_present_dispatch, build_present_pipeline, encode_present_pass, pick_surface_format,
    PresentDispatchCache,
};
use std::ffi::c_void;

/// A persistent `CAMetalLayer` present surface, cached across presents (#1742).
/// Bound to one `(layer pointer, width, height)` triple at a time; created once,
/// reconfigured ONLY when that identity changes. Mirrors
/// [`crate::present_chain_web::WebPresentSurface`]'s zero-recompile shape on the
/// Apple side, where the analogous risk is a per-frame Metal surface
/// reconfiguration rather than a per-tick WebGPU one.
#[cfg(target_vendor = "apple")]
pub struct PersistentPresentSurface {
    surface: wgpu::Surface<'static>,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    /// Identity of the `CAMetalLayer*` this surface was created from, stored as
    /// an address token (`usize`, never dereferenced) so the cache stays `Send`
    /// for the process-wide shared slot (#1769). A present against a DIFFERENT
    /// layer pointer (a new view/window) forces a fresh surface — reusing a
    /// surface across layers is not a supported wgpu shape.
    layer: usize,
    /// The host-supplied surface GENERATION this surface was created under
    /// (#1769). The Swift host bumps it whenever the canvas layer's identity or
    /// external state changes in a way wgpu cannot see — a new `CAMetalLayer`
    /// registered on the driver (covers malloc address reuse / the ABA hazard a
    /// raw-pointer key has), or a host-detected `drawableSize` divergence from
    /// the configured extent. A generation mismatch forces a fresh surface +
    /// the settle double-present, exactly like a layer-pointer change.
    generation: u64,
    /// Cached present-pass uniform + bind group (#1930), keyed on the sampled
    /// `chain_buf`'s identity — see [`PresentDispatchCache`] for why identity
    /// (not "build once forever") is the right cache shape here: `chain_buf`
    /// alternates between the session's two persistent ping-pong buffers
    /// depending on the chain's pass-count parity. Invalidated on every
    /// `reconfigure` (a format/layout change would otherwise leave a
    /// bind-group cached against the OLD layout).
    present_cache: PresentDispatchCache,
}

#[cfg(target_vendor = "apple")]
impl PersistentPresentSurface {
    /// Create + configure a new surface from `layer` at `(width, height)` on
    /// `ctx`'s existing device/adapter/instance. Does NOT present — the caller
    /// (`present`) draws into it after construction.
    fn create(
        ctx: &GpuContext,
        layer: *mut c_void,
        width: u32,
        height: u32,
        generation: u64,
    ) -> Result<Self, String> {
        // Create the surface from the CONTEXT's instance, not a fresh one (#1240).
        // Adapters belong to the instance that produced them; a surface from a
        // sibling instance + `get_capabilities(&ctx.adapter)` panics with
        // `Adapter[Id(…)] does not exist` because wgpu's hub registry is
        // per-instance.
        //
        // SAFETY: `layer` is a valid, non-null CAMetalLayer* per the caller's
        // contract (checked in `present` before this is called), and it must
        // outlive this cached surface — the FFI contract requires the Swift host
        // to keep the `NSView`/layer alive for the life of the `MapleGpuLiveSession`
        // handle this surface is cached on.
        let surface = unsafe {
            ctx.instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
                .map_err(|e| format!("create_surface_unsafe failed: {e}"))?
        };

        // Now `surface` and `ctx.adapter` share the same instance, so this is safe.
        let caps = surface.get_capabilities(&ctx.adapter);
        if caps.formats.is_empty() {
            return Err("surface advertised no formats".to_string());
        }
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
            layer: layer as usize,
            generation,
            present_cache: PresentDispatchCache::new(),
        })
    }

    /// Reconfigure the EXISTING surface (same layer identity) at new dims —
    /// cheaper than a full teardown/recreate since the `Surface` handle and
    /// adapter capabilities are already known; only the swapchain + the
    /// format-dependent present pipeline are rebuilt.
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
        // Dims changed the uniform's content and a format change would have
        // rebuilt the bind-group layout — either way the cached present
        // dispatch (if any) is stale; force the next present to rebuild it.
        self.present_cache.invalidate();
    }

    /// Draw the session's final f32 chain buffer into the surface's current
    /// drawable and present it. No configure — pure per-frame draw work.
    fn draw_and_present(
        &self,
        ctx: &GpuContext,
        session: &LiveSession,
        final_idx: usize,
    ) -> Result<(), String> {
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
            .map_err(|e| format!("get_current_texture failed: {e}"))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("present-chain-encoder"),
            });
        encode_present_pass(&mut encoder, &self.pipeline, &bind_group, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}

/// Present the live chain's final f32 buffer (left resident by
/// [`LiveSession::render_chain_to_f32`] at ping-pong index `final_idx`) into
/// `layer` (a `CAMetalLayer*`) — the dithered/quantized 8-bit display surface,
/// with NO CPU readback.
///
/// `cache` is the caller-owned [`PersistentPresentSurface`] slot. Since #1769 it
/// is PROCESS-WIDE (raw-ffi's `GPU_SHARED`), not per-FFI-handle: the fast→refine
/// re-open boundary (a new `MapleGpuLiveSession` at new dims every cold open)
/// must RECONFIGURE the existing surface rather than destroy the old
/// surface+device pair against the live layer and race a fresh one — the exact
/// splice window the iPad report pinned. The cache key is
/// `(generation, layer, dims)`: `generation` is the host-supplied token bumped on
/// canvas re-registration or host-detected `drawableSize` divergence (see
/// [`PersistentPresentSurface::generation`]); a generation or layer change forces
/// a fresh create, a dims-only change reconfigures in place — see the module docs
/// for why per-present reconfiguration produced the #1742 seam.
/// Immediately after any create/reconfigure, a SECOND frame is drawn and
/// presented before returning, so the caller-visible present is always a
/// complete frame against a fully handed-off drawable (Core Animation's
/// mid-transition window is the first frame after a configure, not the second).
///
/// A failed present (either draw call above) clears `*cache` before returning
/// the `Err`, so a broken cached surface (e.g. a swapchain lost/outdated by a
/// display change) is never retried — the NEXT call recreates it from scratch
/// instead of failing forever on the same poisoned surface. This path requires
/// a live `CAMetalLayer` to exercise (a `get_current_texture` failure isn't
/// reachable through the offscreen oracle in `present_chain/tests.rs`, which has
/// no `CAMetalLayer`), so it is covered by the Apple XCUITest visual harness
/// instead of a unit test here.
///
/// # Safety
/// `layer` must be a valid, non-null `CAMetalLayer*` that outlives `cache` (i.e.
/// outlives the `MapleGpuLiveSession` handle this cache is stored on) for as long
/// as the SAME layer pointer keeps being passed in.
#[cfg(target_vendor = "apple")]
pub unsafe fn present_chain_to_surface(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
    layer: *mut c_void,
    cache: &mut Option<PersistentPresentSurface>,
    generation: u64,
) -> Result<(), String> {
    if layer.is_null() {
        return Err("present_chain: layer pointer is null".to_string());
    }
    let (width, height) = session.dims();
    if width == 0 || height == 0 {
        return Err(format!(
            "present_chain: invalid image size {width}x{height}"
        ));
    }
    // Validate the surface dims against the DEVICE's actual texture limit BEFORE
    // configuring (#1079): a >limit configure trips wgpu's `handle_error_fatal`
    // panic, which unwinds through the `extern "C"` FFI and aborts the app. A
    // clean Err lets the Swift host fall back to the CPU render path instead.
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

    let just_configured = if needs_fresh_surface {
        // Drop any stale surface BEFORE creating its replacement: if the
        // caller swapped CAMetalLayers (or bumped the generation over a
        // suspect surface), the old wgpu::Surface is bound to a
        // possibly-destroyed layer and must not outlive a failed create.
        // Deterministic teardown-then-create, never two surfaces (two
        // devices) racing on the same live layer.
        *cache = None;
        *cache = Some(PersistentPresentSurface::create(
            ctx, layer, width, height, generation,
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
        // A failed present (e.g. `get_current_texture` erroring because the
        // swapchain was lost/outdated from a display change) leaves the cached
        // surface in a broken state. Drop it so the NEXT call's
        // `needs_fresh_surface` check is forced true and a fresh surface gets
        // created from scratch, instead of permanently failing on every
        // subsequent present against a surface that can never recover.
        *cache = None;
        return Err(e);
    }
    if just_configured {
        // First frame after (re)configure can land on a drawable Core Animation
        // hasn't fully handed off yet (the #1742 seam). A second present against
        // the now-settled swapchain guarantees the caller-visible frame is whole.
        let surface = cache.as_ref().expect("populated above");
        if let Err(e) = surface.draw_and_present(ctx, session, final_idx) {
            // Same cache-poisoning guard as the first present above.
            *cache = None;
            return Err(e);
        }
    }
    Ok(())
}

/// Host-only sibling of [`present_chain_to_surface`]: run the SAME present pass
/// (the dither/quantize FS) into an OWNED `Bgra8Unorm` texture on `ctx.device`,
/// read it back, and return the flat row-major `3·w·h` u8 RGB bytes (alpha
/// dropped — the `dither_and_quantize` layout). The autonomous parity path: it
/// exercises the exact present shader with NO `CAMetalLayer`, so the host gate can
/// diff it against the CPU `render` + `dither_and_quantize` reference.
///
/// `final_idx` is the ping-pong index [`LiveSession::render_chain_to_f32`]
/// returned. Native blocking (drives the readback via pollster). Fallible
/// (#1079): dims beyond the device's texture limit and a failed readback map
/// surface as `Err` instead of a wgpu panic.
#[cfg(not(target_arch = "wasm32"))]
pub fn present_chain_to_offscreen(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
) -> Result<Vec<u8>, String> {
    let (width, height) = session.dims();
    let max_dim = ctx.device.limits().max_texture_dimension_2d;
    if width == 0 || height == 0 || width > max_dim || height > max_dim {
        return Err(format!(
            "present_chain_to_offscreen: target {width}x{height} outside the device's \
             supported texture dimensions (1..={max_dim})"
        ));
    }
    let format = wgpu::TextureFormat::Bgra8Unorm;
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("present-chain-offscreen"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let (pipeline, bgl) = build_present_pipeline(ctx, format);
    let chain_buf = session.ping_pong_buffer(final_idx);
    // One-shot host oracle call, not a render-loop tick — build fresh directly
    // (no cache needed; #1930's zero-alloc invariant is about the PER-TICK
    // present path, which this parity harness isn't).
    let dispatch = build_present_dispatch(ctx, &bgl, chain_buf, (width, height));

    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("present-chain-offscreen-encoder"),
        });
    encode_present_pass(&mut encoder, &pipeline, &dispatch.bind_group, &view);

    // Copy the rendered texture to a padded readback buffer (wgpu requires the
    // bytes-per-row to be 256-aligned for texture→buffer copies).
    let bytes_per_pixel = 4u32; // Bgra8Unorm
    let unpadded_bpr = width * bytes_per_pixel;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bpr = unpadded_bpr.div_ceil(align) * align;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("present-chain-offscreen-readback"),
        size: (padded_bpr as u64) * (height as u64),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &readback,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(padded_bpr),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    ctx.queue.submit(Some(encoder.finish()));

    let padded = pollster::block_on(map_u8_readback(ctx, &readback))?;
    // Unpad rows and drop the surface's BGRA→RGB (Bgra8Unorm stores B,G,R,A per
    // texel; the canonical `dither_and_quantize` layout is R,G,B), yielding the
    // flat 3·w·h RGB bytes the parity test compares.
    let mut out = vec![0u8; (width as usize) * (height as usize) * 3];
    for y in 0..(height as usize) {
        let row = &padded[y * (padded_bpr as usize)..];
        for x in 0..(width as usize) {
            let texel = &row[x * 4..x * 4 + 4];
            let dst = ((y * (width as usize)) + x) * 3;
            // Bgra8Unorm: texel = [B, G, R, A] → RGB.
            out[dst] = texel[2];
            out[dst + 1] = texel[1];
            out[dst + 2] = texel[0];
        }
    }
    Ok(out)
}

/// Map a `MAP_READ` staging buffer and copy its bytes out. Native polls the queue
/// to resolve the map. The u8 sibling of the chain/dither readbacks. A failed
/// `map_async` (device loss / OOM) is an `Err`, not a panic (#1079).
#[cfg(not(target_arch = "wasm32"))]
async fn map_u8_readback(ctx: &GpuContext, readback: &wgpu::Buffer) -> Result<Vec<u8>, String> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .map_err(|_| "present-chain readback: map channel dropped".to_string())?
        .map_err(|e| format!("present-chain readback: buffer map failed: {e}"))?;
    let data = slice.get_mapped_range();
    let out = data.to_vec();
    drop(data);
    readback.unmap();
    Ok(out)
}

// Host parity tests live in a sibling file (600-LOC budget). Native test builds
// only — the offscreen present + its CPU oracle diff have no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "present_chain/tests.rs"]
mod tests;
