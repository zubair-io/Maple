//! #4355: retained bind groups must never present a retired source's pixels.
use super::*;

#[test]
fn retired_wrappers_never_reuse_previous_source_pixels() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (pipeline, bgl) = build_present_pipeline(&ctx, wgpu::TextureFormat::Rgba8Unorm);
    let cache = PresentDispatchCache::new();
    for index in 0..64 {
        let buffer = make_chain_buf(&ctx, "retired-colored-source");
        let color = [0.05f32 + index as f32 / 80.0, 0.2, 0.3, 1.0];
        ctx.queue
            .write_buffer(&buffer, 0, bytemuck::cast_slice(&[color; 4]));
        let (_, cached) = cache.get_or_build(&ctx, &bgl, &buffer, (index + 1, 0), (2, 2));
        let fresh = build_present_dispatch(&ctx, &bgl, &buffer, (2, 2), PresentGeometry::IDENTITY);
        assert_eq!(
            pixels(&ctx, &pipeline, &cached),
            pixels(&ctx, &pipeline, &fresh.bind_group),
            "retired source's pixels presented at replacement {index}"
        );
        drop(buffer);
    }
}

fn pixels(
    ctx: &GpuContext,
    pipeline: &wgpu::RenderPipeline,
    bindings: &wgpu::BindGroup,
) -> Vec<u8> {
    let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("retired-source-pixel-control"),
        size: wgpu::Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("retired-source-readback"),
        size: 512,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encode_present_pass(
        &mut encoder,
        pipeline,
        bindings,
        &texture.create_view(&Default::default()),
    );
    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &readback,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(2),
            },
        },
        wgpu::Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 1,
        },
    );
    ctx.queue.submit(Some(encoder.finish()));
    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| tx.send(result).unwrap());
    ctx.device.poll(wgpu::Maintain::Wait);
    rx.recv().unwrap().unwrap();
    let mapped = slice.get_mapped_range();
    let output = [mapped[..8].to_vec(), mapped[256..264].to_vec()].concat();
    drop(mapped);
    readback.unmap();
    output
}
