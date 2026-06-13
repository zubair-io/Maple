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

use crate::context::GpuContext;
use crate::live_session::LiveSession;
// The device-agnostic pipeline + pass-encode helpers are shared with the web
// present (`present_chain_web.rs`) via this module so the dither/quantize draw and
// the bind-group layout are single-sourced across Apple `CAMetalLayer` + web
// `OffscreenCanvas` + the host offscreen parity gate.
use crate::present_chain_pipeline::{
    build_present_pipeline, encode_present_pass, pick_surface_format,
};
use std::ffi::c_void;

/// Present the live chain's final f32 buffer (left resident by
/// [`LiveSession::render_chain_to_f32`] at ping-pong index `final_idx`) into
/// `layer` (a `CAMetalLayer*`) — the dithered/quantized 8-bit display surface,
/// with NO CPU readback.
///
/// Creates a wgpu surface from `layer` configured with `ctx`'s EXISTING device
/// (the f32 buffer lives there), at the session's dims (asserted == surface dims).
/// Runs `present_chain.wgsl` and presents one frame.
///
/// # Safety
/// `layer` must be a valid, non-null `CAMetalLayer*` that outlives this call. The
/// surface created from it is dropped before this function returns.
#[cfg(target_vendor = "apple")]
pub unsafe fn present_chain_to_surface(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
    layer: *mut c_void,
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

    // Create the surface from the CONTEXT's instance, not a fresh one (#1240).
    // Adapters belong to the instance that produced them; a surface from a
    // sibling instance + `get_capabilities(&ctx.adapter)` panics with
    // `Adapter[Id(…)] does not exist` because wgpu's hub registry is
    // per-instance. The fresh-instance shape worked in unit tests against an
    // `Instance::default()` that happened to enumerate the same adapter, but
    // fails on the very first present call in production — the bug behind the
    // editor's "image disappears" report (#1240 user trace:
    // `gpu_present_chain: panicked: Adapter[Id(0,1)] does not exist`).
    //
    // SAFETY: `layer` is a valid CAMetalLayer* per this fn's contract; the surface
    // is used and dropped entirely within this call.
    let surface = ctx
        .instance
        .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
        .map_err(|e| format!("create_surface_unsafe failed: {e}"))?;

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

    let (pipeline, bgl) = build_present_pipeline(ctx, format);
    let chain_buf = session.ping_pong_buffer(final_idx);

    let frame = surface
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
    encode_present_pass(
        ctx,
        &mut encoder,
        &pipeline,
        &bgl,
        chain_buf,
        &view,
        (width, height),
    );
    ctx.queue.submit(Some(encoder.finish()));
    frame.present();
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

    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("present-chain-offscreen-encoder"),
        });
    encode_present_pass(
        ctx,
        &mut encoder,
        &pipeline,
        &bgl,
        chain_buf,
        &view,
        (width, height),
    );

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
