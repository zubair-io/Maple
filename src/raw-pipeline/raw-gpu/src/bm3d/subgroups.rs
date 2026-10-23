//! Optional native subgroup acceleration. A one-time device probe verifies
//! lane ordering; devices without the required layout keep the portable path.
use crate::context::GpuContext;

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn width(ctx: &GpuContext) -> Option<u32> {
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

pub(super) fn source(portable: &str, width: u32) -> String {
    let source = format!(
        "const SUBGROUP_WIDTH:u32={width}u;\n{portable}\n{}",
        include_str!("filter_axes_subgroup.wgsl")
    );
    source
        .replace(
            "patch_means(v,lane,false,n)",
            "patch_means_fast(v,lane,false,n)",
        )
        .replace(
            "patch_means(b,lane,true,n)",
            "patch_means_fast(b,lane,true,n)",
        )
        .replace(
            "spatial_transform(v,lane,false)",
            "spatial_transform_fast(v,lane,false)",
        )
        .replace(
            "spatial_transform(b,lane,false)",
            "spatial_transform_fast(b,lane,false)",
        )
        .replace(
            "spatial_transform(v,lane,true)",
            "spatial_transform_fast(v,lane,true)",
        )
        .replace(
            "    finish_means(lane,n,wiener,sigma);",
            "    finish_means_fast(lane,n,wiener,sigma);",
        )
}
