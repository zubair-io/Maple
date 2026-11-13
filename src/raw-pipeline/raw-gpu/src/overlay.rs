//! Canvas overlay surface (#5715): the GPU half of the shared overlay
//! renderer. `raw_core::canvas` describes an overlay as up to
//! [`OVERLAY_CAPACITY`] coverage primitives; this module draws them with
//! `overlay.wgsl` into an upright surface, the viewport plus an overscan
//! margin, that the platform composites above the image, so an overlay redraw
//! never touches the develop chain. The CPU fallback is
//! `raw_core::canvas::rasterize_overlay`, held at parity with this pass by
//! `overlay/tests.rs`.
//!
//! The output is premultiplied RGBA at SDR reference white in an 8-bit
//! non-sRGB format, so a white primitive stores `255` and the compositor
//! interprets it in the surface's own colour space.
//!
//! Per frame the pass rewrites one uniform buffer and records one draw; the
//! pipeline, uniform and bind group are built once per surface format.

use crate::context::GpuContext;

#[path = "generated/canvas_overlay.rs"]
mod generated;
/// Most primitives one overlay carries, generated from `raw_core::canvas`.
pub use generated::OVERLAY_CAPACITY;

/// One coverage primitive, laid out as `overlay.wgsl`'s `Primitive`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OverlayPrimitive {
    pub rect: [f32; 4],
    pub clip: [f32; 4],
    pub color: [f32; 4],
    pub kind: [u32; 4],
}

/// The overlay uniform: the primitive count, then the primitives in drawing
/// order. Entries past `count` are ignored.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OverlayParams {
    pub count: [u32; 4],
    pub primitives: [OverlayPrimitive; OVERLAY_CAPACITY],
}

impl OverlayParams {
    /// Draws nothing: a fully transparent surface.
    pub const EMPTY: Self = Self {
        count: [0; 4],
        primitives: [OverlayPrimitive {
            rect: [0.0; 4],
            clip: [0.0; 4],
            color: [0.0; 4],
            kind: [0; 4],
        }; OVERLAY_CAPACITY],
    };
}

impl Default for OverlayParams {
    fn default() -> Self {
        Self::EMPTY
    }
}

/// The overlay's render pipeline plus its one uniform and bind group.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) struct OverlayPipeline {
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    format: wgpu::TextureFormat,
}

#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
impl OverlayPipeline {
    pub(crate) fn new(ctx: &GpuContext, format: wgpu::TextureFormat) -> Self {
        let shader = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("canvas-overlay"),
                source: wgpu::ShaderSource::Wgsl(
                    concat!(
                        include_str!("generated/canvas_overlay.wgsl"),
                        "\n",
                        include_str!("overlay.wgsl")
                    )
                    .into(),
                ),
            });
        let layout = ctx
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("canvas-overlay-bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
        let pipeline_layout = ctx
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("canvas-overlay-layout"),
                bind_group_layouts: &[&layout],
                push_constant_ranges: &[],
            });
        let pipeline = ctx
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("canvas-overlay-pipeline"),
                layout: Some(&pipeline_layout),
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
        let uniform = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("canvas-overlay-uniform"),
            size: std::mem::size_of::<OverlayParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("canvas-overlay-bind-group"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        Self {
            pipeline,
            uniform,
            bind_group,
            format,
        }
    }

    #[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
    pub(crate) fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    /// Stage `params` into the existing uniform and record the overlay draw
    /// into `target`, clearing it to transparent first.
    pub(crate) fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        params: &OverlayParams,
        target: &wgpu::TextureView,
    ) {
        ctx.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(params));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("canvas-overlay-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// The surface's 8-bit non-sRGB format: the shader writes final premultiplied
/// values, which an `*Srgb` format would re-encode.
#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
pub(crate) fn pick_overlay_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    use wgpu::TextureFormat::{Bgra8Unorm, Rgba8Unorm};
    formats
        .iter()
        .copied()
        .find(|format| matches!(format, Bgra8Unorm | Rgba8Unorm))
}

/// A compositing mode that keeps the surface transparent. wgpu's Metal backend
/// lists only `Opaque` and `PostMultiplied`; `PostMultiplied` there just clears
/// `CAMetalLayer.opaque`, and Core Animation always reads layer contents as
/// premultiplied, which is what the shader writes.
#[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
pub(crate) fn pick_overlay_alpha_mode(
    modes: &[wgpu::CompositeAlphaMode],
) -> Option<wgpu::CompositeAlphaMode> {
    use wgpu::CompositeAlphaMode::{PostMultiplied, PreMultiplied};
    [PreMultiplied, PostMultiplied]
        .into_iter()
        .find(|mode| modes.contains(mode))
}

/// Host-only: draw `params` into an owned `Rgba8Unorm` texture and read back
/// the `4·w·h` premultiplied RGBA bytes. The parity oracle for the CPU
/// rasterizer; not a per-frame path.
#[cfg(not(target_arch = "wasm32"))]
pub fn render_overlay_offscreen(
    ctx: &GpuContext,
    params: &OverlayParams,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let max_dim = ctx.device.limits().max_texture_dimension_2d;
    if width == 0 || height == 0 || width > max_dim || height > max_dim {
        return Err(format!(
            "render_overlay_offscreen: {width}x{height} outside 1..={max_dim}"
        ));
    }
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let extent = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("canvas-overlay-offscreen"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());
    let pipeline = OverlayPipeline::new(ctx, format);
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("canvas-overlay-offscreen-encoder"),
        });
    pipeline.encode(ctx, &mut encoder, params, &view);
    let row_bytes = width * 4;
    let padded =
        row_bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("canvas-overlay-readback"),
        size: u64::from(padded) * u64::from(height),
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
                bytes_per_row: Some(padded),
                rows_per_image: Some(height),
            },
        },
        extent,
    );
    ctx.queue.submit(Some(encoder.finish()));
    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.recv()
        .map_err(|_| "canvas overlay readback: map channel dropped".to_string())?
        .map_err(|e| format!("canvas overlay readback: {e}"))?;
    let data = slice.get_mapped_range();
    let bytes = data
        .chunks(padded as usize)
        .flat_map(|row| &row[..row_bytes as usize])
        .copied()
        .collect();
    drop(data);
    readback.unmap();
    Ok(bytes)
}

#[cfg(target_vendor = "apple")]
#[path = "overlay/surface.rs"]
mod surface;
#[cfg(target_vendor = "apple")]
pub use surface::{present_overlay_to_surface, release_overlay_surface, PersistentOverlaySurface};

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "overlay/tests.rs"]
mod tests;
