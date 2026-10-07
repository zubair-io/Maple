//! UI compositor must preserve the resident preview's encoded display bytes.
use eframe::{
    egui,
    egui_wgpu::{wgpu, RenderState, Renderer, ScreenDescriptor},
};
use maple_linux::{
    gpu_preview::GpuPreview,
    gpu_texture::{GpuFrame, NativeTexture},
};
use raw_core::types::adjustment::AdjustmentModel;
use raw_gpu::{CancelToken, GpuContext};
use std::sync::Arc;

#[test]
fn native_texture_compositor_preserves_display_bytes_for_both_framebuffer_formats() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    let ctx = GpuContext::new_blocking().unwrap();
    let mut model = AdjustmentModel::default();
    let mut preview = GpuPreview::open(&ctx, &raw, &bytes, "dng", &model, 32).unwrap();
    for exposure in [-2.0, 0.0, 2.0] {
        model.exposure = exposure;
        if exposure == 0.0 {
            model.film_look = raw_core::film_catalog::FILM_CATALOG[0].id.into();
        } else {
            model.film_look.clear();
        }
        assert!(preview
            .render(&ctx, &raw, &bytes, "dng", &model, &CancelToken::new())
            .unwrap());
        let expected = read_rgba(&ctx, preview.target().texture());
        for format in [
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureFormat::Rgba8UnormSrgb,
        ] {
            let state = RenderState {
                adapter: ctx.adapter.clone(),
                available_adapters: Arc::from([]),
                device: ctx.device.clone(),
                queue: ctx.queue.clone(),
                target_format: format,
                renderer: Arc::new(egui::mutex::RwLock::new(Renderer::new(
                    &ctx.device,
                    format,
                    None,
                    1,
                    false,
                ))),
            };
            let texture =
                NativeTexture::register(&state, GpuFrame::from_preview(&ctx, &preview)).unwrap();
            let (w, h) = preview.target().dims();
            let output = blit(&ctx, &state, texture.id(), (w, h));
            let actual = read_rgba(&ctx, &output);
            let error = actual
                .iter()
                .zip(&expected)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(error<=1,"{format:?}, exposure={exposure}: egui presentation changed encoded pixels by {error} code values");
            // A hot render must keep the same sampled view and UI registration.
            assert!(texture.shares_view(&GpuFrame::from_preview(&ctx, &preview)));
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

fn blit(
    ctx: &GpuContext,
    state: &RenderState,
    id: egui::TextureId,
    dims: (u32, u32),
) -> wgpu::Texture {
    let (w, h) = dims;
    let output = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("native-compositor-qualification"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: state.target_format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let rect = egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(w as f32, h as f32));
    let mut mesh = egui::Mesh::with_texture(id);
    mesh.add_rect_with_uv(
        rect,
        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
        egui::Color32::WHITE,
    );
    let jobs = [egui::ClippedPrimitive {
        clip_rect: rect,
        primitive: egui::epaint::Primitive::Mesh(mesh),
    }];
    let screen = ScreenDescriptor {
        size_in_pixels: [w, h],
        pixels_per_point: 1.0,
    };
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    let mut renderer = state.renderer.write();
    let commands = renderer.update_buffers(&ctx.device, &ctx.queue, &mut encoder, &jobs, &screen);
    {
        let view = output.create_view(&Default::default());
        let mut pass = encoder
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("native-ui-pixel-check"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            })
            .forget_lifetime();
        renderer.render(&mut pass, &jobs, &screen);
    }
    ctx.queue.submit(
        commands
            .into_iter()
            .chain(std::iter::once(encoder.finish())),
    );
    output
}
fn read_rgba(ctx: &GpuContext, texture: &wgpu::Texture) -> Vec<u8> {
    let (w, h) = (texture.width(), texture.height());
    let stride = (w * 4).div_ceil(256) * 256;
    let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("compositor-readback"),
        size: u64::from(stride) * u64::from(h),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &buffer,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    ctx.queue.submit(Some(encoder.finish()));
    let (sent, received) = std::sync::mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            sent.send(result).unwrap();
        });
    ctx.device.poll(wgpu::Maintain::Wait);
    received.recv().unwrap().unwrap();
    let mapped = buffer.slice(..).get_mapped_range();
    mapped
        .chunks(stride as usize)
        .flat_map(|row| row[..(w * 4) as usize].iter().copied())
        .collect()
}
