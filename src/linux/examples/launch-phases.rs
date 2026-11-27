//! Times the GPU context and the app icon decode that precede the window, serial or overlapped; run each in a fresh process, because the first GPU context of a process loads the driver.
//!
//! Usage: launch-phases serial | overlapped
use std::time::Instant;

fn decode_icon() -> (usize, f64) {
    let started = Instant::now();
    let icon = image::load_from_memory_with_format(
        include_bytes!("../../apple/Maple/Assets.xcassets/AppIcon.appiconset/maple512.png"),
        image::ImageFormat::Png,
    )
    .expect("the canonical Maple icon is valid PNG")
    .to_rgba8();
    (icon.len(), started.elapsed().as_secs_f64() * 1000.0)
}

fn create_gpu() -> Result<f64, String> {
    let started = Instant::now();
    raw_gpu::GpuContext::new_blocking()?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

fn main() -> Result<(), String> {
    let overlapped = match std::env::args().nth(1).as_deref() {
        Some("serial") => false,
        Some("overlapped") => true,
        _ => return Err("usage: launch-phases serial | overlapped".into()),
    };
    let started = Instant::now();
    let (gpu_ms, icon_ms) = if overlapped {
        let icon = std::thread::spawn(decode_icon);
        let gpu = create_gpu()?;
        (gpu, icon.join().expect("icon thread").1)
    } else {
        let gpu = create_gpu()?;
        (gpu, decode_icon().1)
    };
    println!(
        "launch-phases mode={} gpu_ms={gpu_ms:.2} icon_ms={icon_ms:.2} total_ms={:.2}",
        if overlapped { "overlapped" } else { "serial" },
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}
