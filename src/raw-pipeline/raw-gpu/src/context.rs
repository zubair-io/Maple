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
    /// Lazily-compiled display-encode compute pipeline (`display_encode.wgsl` +
    /// the generated color matrices). A P2 view-transform stage (#990):
    /// Rec.2020 → sRGB + Oklab gamut compression, so it concats the generated
    /// matrices like vibrance. Built on first use via
    /// [`GpuContext::display_encode_pipeline`].
    display_encode_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled saturation compute pipeline (`saturation.wgsl` + the
    /// generated color matrices). A P2 scene-linear stage (#990): Oklab chroma
    /// scale + a gamut-hull bisection, so it concats the generated matrices like
    /// vibrance. Built on first use via [`GpuContext::saturation_pipeline`].
    saturation_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled Auto Profile curve compute pipeline
    /// (`auto_profile_curve.wgsl` + the generated color matrices). A P2
    /// view-transform stage (#990): the per-pixel fitted tone curve
    /// (`compress_input` + per-channel eval + matrix + Oklab corrections), NOT
    /// the residual 3D LUT. Concats the generated matrices like vibrance (the
    /// Oklab correction path). Built on first use via
    /// [`GpuContext::auto_profile_curve_pipeline`].
    auto_profile_curve_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled AgX view-transform compute pipeline (`agx.wgsl` + the
    /// generated color matrices + the generated AgX coeffs). A P2
    /// view-transform stage (#990): inset -> log encode -> ratio-preserving
    /// sigmoid (sampling the baked LUT) -> outset -> Oklab hue-preserving
    /// gamut compression. Concats BOTH generated WGSL modules (Oklab pair +
    /// AgX matrices/scalars) ahead of the kernel, and uses a 4-binding layout
    /// (params uniform + src/dst storage + the baked-LUT storage buffer).
    /// Built on first use via [`GpuContext::agx_pipeline`].
    agx_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled residual-LUT compute pipeline (`residual_lut.wgsl`). A P2
    /// view-transform stage (#990): the per-image residual 3D LUT (#924) sampled
    /// by trilinear interpolation. Pure lookup — no Oklab — so, like exposure /
    /// white_balance, the kernel compiles standalone with no generated-matrix
    /// concat. Uses a 4-binding layout (params uniform + src/dst storage + the
    /// per-image grid storage buffer). Built on first use via
    /// [`GpuContext::residual_lut_pipeline`].
    residual_lut_pipeline: OnceCell<wgpu::ComputePipeline>,
    /// Lazily-compiled tone-curves compute pipeline (`tone_curves.wgsl`). A P2
    /// scene-linear stage (#990): the parametric region sliders + per-channel
    /// point curves, evaluated from CPU-prepared Fritsch-Carlson curves uploaded
    /// to a storage buffer. Luma coupling uses the inlined Rec.2020 weights, so —
    /// like exposure / white_balance — the kernel compiles standalone with no
    /// generated-color-matrix concat. 4-binding layout (params uniform + src/dst
    /// storage + the prepared-curve-slots storage buffer). Built on first use via
    /// [`GpuContext::tone_curves_pipeline`].
    tone_curves_pipeline: OnceCell<wgpu::ComputePipeline>,
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
            display_encode_pipeline: OnceCell::new(),
            saturation_pipeline: OnceCell::new(),
            auto_profile_curve_pipeline: OnceCell::new(),
            agx_pipeline: OnceCell::new(),
            residual_lut_pipeline: OnceCell::new(),
            tone_curves_pipeline: OnceCell::new(),
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

    /// The cached display-encode compute pipeline (epic #925 P2 / #990).
    ///
    /// Rec.2020 → sRGB + hue-preserving Oklab gamut compression, so the kernel
    /// needs the generated color-matrix helpers (the sRGB↔LMS↔Lab + Rec.2020→sRGB
    /// `mul_*` functions). Same concat-at-compile pattern as `vibrance_pipeline`:
    /// the generated `color_matrices.wgsl` is prepended to `display_encode.wgsl`
    /// (WGSL has no `#include`).
    pub fn display_encode_pipeline(&self) -> &wgpu::ComputePipeline {
        self.display_encode_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("display_encode.wgsl"),
            );
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("display-encode"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("display-encode-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached saturation compute pipeline (epic #925 P2 / #990).
    ///
    /// Saturation rounds each pixel through Oklab (chroma scale + a gamut-hull
    /// bisection), so the kernel needs the generated color-matrix helpers — same
    /// concat-at-compile pattern as `vibrance_pipeline` / `display_encode_pipeline`:
    /// the generated `color_matrices.wgsl` is prepended to `saturation.wgsl`
    /// (WGSL has no `#include`). The gamut constants are inlined in the kernel,
    /// not codegen'd.
    pub fn saturation_pipeline(&self) -> &wgpu::ComputePipeline {
        self.saturation_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("saturation.wgsl"),
            );
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("saturation"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("saturation-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached Auto Profile curve compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel's Oklab correction path uses the generated color-matrix
    /// helpers, so — like `vibrance_pipeline` / `saturation_pipeline` — the
    /// generated `color_matrices.wgsl` is prepended to `auto_profile_curve.wgsl`
    /// at module creation (WGSL has no `#include`). The kernel uses a 4-binding
    /// layout (meta uniform + src/dst storage + the flat-curve storage buffer);
    /// `layout: None` derives it from the WGSL bindings.
    pub fn auto_profile_curve_pipeline(&self) -> &wgpu::ComputePipeline {
        self.auto_profile_curve_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("auto_profile_curve.wgsl"),
            );
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("auto-profile-curve"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("auto-profile-curve-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached AgX view-transform compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel needs BOTH generated WGSL modules: the Oklab + Rec.2020/sRGB
    /// matrices (`color_matrices.wgsl`, for the gamut-compress round-trip) and
    /// the AgX inset/outset matrices + log-encode scalars (`agx_coeffs.wgsl`,
    /// emitted by `derive_agx_lut.py --wgsl`). Both are prepended to `agx.wgsl`
    /// at module creation (WGSL has no `#include`) — same concat-at-compile
    /// pattern as `vibrance_pipeline`, extended to two generated headers. The
    /// kernel uses a 4-binding layout (params uniform + src/dst storage + the
    /// baked-LUT storage buffer); `layout: None` derives it from the bindings.
    pub fn agx_pipeline(&self) -> &wgpu::ComputePipeline {
        self.agx_pipeline.get_or_init(|| {
            let source = format!(
                "{}\n{}\n{}",
                include_str!("generated/color_matrices.wgsl"),
                include_str!("generated/agx_coeffs.wgsl"),
                include_str!("agx.wgsl"),
            );
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("agx"),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("agx-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached residual-LUT compute pipeline (epic #925 P2 / #990).
    ///
    /// The kernel is a pure trilinear 3D-LUT lookup (no Oklab), so — like
    /// `exposure.wgsl` / `white_balance.wgsl` — it compiles standalone with no
    /// generated-color-matrix concat. The per-image grid and its node count ride
    /// per-pass buffers (storage + uniform); `layout: None` derives the 4-binding
    /// layout from the WGSL bindings.
    pub fn residual_lut_pipeline(&self) -> &wgpu::ComputePipeline {
        self.residual_lut_pipeline.get_or_init(|| {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("residual-lut"),
                    source: wgpu::ShaderSource::Wgsl(include_str!("residual_lut.wgsl").into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("residual-lut-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }

    /// The cached tone-curves compute pipeline (epic #925 P2 / #990).
    ///
    /// Luma coupling uses the inlined Rec.2020 weights (not the codegen
    /// matrices), so — like `exposure.wgsl` / `white_balance.wgsl` — the kernel
    /// compiles standalone with no generated-color-matrix concat. The prepared
    /// curve slots + the branch flags ride per-pass buffers (storage + uniform);
    /// `layout: None` derives the 4-binding layout from the WGSL bindings.
    pub fn tone_curves_pipeline(&self) -> &wgpu::ComputePipeline {
        self.tone_curves_pipeline.get_or_init(|| {
            let shader = self
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("tone-curves"),
                    source: wgpu::ShaderSource::Wgsl(include_str!("tone_curves.wgsl").into()),
                });
            self.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("tone-curves-pipeline"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                })
        })
    }
}
