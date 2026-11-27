use eframe::egui;

pub struct StartupIcon(std::thread::JoinHandle<egui::ColorImage>);

impl StartupIcon {
    pub(super) fn start(decode: impl FnOnce() -> egui::ColorImage + Send + 'static) -> Self {
        Self(std::thread::spawn(decode))
    }

    pub(super) fn begin() -> Self {
        Self::start(decode_icon)
    }

    pub(super) fn image(self) -> egui::ColorImage {
        self.0
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }
}

fn decode_icon() -> egui::ColorImage {
    let icon = image::load_from_memory_with_format(
        include_bytes!("../../../apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png"),
        image::ImageFormat::Png,
    )
    .expect("the canonical Maple icon is valid PNG")
    .to_rgba8();
    egui::ColorImage::from_rgba_unmultiplied(
        [icon.width() as usize, icon.height() as usize],
        icon.as_raw(),
    )
}

fn overlapped<R>(
    decode: impl FnOnce() -> egui::ColorImage + Send + 'static,
    create_gpu: impl FnOnce() -> R,
) -> (R, StartupIcon) {
    let icon = StartupIcon::start(decode);
    (create_gpu(), icon)
}

// The GPU context must exist before the window does, so work that does not need it runs beside it.
pub fn launch_prerequisites() -> Result<(raw_gpu::GpuContext, StartupIcon), String> {
    let (gpu, icon) = overlapped(decode_icon, raw_gpu::GpuContext::new_blocking);
    Ok((gpu?, icon))
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;
