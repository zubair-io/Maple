//! Private helper functions for the `GpuContext` pipeline accessors.
//!
//! Split out of `context_pipelines.rs` to keep that file under the 600-LOC
//! hard budget. These are crate-private free functions, imported explicitly
//! by the accessor file.

/// Compile a standalone WGSL kernel (no generated-matrix concat) into a cached
/// compute pipeline with an auto-derived bind-group layout. The common case;
/// an alias for [`compile_source`] that reads at the call site as "this kernel
/// needs no generated header."
pub(crate) fn compile_standalone(
    device: &wgpu::Device,
    label: &str,
    source: &str,
) -> wgpu::ComputePipeline {
    compile_source(device, label, source)
}

/// Compile a WGSL kernel that calls the generated Oklab / color-matrix helpers,
/// by prepending `generated/color_matrices.wgsl` (WGSL has no `#include`). The
/// concat-at-compile pattern every Oklab / matrix fan-out stage shares.
pub(crate) fn compile_with_matrices(
    device: &wgpu::Device,
    label: &str,
    kernel: &str,
) -> wgpu::ComputePipeline {
    let source = format!(
        "{}\n{}",
        include_str!("generated/color_matrices.wgsl"),
        kernel
    );
    compile_source(device, label, &source)
}

/// Compile one of `noise_reduction.wgsl`'s entry points (epic #925 P3 / #991).
/// The module rounds pixels through Oklab, so it concats the generated color
/// matrices (like `compile_with_matrices`); `entry` selects which `@compute` fn
/// the pipeline targets, since all five NLM kernels share one source file.
pub(crate) fn compile_nr(device: &wgpu::Device, label: &str, entry: &str) -> wgpu::ComputePipeline {
    let source = format!(
        "{}\n{}",
        include_str!("generated/color_matrices.wgsl"),
        include_str!("noise_reduction.wgsl"),
    );
    compile_source_entry(device, label, &source, entry)
}

/// Compile one of `capture_sharpening.wgsl`'s entry points (epic #925 P3 wave 2 /
/// #991). The module is luma-only (no Oklab), so it needs NO generated-matrix
/// concat — it compiles standalone; `entry` selects which `@compute` fn the
/// pipeline targets, since all five capture-sharpening kernels share one source.
pub(crate) fn compile_cs(device: &wgpu::Device, label: &str, entry: &str) -> wgpu::ComputePipeline {
    compile_source_entry(
        device,
        label,
        include_str!("capture_sharpening.wgsl"),
        entry,
    )
}

/// The shared module-create + pipeline-create boilerplate behind every accessor,
/// for the common single-entry-point (`main`) case.
pub(crate) fn compile_source(
    device: &wgpu::Device,
    label: &str,
    source: &str,
) -> wgpu::ComputePipeline {
    compile_source_entry(device, label, source, "main")
}

/// As [`compile_source`], but selects a named `@compute` entry point — for WGSL
/// modules that pack several kernels (the NLM stage's five entry points).
pub(crate) fn compile_source_entry(
    device: &wgpu::Device,
    label: &str,
    source: &str,
    entry: &str,
) -> wgpu::ComputePipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(&format!("{label}-pipeline")),
        layout: None,
        module: &shader,
        entry_point: Some(entry),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    })
}
