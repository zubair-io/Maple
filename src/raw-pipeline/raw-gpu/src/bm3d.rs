//! Two-pass BM3D on the GPU, using raw-core's tuning and DCT basis (#5099).
//! Prefix adoption and full-size latency qualification remain tracked by #5099.
//! Matching and collaborative filtering run on device. Reference patches are
//! processed in 36 fixed colors: groups of one color have disjoint support,
//! including the shortened final grid interval. Accumulation needs no atomics
//! and has deterministic summation order. All scratch uses the live frame pool.

use crate::{chain::Pass, context::GpuContext, spatial};

#[path = "../../raw-core/src/stages/bm3d/parameters.rs"]
mod parameters;
use parameters::*;
mod subgroups;

pub(crate) struct Pipelines {
    #[cfg(test)]
    subgroup_width: Option<u32>,
    sample: wgpu::ComputePipeline,
    histogram: wgpu::ComputePipeline,
    select: wgpu::ComputePipeline,
    matching: wgpu::ComputePipeline,
    prepare_luma: wgpu::ComputePipeline,
    vertical_mean: wgpu::ComputePipeline,
    horizontal_mean: wgpu::ComputePipeline,
    filter: wgpu::ComputePipeline,
    reconstruct: wgpu::ComputePipeline,
}

