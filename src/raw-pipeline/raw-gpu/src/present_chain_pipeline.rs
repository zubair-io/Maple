//! Shared chain-present pipeline + pass encoding (epic #925, P4b — #1028 Apple,
//! #1029 web).
//!
//! The device-agnostic core of the chain-output present: build the
//! fullscreen-triangle render pipeline that samples the [`crate::LiveSession`]'s
//! final f32-RGBA chain buffer and runs the `dither_and_quantize` math in its FS
//! (`present_chain.wgsl`), and record that pass into a command encoder. NO surface
//! or platform handle is named here — the Apple (`CAMetalLayer`) and web
//! (`OffscreenCanvas`) entry points create/configure their own surface, then call
//! these helpers so the dither/quantize draw + the bind-group layout are
//! single-sourced across both platforms (and the host offscreen parity gate).
//!
//! Compiles on every target (it only touches `wgpu`, no platform deps), so the
//! native present (`present_chain.rs`) and the wasm present (`present_chain_web.rs`)
//! share it without duplicating the pipeline construction.

use crate::context::GpuContext;

/// `repr(C)` uniform for `present_chain.wgsl`: the surface/image width (the
/// row-major stride for the `(x, y)`→index recovery) + height (bounds guard).
/// `_pad*` round to 16 bytes (WGSL uniform alignment).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct PresentParams {
    pub width: u32,
    pub height: u32,
    pub _pad0: u32,
    pub _pad1: u32,
}

/// Pick the surface format: the first *non-sRGB* BGRA/RGBA 8-bit the surface
/// lists. The FS emits the canonical unorm value `dither_and_quantize` quantizes
/// to, so a NON-sRGB surface round-trips it exactly — an `*Srgb` surface would
/// apply a second OETF on store and corrupt the already-gamma-encoded pixels.
/// Mirrors [`crate::present`]'s `pick_surface_format` rationale.
pub(crate) fn pick_surface_format(caps: &wgpu::SurfaceCapabilities) -> wgpu::TextureFormat {
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
pub(crate) fn build_present_pipeline(
    ctx: &GpuContext,
    format: wgpu::TextureFormat,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let shader = ctx
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("present-chain"),
            source: wgpu::ShaderSource::Wgsl(include_str!("present_chain.wgsl").into()),
        });
    let bind_group_layout = ctx
        .device
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
/// surface (Apple `CAMetalLayer`, web `OffscreenCanvas`) and offscreen entry
/// points so the dither/quantize draw is single-sourced.
pub(crate) fn encode_present_pass(
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
                // (the surface would be this grey, not the image).
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
