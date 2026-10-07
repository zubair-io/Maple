fn main() -> eframe::Result {
    let gpu = raw_gpu::GpuContext::new_blocking()
        .map_err(|error| eframe::Error::AppCreation(error.into()))?;
    let setup = eframe::egui_wgpu::WgpuSetup::Existing {
        instance: gpu.instance.clone(),
        adapter: gpu.adapter.clone(),
        device: gpu.device.clone(),
        queue: gpu.queue.clone(),
    };
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Maple")
            .with_app_id("app.justmaple.aperture")
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([800.0, 540.0]),
        renderer: eframe::Renderer::Wgpu,
        wgpu_options: eframe::egui_wgpu::WgpuConfiguration {
            wgpu_setup: setup,
            ..Default::default()
        },
        ..Default::default()
    };
    eframe::run_native(
        "Maple",
        options,
        Box::new(move |cc| {
            let mut app = maple_linux::app::MapleApp::with_gpu(cc, gpu);
            if let Some(folder) = std::env::args_os().nth(1) {
                app.open_folder(folder.into());
            }
            Ok(Box::new(app))
        }),
    )
}
