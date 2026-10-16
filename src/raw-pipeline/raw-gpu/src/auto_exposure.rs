//! Exact-rank scene anchoring on the GPU, staged for live camera WB (#4629).
//!
//! Four radix passes select the CPU's quartile-band boundaries and P95 without
//! binning error, sampling, a CPU readback or a full sort. Boundary counts keep
//! the trimmed geometric mean correct when a percentile splits equal values.
//! The log sum uses compensated partials; transcendental/f32 error is qualified
//! against raw-core. This stage is not enabled in live hosts until the remaining
//! pre-AE spatial stages also retain the CPU's order.

use crate::{
    context::GpuContext,
    context_pipelines_helpers::compile_with_matrices,
    spatial::{alloc_plane, encode_simple, prepare_simple_dispatch},
    Pass,
};
use std::cell::OnceCell;

#[derive(Default)]
pub(crate) struct Pipelines([OnceCell<wgpu::ComputePipeline>; 6]);

impl Pipelines {
    fn get(&self, ctx: &GpuContext, phase: usize) -> &wgpu::ComputePipeline {
        const SOURCES: [&str; 6] = [
            include_str!("auto_exposure/keys.wgsl"),
            include_str!("auto_exposure/histogram.wgsl"),
            include_str!("auto_exposure/select.wgsl"),
            include_str!("auto_exposure/sum.wgsl"),
            include_str!("auto_exposure/gain.wgsl"),
            include_str!("auto_exposure/apply.wgsl"),
        ];
        self.0[phase].get_or_init(|| {
            compile_with_matrices(
                &ctx.device,
                "auto-exposure",
                &format!(
                    "{}\n{}",
                    include_str!("auto_exposure/common.wgsl"),
                    SOURCES[phase]
                ),
            )
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    groups: u32,
    shift: u32,
    pad: u32,
}

/// The CPU's On mode over scene-linear Rec.2020 RGBA. Off mode omits the pass.
/// All finite luminance samples participate; signed/HDR RGB and alpha survive.
pub struct AutoExposurePass;

impl Pass for AutoExposurePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let count = dims.0 * dims.1;
        if count == 0 {
            return;
        }
        let groups = count.div_ceil(256).min(128);
        let keys = alloc_plane(ctx, count, 1, "ae-ordered-luminance");
        let histogram = alloc_plane(ctx, groups * 3 * 256, 1, "ae-radix-histograms");
        let state = alloc_plane(ctx, 16, 1, "ae-rank-state");
        let sums = alloc_plane(ctx, groups * 4, 1, "ae-log-partials");
        let gain = alloc_plane(ctx, 4, 1, "ae-gain");
        let params = Params {
            count,
            groups,
            shift: 24,
            pad: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.auto_exposure_pipelines.get(ctx, 0),
            bytemuck::bytes_of(&params),
            &[src, &keys],
            count,
            "ae-keys",
        );
        for shift in [24, 16, 8, 0] {
            let params = Params { shift, ..params };
            dispatch(
                ctx,
                encoder,
                1,
                &params,
                &[&keys, &state, &histogram],
                groups,
            );
            dispatch(ctx, encoder, 2, &params, &[&histogram, &state], 1);
        }
        dispatch(ctx, encoder, 3, &params, &[&keys, &state, &sums], groups);
        dispatch(ctx, encoder, 4, &params, &[&state, &sums, &gain], 1);
        encode_simple(
            ctx,
            encoder,
            ctx.auto_exposure_pipelines.get(ctx, 5),
            bytemuck::bytes_of(&params),
            &[src, &gain, dst],
            count,
            "ae-apply",
        );
    }
}

fn dispatch(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    phase: usize,
    params: &Params,
    buffers: &[&wgpu::Buffer],
    groups: u32,
) {
    let pipeline = ctx.auto_exposure_pipelines.get(ctx, phase);
    let pooled = prepare_simple_dispatch(
        ctx,
        pipeline,
        bytemuck::bytes_of(params),
        buffers,
        "ae-reduce",
    );
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("ae-reduce"),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, pooled.bind_group.as_ref(), &[]);
    pass.dispatch_workgroups(groups, 1, 1);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "auto_exposure/tests.rs"]
mod tests;
