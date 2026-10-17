//! Complete resident BM3D RGB stage, staged for the camera prefix (#4629).
//! Median/noise selection, both collaborative passes and reconstruction stay
//! on the GPU. Shipping hosts enable this only after prefix qualification.

use crate::{
    bm3d_matching::constants::BLOCK,
    context_pipelines_helpers::compile_source_entry,
    encode_bm3d_pass,
    spatial::{alloc_plane, alloc_rgba, encode_simple, prepare_simple_dispatch, Plane},
    GpuContext, Pass,
};
use std::cell::OnceCell;

#[derive(Default)]
pub(crate) struct Pipelines([OnceCell<wgpu::ComputePipeline>; 7]);

impl Pipelines {
    fn get(&self, ctx: &GpuContext, phase: usize) -> &wgpu::ComputePipeline {
        const SOURCES: [&str; 7] = [
            include_str!("bm3d/prepare.wgsl"),
            include_str!("bm3d/histogram.wgsl"),
            include_str!("bm3d/select.wgsl"),
            include_str!("bm3d/noise.wgsl"),
            include_str!("bm3d/blur_h.wgsl"),
            include_str!("bm3d/reinject.wgsl"),
            include_str!("bm3d/reconstruct.wgsl"),
        ];
        self.0[phase].get_or_init(|| {
            let source = format!(
                "{}\n{}\n{}",
                include_str!("generated/bm3d.wgsl"),
                include_str!("bm3d/common.wgsl"),
                SOURCES[phase]
            );
            compile_source_entry(&ctx.device, "bm3d-stage", &source, "main")
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    groups: u32,
    shift: u32,
    strength: f32,
    pad: [u32; 3],
}

impl Params {
    fn new(dims: (u32, u32), strength: f32) -> Self {
        Self {
            width: dims.0,
            height: dims.1,
            groups: (dims.0 * dims.1).div_ceil(8).div_ceil(256).min(128),
            shift: 24,
            strength: strength.min(100.) / 100.,
            pad: [0; 3],
        }
    }
}

struct Prepared {
    noisy: Plane,
    noise: Plane,
    #[cfg(test)]
    state: Plane,
}

fn prepare(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    params: &Params,
) -> Prepared {
    let count = params.width * params.height;
    let noisy = alloc_rgba(ctx, params.width, params.height, "bm3d-opponent");
    let keys = alloc_plane(ctx, count.div_ceil(8), 1, "bm3d-luma-keys");
    let histograms = alloc_plane(ctx, params.groups * 256, 1, "bm3d-median-histograms");
    let state = alloc_plane(ctx, 4, 1, "bm3d-median-state");
    let noise = alloc_plane(ctx, 4, 1, "bm3d-noise-parameters");
    encode_simple(
        ctx,
        encoder,
        ctx.bm3d_pipelines.get(ctx, 0),
        bytemuck::bytes_of(params),
        &[src, &noisy, &keys],
        count,
        "bm3d-prepare",
    );
    for shift in [24, 16, 8, 0] {
        let params = Params { shift, ..*params };
        dispatch_rank(
            ctx,
            encoder,
            1,
            &params,
            &[&keys, &state, &histograms],
            params.groups,
        );
        dispatch_rank(ctx, encoder, 2, &params, &[&histograms, &state], 1);
    }
    encode_simple(
        ctx,
        encoder,
        ctx.bm3d_pipelines.get(ctx, 3),
        bytemuck::bytes_of(params),
        &[&state, &noise],
        1,
        "bm3d-noise",
    );
    Prepared {
        noisy,
        noise,
        #[cfg(test)]
        state,
    }
}

fn dispatch_rank(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    phase: usize,
    params: &Params,
    buffers: &[&wgpu::Buffer],
    groups: u32,
) {
    let pipeline = ctx.bm3d_pipelines.get(ctx, phase);
    let resources = prepare_simple_dispatch(
        ctx,
        pipeline,
        bytemuck::bytes_of(params),
        buffers,
        "bm3d-rank",
    );
    let mut pass = encoder.begin_compute_pass(&Default::default());
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
    pass.dispatch_workgroups(groups, 1, 1);
}

pub struct Bm3dPass {
    pub strength: f32,
}

impl Pass for Bm3dPass {
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
        if self.strength < 1e-3 || dims.0 < BLOCK as u32 || dims.1 < BLOCK as u32 {
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, u64::from(count) * 16);
            return;
        }
        let params = Params::new(dims, self.strength);
        let prepared = prepare(ctx, encoder, src, &params);
        let basic = alloc_rgba(ctx, dims.0, dims.1, "bm3d-basic");
        let filtered = alloc_rgba(ctx, dims.0, dims.1, "bm3d-filtered");
        let blurred = alloc_plane(ctx, dims.0, dims.1, "bm3d-blurred-luma");
        encode_bm3d_pass(
            ctx,
            encoder,
            &prepared.noisy,
            None,
            &prepared.noise,
            &basic,
            dims,
        );
        encode_bm3d_pass(
            ctx,
            encoder,
            &prepared.noisy,
            Some(&basic),
            &prepared.noise,
            &filtered,
            dims,
        );
        encode_simple(
            ctx,
            encoder,
            ctx.bm3d_pipelines.get(ctx, 4),
            bytemuck::bytes_of(&params),
            &[&prepared.noisy, &blurred],
            count,
            "bm3d-blur-h",
        );
        encode_simple(
            ctx,
            encoder,
            ctx.bm3d_pipelines.get(ctx, 5),
            bytemuck::bytes_of(&params),
            &[&prepared.noisy, &blurred, &filtered],
            count,
            "bm3d-reinject",
        );
        encode_simple(
            ctx,
            encoder,
            ctx.bm3d_pipelines.get(ctx, 6),
            bytemuck::bytes_of(&params),
            &[src, &prepared.noisy, &filtered, dst],
            count,
            "bm3d-reconstruct",
        );
    }
}

#[cfg(test)]
#[path = "bm3d/tests.rs"]
mod tests;
