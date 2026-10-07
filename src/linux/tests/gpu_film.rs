//! Real shared-pack film binding on resident GPU textures (#4317).
use maple_linux::gpu_preview::GpuPreview;
use raw_core::types::adjustment::AdjustmentModel;
use raw_gpu::{CancelToken, GpuContext};

#[test]
fn real_film_changes_gpu_pixels_hot_exposure_reuses_resources_and_off_restores_baseline() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    let gpu = GpuContext::new_blocking().unwrap();
    let baseline = AdjustmentModel::default();
    let mut preview = GpuPreview::open(&gpu, &raw, &bytes, "dng", &baseline, 32).unwrap();
    preview
        .render(&gpu, &raw, &bytes, "dng", &baseline, &CancelToken::new())
        .unwrap();
    let before = pixels(&gpu, &preview);
    let initial_uploads = preview.upload_count();
    let mut film = baseline.clone();
    film.film_look = raw_core::film_catalog::FILM_CATALOG[0].id.to_owned();
    film.film_strength = 100.0;
    preview
        .render(&gpu, &raw, &bytes, "dng", &film, &CancelToken::new())
        .unwrap();
    let developed = pixels(&gpu, &preview);
    assert_eq!(preview.upload_count(), initial_uploads);
    film.film_strength = 50.0;
    preview
        .render(&gpu, &raw, &bytes, "dng", &film, &CancelToken::new())
        .unwrap();
    assert_eq!(preview.upload_count(), initial_uploads);
    assert_ne!(pixels(&gpu, &preview), developed);
    film.film_strength = 100.0;
    assert_ne!(
        before, developed,
        "real loaded film must affect resident pixels"
    );
    let uploads = preview.upload_count();
    let view = preview.target().view_handle();
    film.exposure = 1.0;
    preview
        .render(&gpu, &raw, &bytes, "dng", &film, &CancelToken::new())
        .unwrap();
    assert_eq!(preview.upload_count(), uploads);
    assert!(std::sync::Arc::ptr_eq(
        &view,
        &preview.target().view_handle()
    ));
    assert_ne!(pixels(&gpu, &preview), developed);
    let allocations = preview.pool_alloc_count(&gpu);
    preview
        .render(&gpu, &raw, &bytes, "dng", &film, &CancelToken::new())
        .unwrap();
    assert_eq!(preview.pool_alloc_count(&gpu), allocations);
    preview
        .render(&gpu, &raw, &bytes, "dng", &baseline, &CancelToken::new())
        .unwrap();
    assert_eq!(pixels(&gpu, &preview), before);
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(
        GpuPreview::open_cancellable(&gpu, &raw, &bytes, "dng", &baseline, 32, &cancelled)
            .unwrap()
            .is_none()
    );
    let upstream = AdjustmentModel {
        capture_sharpening_amount: 65.0,
        ..baseline.clone()
    };
    let uploads = preview.upload_count();
    assert!(!preview
        .render(&gpu, &raw, &bytes, "dng", &upstream, &cancelled)
        .unwrap());
    assert_eq!(preview.upload_count(), uploads);
    assert_eq!(pixels(&gpu, &preview), before);
    // Cancellation is per request: the retained session still accepts the next tick.
    assert!(preview
        .render(&gpu, &raw, &bytes, "dng", &baseline, &CancelToken::new())
        .unwrap());
    assert_eq!(pixels(&gpu, &preview), before);
    let newer_catalog = AdjustmentModel {
        film_look: "../../unavailable".into(),
        ..baseline
    };
    assert!(preview
        .render(
            &gpu,
            &raw,
            &bytes,
            "dng",
            &newer_catalog,
            &CancelToken::new()
        )
        .unwrap());
    assert_eq!(
        pixels(&gpu, &preview),
        before,
        "an unknown look renders as identity"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

fn pixels(ctx: &GpuContext, preview: &GpuPreview) -> Vec<u8> {
    // Test readback only; the production path registers this resident view.
    let (w, h) = preview.target().dims();
    let stride = (w * 4).div_ceil(256) * 256;
    let buffer = ctx
        .device
        .create_buffer(&eframe::egui_wgpu::wgpu::BufferDescriptor {
            label: Some("film-qualification-readback"),
            size: u64::from(stride) * u64::from(h),
            usage: eframe::egui_wgpu::wgpu::BufferUsages::COPY_DST
                | eframe::egui_wgpu::wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        eframe::egui_wgpu::wgpu::ImageCopyTexture {
            texture: preview.target().texture(),
            mip_level: 0,
            origin: Default::default(),
            aspect: eframe::egui_wgpu::wgpu::TextureAspect::All,
        },
        eframe::egui_wgpu::wgpu::ImageCopyBuffer {
            buffer: &buffer,
            layout: eframe::egui_wgpu::wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(h),
            },
        },
        eframe::egui_wgpu::wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    ctx.queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::channel();
    buffer
        .slice(..)
        .map_async(eframe::egui_wgpu::wgpu::MapMode::Read, move |result| {
            sender.send(result).unwrap()
        });
    ctx.device.poll(eframe::egui_wgpu::wgpu::Maintain::Wait);
    receiver.recv().unwrap().unwrap();
    let mapped = buffer.slice(..).get_mapped_range();
    let bytes = mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..(w * 4) as usize].iter().copied())
        .collect();
    drop(mapped);
    buffer.unmap();
    bytes
}
