fn main() -> eframe::Result {
    let launch = std::env::args_os().nth(1);
    if launch.as_deref() == Some(std::ffi::OsStr::new("--diagnose")) {
        let findings = maple_linux::diagnose::run();
        print!("{}", maple_linux::diagnose::render(&findings));
        let problem = findings
            .iter()
            .any(|finding| finding.status == maple_linux::diagnose::Status::Problem);
        std::process::exit(i32::from(problem));
    }
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
            if let Some(path) = launch {
                app.open_path(path.into());
            }
            Ok(Box::new(app))
        }),
    )
}
