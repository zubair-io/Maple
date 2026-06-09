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
use std::ffi::c_void;

/// `repr(C)` uniform for `present_chain.wgsl`: the surface/image width (the
/// row-major stride for the `(x, y)`→index recovery) + height (bounds guard).
/// `_pad*` round to 16 bytes (WGSL uniform alignment).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PresentParams {
    width: u32,
    height: u32,
    _pad0: u32,
    _pad1: u32,
}

/// Pick the surface format: the first *non-sRGB* BGRA/RGBA 8-bit the surface
/// lists (Metal's default is `Bgra8Unorm`). The FS emits the canonical unorm
/// value `dither_and_quantize` quantizes to, so a NON-sRGB surface round-trips it
/// exactly — an `*Srgb` surface would apply a second OETF on store and corrupt
/// the already-gamma-encoded pixels. Mirrors [`crate::present`]'s
/// `pick_surface_format` rationale. Re-declared here (not shared) so the two
/// present paths stay independently legible.
fn pick_surface_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
    use wgpu::TextureFormat::*;
    caps.formats
        .iter()
        .copied()
        .find(|f| matches!(f, Bgra8Unorm | Rgba8Unorm))
        .unwrap_or_else(|| caps.formats[0])
}

/// Build the chain-present render pipeline on `ctx.device` for `format`. Lays out
/// a 2-binding group (params uniform @0, f32 chain buffer @1) and a fullscreen
/// vertex+fragment from `present_chain.wgsl`. Not cached on [`GpuContext`] — the
/// present runs once per frame and the surface FORMAT can differ from the cached
/// compute pipelines' (it's render, not compute); a per-present compile of one
/// tiny shader is negligible against the chain it follows.
fn build_present_pipeline(
    ctx: &GpuContext,
    format: wgpu::TextureFormat,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let shader = ctx
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("present-chain"),
            source: wgpu::ShaderSource::Wgsl(include_str!("present_chain.wgsl").into()),
        });
    let bind_group_layout =
        ctx.device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("present-chain-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
    let layout = ctx
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("present-chain-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
    let pipeline = ctx
        .device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("present-chain-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
    (pipeline, bind_group_layout)
}

/// Record the chain-present render pass into `encoder`: bind the params uniform +
/// the f32 `chain_buf`, draw the fullscreen triangle into `target`. Shared by the
/// surface ([`present_chain_to_surface`]) and offscreen ([`present_chain_to_offscreen`])
/// entry points so the dither/quantize draw is single-sourced.
fn encode_present_pass(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::RenderPipeline,
    bind_group_layout: &wgpu::BindGroupLayout,
    chain_buf: &wgpu::Buffer,
    target: &wgpu::TextureView,
    dims: (u32, u32),
) {
    let (width, height) = dims;
    let params = PresentParams {
        width,
        height,
        _pad0: 0,
        _pad1: 0,
    };
    let uniform = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("present-chain-uniform"),
        size: std::mem::size_of::<PresentParams>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    ctx.queue
        .write_buffer(&uniform, 0, bytemuck::bytes_of(&params));
    let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("present-chain-bind-group"),
        layout: bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: chain_buf.as_entire_binding(),
            },
        ],
    });
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("present-chain-pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            ops: wgpu::Operations {
                // Distinct mid-grey so a failure to draw the triangle is visible
                // on-device (the screen would be this grey, not the image).
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: 0.5,
                    g: 0.5,
                    b: 0.5,
                    a: 1.0,
                }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    pass.draw(0..3, 0..1); // one fullscreen triangle, no buffers
}

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
        return Err(format!("present_chain: invalid image size {width}x{height}"));
    }

    let instance = wgpu::Instance::default();
    // SAFETY: `layer` is a valid CAMetalLayer* per this fn's contract; the surface
    // is used and dropped entirely within this call.
    let surface = instance
        .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
        .map_err(|e| format!("create_surface_unsafe failed: {e}"))?;

    // Reuse the context's adapter (it was requested without a compatible_surface,
    // but on Metal there is a single adapter, so it is surface-compatible). The
    // surface MUST be configured with the context's DEVICE so the f32 chain buffer
    // — bound in the present pass — is on the same device as the surface texture.
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
    encode_present_pass(ctx, &mut encoder, &pipeline, &bgl, chain_buf, &view, (width, height));
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
/// returned. Native blocking (drives the readback via pollster).
#[cfg(not(target_arch = "wasm32"))]
pub fn present_chain_to_offscreen(
    ctx: &GpuContext,
    session: &LiveSession,
    final_idx: usize,
) -> Vec<u8> {
    let (width, height) = session.dims();
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
    encode_present_pass(ctx, &mut encoder, &pipeline, &bgl, chain_buf, &view, (width, height));

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

    let padded = pollster::block_on(map_u8_readback(ctx, &readback));
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
    out
}

/// Map a `MAP_READ` staging buffer and copy its bytes out. Native polls the queue
/// to resolve the map. The u8 sibling of the chain/dither readbacks.
#[cfg(not(target_arch = "wasm32"))]
async fn map_u8_readback(ctx: &GpuContext, readback: &wgpu::Buffer) -> Vec<u8> {
    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.await
        .expect("map channel dropped")
        .expect("buffer map failed");
    let data = slice.get_mapped_range();
    let out = data.to_vec();
    drop(data);
    readback.unmap();
    out
}

// Host parity tests live in a sibling file (600-LOC budget). Native test builds
// only — the offscreen present + its CPU oracle diff have no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "present_chain/tests.rs"]
mod tests;
