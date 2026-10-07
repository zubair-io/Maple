//! Real Wayland/X11 window smoke test for #4317. Optional resident RAW preview;
//! this does not measure photograph colour parity or slider performance.
use eframe::{egui, App};
use maple_linux::app::MapleApp;
use std::{
    io::Write,
    time::{Duration, Instant},
};

struct Smoke {
    app: MapleApp,
    started: Instant,
    requested: bool,
    output: std::path::PathBuf,
    photo: Option<maple_linux::library::Photo>,
    delay: Duration,
    actual_size: bool,
}

impl App for Smoke {
    fn raw_input_hook(&mut self, _: &egui::Context, input: &mut egui::RawInput) {
        if self.actual_size && self.started.elapsed() > Duration::from_secs(4) {
            self.actual_size = false;
            input.events.push(egui::Event::Key {
                key: egui::Key::Z,
                physical_key: Some(egui::Key::Z),
                pressed: true,
                repeat: false,
                modifiers: egui::Modifiers::NONE,
            });
        }
    }
    fn update(&mut self, context: &egui::Context, frame: &mut eframe::Frame) {
        self.app.update(context, frame);
        if self.started.elapsed() > Duration::from_secs(1) {
            if let Some(photo) = self.photo.take() {
                self.app.select(photo);
            }
        }
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
        } else if !self.requested && self.started.elapsed() > self.delay {
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
    let preview = args.next().is_some_and(|arg| arg == "--gpu-preview");
    let actual_size = args.next().is_some_and(|arg| arg == "--actual-size");
    let photo = preview.then(|| {
        maple_linux::library::Folder::scan(&folder)
            .unwrap()
            .photos
            .remove(0)
    });
    let gpu =
        raw_gpu::GpuContext::new_blocking().map_err(|e| eframe::Error::AppCreation(e.into()))?;
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
            let mut app = MapleApp::with_gpu(cc, gpu);
            app.open_folder(folder);
            Ok(Box::new(Smoke {
                app,
                started: Instant::now(),
                requested: false,
                output,
                photo,
                delay: Duration::from_secs(if preview { 8 } else { 3 }),
                actual_size,
            }))
        }),
    )
}
