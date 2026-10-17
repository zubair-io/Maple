//! One complete resident BM3D hard-threshold or Wiener pass (#4629).
//! This consumes opponent channels; median anchoring, RGB conversion and
//! high-frequency reconstruction remain part of the full-stage integration.

use crate::{
    bm3d_aggregate::{encode_bm3d_aggregate_row, encode_bm3d_finish, GpuBm3dAccumulator},
    bm3d_matching::constants::{BLOCK, STRIDE},
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_plane, encode_simple},
    GpuBm3dFilteredRow, GpuBm3dMatchRow, GpuContext,
};

/// Parameters contain `[tau_squared, sigma_y, sigma_c1, sigma_c2]`. Inputs are
/// packed opponent channels. Every reference row shares the same two scratch
/// row buffers, consumed by aggregation before the next row overwrites them.
pub fn encode_bm3d_pass(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    noisy: &wgpu::Buffer,
    guide: Option<&wgpu::Buffer>,
    parameters: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    dims: (u32, u32),
) {
    assert!(dims.0 >= BLOCK as u32 && dims.1 >= BLOCK as u32);
    let luma = alloc_plane(ctx, dims.0, dims.1, "bm3d-luma");
    let pipeline = ctx.bm3d_luma_pipeline.get_or_init(|| {
        compile_source_entry(
            &ctx.device,
            "bm3d-luma",
            include_str!("bm3d_luma.wgsl"),
            "main",
        )
    });
    let count = dims.0 * dims.1;
    encode_simple(
        ctx,
        encoder,
        pipeline,
        bytemuck::cast_slice(&[count, 0, 0, 0]),
        &[guide.unwrap_or(noisy), &luma],
        count,
        "bm3d-luma",
    );
    let matches = GpuBm3dMatchRow::new(ctx, dims.0);
    let filtered = GpuBm3dFilteredRow::new(ctx, matches.columns);
    let accum = GpuBm3dAccumulator::new(ctx, encoder, dims);
    let last_y = dims.1 - BLOCK as u32;
    for ry in (0..last_y).step_by(STRIDE).chain(std::iter::once(last_y)) {
        crate::bm3d_matching::encode_into(ctx, encoder, &luma, parameters, dims, ry, &matches);
        crate::bm3d_filter::encode_into(ctx, encoder, noisy, guide, &matches, dims, &filtered);
        encode_bm3d_aggregate_row(ctx, encoder, &matches, &filtered, &accum, ry);
    }
    encode_bm3d_finish(ctx, encoder, noisy, &accum, dst);
}

#[cfg(test)]
#[path = "bm3d_pass_tests.rs"]
mod tests;
