//! `GpuContext` — the device/queue handle every GPU resource borrows.
//!
//! Wraps P0's instance/adapter/device/queue setup (epic #925) behind a reusable
//! type so `GpuImage`, `ChainRunner`, and the passes can share one device. The
//! exposure compute pipeline is compiled lazily and cached here (one WGSL
//! compile per context, not per pass) so the substrate P1b (#988) / P1c (#989)
//! consume is genuinely reusable rather than recompiling the kernel every
//! dispatch.

use std::cell::OnceCell;

/// Device/queue handle plus lazily-compiled, cached compute pipelines.
///
/// Construct once (`new_blocking` on native, `new_async` anywhere) and share by
/// reference. Not `Send`/`Sync` — the cached-pipeline `OnceCell` is single-
/// threaded; the headless harness and the P1b/P1c display owners are
/// single-threaded around the GPU, matching wgpu's per-thread submission model.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Lazily-compiled exposure compute pipeline (`exposure.wgsl`). Built on
    /// first use via [`GpuContext::exposure_pipeline`] and reused thereafter.
    exposure_pipeline: OnceCell<wgpu::ComputePipeline>,
}

impl GpuContext {
    /// Async constructor shared by native (`new_blocking`) and wasm callers.
    /// Picks the default adapter (Metal on macOS, WebGPU in the browser).
    pub async fn new_async() -> Self {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("no suitable GPU adapter");
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("maple-gpu"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                // wgpu 23.0.1 still takes the trace-path arg (the plan's note
                // assumed it was dropped in v22; this keeps it). `None` disables
                // API tracing.
                None,
            )
            .await
            .expect("device request failed");
        Self {
            device,
            queue,
            exposure_pipeline: OnceCell::new(),
        }
    }

    /// Native blocking constructor (drives the adapter/device request via
    /// pollster). Not compiled for wasm, which awaits [`GpuContext::new_async`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_blocking() -> Self {
        pollster::block_on(Self::new_async())
    }

    /// The cached exposure compute pipeline, compiling `exposure.wgsl` on first
    /// call. The auto bind-group layout (`layout: None`) is shared by every
    /// `ExposurePass` bind group via `pipeline.get_bind_group_layout(0)`.
    pub fn exposure_pipeline(&self) -> &wgpu::ComputePipeline {
        self.exposure_pipeline.get_or_init(|| {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("exposure"),
                    source: wgpu::ShaderSource::Wgsl(include_str!("exposure.wgsl").into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("exposure-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }
}
