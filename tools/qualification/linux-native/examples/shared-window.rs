//! Actual native Maple window on the shared compute device (#4317).
//! This diagnostic qualifies device/presentation interoperability only.
use eframe::{egui, App};
use maple_linux::app::MapleApp;
use raw_gpu::GpuContext;
use std::sync::Arc;
use std::{
    io::Write,
    time::{Duration, Instant},
};

struct Smoke {
    app: MapleApp,
    started: Instant,
    requested: bool,
    output: std::path::PathBuf,
}

impl App for Smoke {
    fn update(&mut self, context: &egui::Context, frame: &mut eframe::Frame) {
        self.app.update(context, frame);
        let screenshot = context.input(|input| {
            input.events.iter().find_map(|event| match event {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(image) = screenshot {
            let mut file = std::fs::File::create(&self.output).expect("create screenshot");
            write!(file, "P6\n{} {}\n255\n", image.size[0], image.size[1]).unwrap();
            for pixel in &image.pixels {
                file.write_all(&pixel.to_array()[..3]).unwrap();
            }
            file.sync_all().unwrap();
            println!(
                "Native window screenshot: {}x{} at {}",
                image.size[0],
                image.size[1],
                self.output.display()
            );
            context.send_viewport_cmd(egui::ViewportCommand::Close);
        } else if !self.requested && self.started.elapsed() > Duration::from_secs(3) {
            self.requested = true;
            context.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        assert!(
            self.started.elapsed() < Duration::from_secs(20),
            "native screenshot timed out"
        );
        context.request_repaint_after(Duration::from_millis(100));
    }
    fn on_exit(&mut self) {
        self.app.on_exit();
    }
}

fn main() -> eframe::Result {
    let mut args = std::env::args_os().skip(1);
    let folder: std::path::PathBuf = args.next().expect("folder argument").into();
    let output: std::path::PathBuf = args.next().expect("PPM screenshot argument").into();
    let gpu =
        GpuContext::new_blocking().map_err(|error| eframe::Error::AppCreation(error.into()))?;
    let setup = eframe::egui_wgpu::WgpuSetup::Existing {
        instance: gpu.instance.clone(),
        adapter: gpu.adapter.clone(),
        device: gpu.device.clone(),
        queue: gpu.queue.clone(),
    };
    eframe::run_native(
        "Maple native qualification",
        eframe::NativeOptions {
            viewport: egui::ViewportBuilder::default().with_inner_size([1280.0, 800.0]),
            renderer: eframe::Renderer::Wgpu,
            wgpu_options: eframe::egui_wgpu::WgpuConfiguration {
                wgpu_setup: setup,
                ..Default::default()
            },
            ..Default::default()
        },
        Box::new(move |cc| {
            let actual = cc
                .wgpu_render_state
                .as_ref()
                .expect("native wgpu render state");
            assert!(Arc::ptr_eq(&actual.adapter, &gpu.adapter));
            assert!(Arc::ptr_eq(&actual.device, &gpu.device));
            assert!(Arc::ptr_eq(&actual.queue, &gpu.queue));
            maple_linux_toolkit_probe::verify_exposure(&gpu)
                .map_err(|error| eframe::Error::AppCreation(error.into()))?;
            println!(
                "native_shared_adapter_device_queue=passed adapter={:?}",
                gpu.adapter.get_info()
            );

            let mut app = MapleApp::new(cc);
            app.open_folder(folder);
            Ok(Box::new(Smoke {
                app,
                started: Instant::now(),
                requested: false,
                output,
            }))
        }),
    )
}