impl GpuContext {
    fn bm3d_pipelines(&self) -> &Pipelines {
        self.bm3d_pipelines.get_or_init(|| {
            let header = include_str!("bm3d/common.wgsl");
            let sample = format!("{header}\n{}", include_str!("bm3d/sample.wgsl"));
            let matching = format!("{header}\n{}", include_str!("bm3d/matching.wgsl"));
            let select = format!("{header}\n{}", include_str!("bm3d/select.wgsl"));
            let median = format!("{header}\n{}", include_str!("bm3d/median.wgsl"));
            let metadata = format!("{header}\n{}", include_str!("bm3d/metadata.wgsl"));
            let portable = format!("{header}\n{}", include_str!("bm3d/filter.wgsl"));
            let subgroup_width = subgroups::width(self);
            let filter = subgroup_width.map_or_else(
                || portable.clone(),
                |width| subgroups::source(&portable, width),
            );
            let reconstruct = format!("{header}\n{}", include_str!("bm3d/reconstruct.wgsl"));
            let compile = |source: &str, entry: &str| {
                crate::context_pipelines_helpers::compile_source_entry(
                    &self.device,
                    entry,
                    source,
                    entry,
                )
            };
            Pipelines {
                #[cfg(test)]
                subgroup_width,
                sample: compile(&sample, "sample_luma"),
                histogram: compile(&median, "histogram_luma"),
                select: compile(&select, "select_luma"),
                matching: compile(&matching, "match_groups"),
                prepare_luma: compile(&metadata, "prepare_luma"),
                vertical_mean: compile(&metadata, "vertical_mean"),
                horizontal_mean: compile(&metadata, "horizontal_mean"),
                filter: compile(&filter, "filter_groups"),
                reconstruct: compile(&reconstruct, "reconstruct"),
            }
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dims: [u32; 4],
    control: [u32; 4],
    scale: [f32; 4],
    extra: [f32; 4],
    sort: [u32; 4],
    luma: [f32; 4],
    highpass: [f32; 4],
    basis: [[f32; 4]; 16],
}

/// Input-referred deep denoise, in the same strength units as raw-core.
pub struct DeepDenoisePass {
    pub strength: f32,
}

impl Pass for DeepDenoisePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        (width, height): (u32, u32),
    ) {
        if self.strength < 1e-3 || width < BLOCK as u32 || height < BLOCK as u32 {
            encoder.copy_buffer_to_buffer(
                src,
                0,
                dst,
                0,
                u64::from(width) * u64::from(height) * 16,
            );
            return;
        }
        let nx = (width - BLOCK as u32).div_ceil(STRIDE as u32) + 1;
        let ny = (height - BLOCK as u32).div_ceil(STRIDE as u32) + 1;
        let samples = (width * height).div_ceil(8);

        let strength = self.strength.min(100.0) / 100.0;
        let basis = dct_basis();
        let params = Params {
            dims: [width, height, nx, ny],
            control: [0; 4],
            scale: [
                SIGMA_K * strength,
                CHROMA_SIGMA_RATIO,
                T_MATCH_SQ,
                LAMBDA_HT,
            ],
            extra: [
                ANCHOR_PEDESTAL,
                HF_K * strength,
                samples as f32,
                samples as f32,
            ],
            sort: [0, 0, BLOCK as u32, STRIDE as u32],
            luma: [
                LUMA_REC2020[0],
                LUMA_REC2020[1],
                LUMA_REC2020[2],
                SEARCH_HALF as f32,
            ],
            highpass: [
                HIGH_PASS_KERNEL[0],
                HIGH_PASS_KERNEL[1],
                HIGH_PASS_KERNEL[2],
                0.0,
            ],
            basis: std::array::from_fn(|i| std::array::from_fn(|j| basis[i / 2][(i % 2) * 4 + j])),
        };
        let pipelines = ctx.bm3d_pipelines();
        let sample = spatial::alloc_plane(ctx, samples, 1, "bm3d-luma-samples");
        let groups =
            spatial::alloc_plane(ctx, nx * ny * (GROUP_MAX as u32 + 1) + 4, 1, "bm3d-matches");
        let accum = spatial::alloc_plane(ctx, width * height, 6, "bm3d-deltas");
        let metadata = spatial::alloc_plane_vec2(ctx, width, height, "bm3d-patch-metadata");
        let vertical = spatial::alloc_plane_vec2(ctx, width, height, "bm3d-vertical-mean");
        let basic = spatial::alloc_rgba(ctx, width, height, "bm3d-basic");
        let dispatch = |encoder: &mut wgpu::CommandEncoder,
                        pipeline: &wgpu::ComputePipeline,
                        p: &Params,
                        buffers: &[&wgpu::Buffer],
                        count: u32| {
            spatial::encode_simple(
                ctx,
                encoder,
                pipeline,
                bytemuck::bytes_of(p),
                buffers,
                count,
                "bm3d",
            )
        };
        let median = spatial::alloc_plane(ctx, 260, 1, "bm3d-median-state");
        dispatch(
            encoder,
            &pipelines.sample,
            &params,
            &[src, &sample],
            samples,
        );
        encoder.clear_buffer(&median, 0, None);
        for shift in [24, 16, 8, 0] {
            encoder.clear_buffer(&median, 16, Some(1024));
            let p = Params {
                sort: [shift, 0, BLOCK as u32, STRIDE as u32],
                ..params
            };
            dispatch(
                encoder,
                &pipelines.histogram,
                &p,
                &[&sample, &median],
                samples.div_ceil(256) * 64,
            );
            dispatch(encoder, &pipelines.select, &p, &[&median], 64);
        }
        #[cfg(test)]
        tests::profile_boundary(ctx, encoder, "median");
        for wiener in 0..=1 {
            let guide = if wiener == 0 { src } else { &basic };
            let p = Params {
                control: [0, wiener, 0, 0],
                ..params
            };
            dispatch(
                encoder,
                &pipelines.prepare_luma,
                &p,
                &[guide, &metadata],
                width * height,
            );
            dispatch(
                encoder,
                &pipelines.vertical_mean,
                &p,
                &[&metadata, &vertical],
                width * height,
            );
            dispatch(
                encoder,
                &pipelines.horizontal_mean,
                &p,
                &[&vertical, &metadata],
                width * height,
            );
            dispatch(
                encoder,
                &pipelines.matching,
                &p,
                &[&metadata, &median, &groups],
                nx * ny * 64,
            );
            #[cfg(test)]
            tests::capture(ctx, encoder, &groups, "groups");
            #[cfg(test)]
            tests::profile_boundary(ctx, encoder, "matching");
            encoder.clear_buffer(&accum, 0, None);
            for color_y in 0..6 {
                for color_x in 0..6 {
                    if color_x >= nx || color_y >= ny {
                        continue;
                    }
                    let gx = (nx - color_x).div_ceil(6);
                    let gy = (ny - color_y).div_ceil(6);
                    let p = Params {
                        control: [0, wiener, color_x, color_y],
                        ..params
                    };
                    dispatch(
                        encoder,
                        &pipelines.filter,
                        &p,
                        &[src, guide, &groups, &accum],
                        gx * gy * 3 * 64,
                    );
                }
            }
            let output = if wiener == 0 { &basic } else { dst };
            #[cfg(test)]
            tests::profile_boundary(ctx, encoder, "filter");
            dispatch(
                encoder,
                &pipelines.reconstruct,
                &p,
                &[src, &accum, output],
                width * height,
            );
            #[cfg(test)]
            tests::capture(ctx, encoder, output, "output");
            #[cfg(test)]
            tests::profile_boundary(ctx, encoder, "reconstruct");
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "bm3d/tests.rs"]
mod tests;
