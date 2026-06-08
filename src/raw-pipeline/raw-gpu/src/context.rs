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
    /// Lazily-compiled vibrance compute pipeline (`vibrance.wgsl` + the
    /// generated color matrices). The P2 template (#990); built on first use
    /// via [`GpuContext::vibrance_pipeline`].
    vibrance_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled white-balance compute pipeline (`white_balance.wgsl`).
    /// A P2 scene-linear stage (#990); a pure per-pixel 3×3 matmul, so it needs
    /// no generated color matrices (the WB matrix is a per-pass uniform). Built
    /// on first use via [`GpuContext::white_balance_pipeline`].
    white_balance_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled scene-tone-controls compute pipeline
    /// (`scene_tone_controls.wgsl`). A P2 scene-linear stage (#990); five
    /// luma-coupled tone steps, no Oklab, so no generated color matrices. Built
    /// on first use via [`GpuContext::scene_tone_controls_pipeline`].
    scene_tone_controls_pipeline: OnceCell<wgpu::ComputePipeline>,
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
            vibrance_pipeline: OnceCell::new(),
            white_balance_pipeline: OnceCell::new(),
            scene_tone_controls_pipeline: OnceCell::new(),
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

    /// The cached vibrance compute pipeline (epic #925 P2 / #990).
    ///
    /// WGSL has no `#include`, so the shader source is built by concatenating
    /// the **generated** color-matrix module (`generated/color_matrices.wgsl`,
    /// emitted by `codegen --schema color-matrices --target wgsl`) ahead of the
    /// `vibrance.wgsl` kernel. The kernel calls the generated `mul_*` helpers;
    /// `include_str!` of the committed generated file keeps raw-gpu free of a
    /// build-time dependency on the `codegen` crate (the file rides the
    /// codegen-drift CI gate instead). This concat-at-compile pattern is what
    /// every Oklab/matrix fan-out stage reuses.
    pub fn vibrance_pipeline(&self) -> &wgpu::ComputePipeline {
        self.vibrance_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("vibrance.wgsl"),
            );
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("vibrance"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("vibrance-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached white-balance compute pipeline (epic #925 P2 / #990).
    ///
    /// Unlike vibrance, this kernel does NOT concat the generated color
    /// matrices: white balance is a pure per-pixel 3×3 matmul whose matrix is
    /// supplied as a per-pass uniform (CPU-derived once via CAT16 / diagonal
    /// gains). So `white_balance.wgsl` compiles standalone, like `exposure.wgsl`.
    pub fn white_balance_pipeline(&self) -> &wgpu::ComputePipeline {
        self.white_balance_pipeline.get_or_init(|| {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("white-balance"),
                    source: wgpu::ShaderSource::Wgsl(include_str!("white_balance.wgsl").into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("white-balance-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached scene-tone-controls compute pipeline (epic #925 P2 / #990).
    ///
    /// Five luma-coupled tone steps (exposure / highlights / shadows / whites /
    /// blacks), no Oklab — so, like exposure / white_balance, the kernel
    /// compiles standalone with no generated-color-matrix concat.
    pub fn scene_tone_controls_pipeline(&self) -> &wgpu::ComputePipeline {
        self.scene_tone_controls_pipeline.get_or_init(|| {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("scene-tone-controls"),
                    source: wgpu::ShaderSource::Wgsl(
                        include_str!("scene_tone_controls.wgsl").into(),
                    ),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("scene-tone-controls-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }
}
