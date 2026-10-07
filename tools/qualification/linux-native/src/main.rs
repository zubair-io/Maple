//! Toolkit/device compatibility gate for the native Linux port (#4317).
//! This headless diagnostic is not a GUI or a live-path performance benchmark.

use raw_gpu::GpuContext;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let gpu = GpuContext::new_blocking()?;
    // Compile the actual UI pipeline on Maple's device. A different wgpu major
    // would fail at this seam; a separate device would not prove interoperability.
    let _renderer =
        egui_wgpu::Renderer::new(&gpu.device, wgpu::TextureFormat::Bgra8Unorm, None, 1, false);
    maple_linux_toolkit_probe::verify_exposure(&gpu)?;
    let info = gpu.adapter.get_info();
    println!("egui_device_compatibility=passed adapter={info:?}");
    if info.device_type == wgpu::DeviceType::Cpu {
        println!("performance_qualification=unavailable reason=software_adapter");
    } else {
        println!("performance_qualification=not_measured");
    }
    println!("window_presentation=not_tested full_chain_parity=not_tested");
    Ok(())
}
