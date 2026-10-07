//! Resident preview lifecycle on actual shared RAW preparation and GPU chain.
use maple_linux::gpu_preview::GpuPreview;
use raw_core::types::adjustment::AdjustmentModel;
use raw_gpu::{CancelToken, GpuContext};

#[test]
fn slider_reuses_upload_and_cancel_does_not_present() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode(&path).unwrap();
    let gpu = GpuContext::new_blocking().unwrap();
    let model = AdjustmentModel::default();
    let mut preview = GpuPreview::open(&gpu, &raw, &bytes, "dng", &model, 32).unwrap();
    assert!(preview
        .render(&gpu, &raw, &bytes, "dng", &model, &CancelToken::new())
        .unwrap());
    let edited = AdjustmentModel {
        exposure: 1.0,
        ..model.clone()
    };
    assert!(preview
        .render(&gpu, &raw, &bytes, "dng", &edited, &CancelToken::new())
        .unwrap());
    // Register the actual resident view with the actual native renderer.
    let state = eframe::egui_wgpu::RenderState {
        adapter: gpu.adapter.clone(),
        available_adapters: std::sync::Arc::from([]),
        device: gpu.device.clone(),
        queue: gpu.queue.clone(),
        target_format: eframe::egui_wgpu::wgpu::TextureFormat::Rgba8Unorm,
        renderer: std::sync::Arc::new(eframe::egui::mutex::RwLock::new(
            eframe::egui_wgpu::Renderer::new(
                &gpu.device,
                eframe::egui_wgpu::wgpu::TextureFormat::Rgba8Unorm,
                None,
                1,
                false,
            ),
        )),
    };
    let registration = maple_linux::gpu_texture::NativeTexture::register(
        &state,
        maple_linux::gpu_texture::GpuFrame::from_preview(&gpu, &preview),
    )
    .unwrap();
    let id = registration.id();
    assert!(state.renderer.read().texture(&id).is_some());
    assert!(
        registration.shares_view(&maple_linux::gpu_texture::GpuFrame::from_preview(
            &gpu, &preview
        ))
    );
    assert_eq!(
        registration.size(),
        eframe::egui::vec2(
            preview.target().dims().0 as f32,
            preview.target().dims().1 as f32
        )
    );
    drop(registration);
    assert!(state.renderer.read().texture(&id).is_none());
    assert_eq!(preview.upload_count(), 1);
    let warm_allocations = preview.pool_alloc_count(&gpu);
    assert!(preview
        .render(&gpu, &raw, &bytes, "dng", &edited, &CancelToken::new())
        .unwrap());
    assert_eq!(preview.pool_alloc_count(&gpu), warm_allocations);
    let presented = preview.target().dispatch_alloc_count();
    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert!(!preview
        .render(&gpu, &raw, &bytes, "dng", &edited, &cancelled)
        .unwrap());
    assert_eq!(preview.target().dispatch_alloc_count(), presented);
    let upstream = AdjustmentModel {
        capture_sharpening_amount: 65.0,
        ..model
    };
    assert!(preview
        .render(&gpu, &raw, &bytes, "dng", &upstream, &CancelToken::new())
        .unwrap());
    assert_eq!(preview.upload_count(), 2);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}
