//! Optional native subgroup acceleration. A one-time device probe verifies
//! lane ordering; devices without the required layout keep the portable path.
use crate::context::GpuContext;

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn width(ctx: &GpuContext) -> Option<u32> {
    #[cfg(test)]
    if FORCE_PORTABLE.with(|flag| flag.get()) {
        return None;
    }
    if !ctx.device.features().contains(wgpu::Features::SUBGROUP) {
        return None;
    }
    let source = r#"
        @group(0) @binding(0) var<storage,read_write> out: array<u32>;
        @compute @workgroup_size(256)
        fn main(@builtin(local_invocation_index) lane:u32,
                @builtin(subgroup_size) width:u32,
                @builtin(subgroup_invocation_id) subgroup_lane:u32) {
            if lane==0u { out[0]=width; }
            out[1u+lane]=subgroup_lane;
        }
    "#;
    let pipeline = crate::context_pipelines_helpers::compile_source(
        &ctx.device,
        "bm3d-subgroup-probe",
        source,
    );
    let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("bm3d-subgroup-layout"),
        size: 257 * 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let bindings = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bm3d-subgroup-layout"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bindings, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    ctx.queue.submit(Some(encoder.finish()));
    let values = pollster::block_on(crate::chain::read_buffer_async(ctx, &buffer, 257 * 4)).ok()?;
    let width = values[0].to_bits();
    if ![32, 64].contains(&width) {
        return None;
    }
    values[1..]
        .iter()
        .enumerate()
        .all(|(lane, id)| id.to_bits() == lane as u32 % width)
        .then_some(width)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn width(_: &GpuContext) -> Option<u32> {
    None
}

/// Assemble exactly one implementation of each helper. No source rewriting.
pub(super) fn source(
    header: &str,
    shared: &str,
    kernel: &str,
    portable: &str,
    native: &str,
    width: Option<u32>,
) -> String {
    match width {
        Some(width) => {
            format!("const SUBGROUP_WIDTH:u32={width}u;\n{header}\n{shared}\n{native}\n{kernel}")
        }
        None => format!("{header}\n{shared}\n{portable}\n{kernel}"),
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static FORCE_PORTABLE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
