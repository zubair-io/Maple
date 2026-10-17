//! One complete resident BM3D hard-threshold or Wiener pass (#4629).
//! Small batches of reference rows share scratch; aggregation retains CPU order.

use crate::{
    bm3d_aggregate::{encode_bm3d_aggregate_rows, encode_bm3d_finish, GpuBm3dAccumulator},
    bm3d_matching::constants::{BLOCK, STRIDE},
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_plane, encode_simple},
    GpuBm3dFilteredRow, GpuBm3dMatchRow, GpuContext,
};

/// Parameters contain `[tau_squared, sigma_y, sigma_c1, sigma_c2]`. Inputs are
/// packed opponent channels. Reference batches share two scratch buffers,
/// consumed by ordered aggregation before the next batch overwrites them.
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
    let rows = rows_per_batch(dims.0, &ctx.device.limits());
    encode_with_rows(ctx, encoder, noisy, guide, parameters, dst, dims, rows);
}

fn rows_per_batch(width: u32, limits: &wgpu::Limits) -> u32 {
    let columns = (width - BLOCK as u32).div_ceil(STRIDE as u32) + 1;
    let bytes_per_row = columns * 3 * GpuBm3dFilteredRow::RECORD_WORDS as u32 * 4;
    8.min(limits.max_storage_buffer_binding_size / bytes_per_row)
        .min(limits.max_compute_workgroups_per_dimension / columns)
        .max(1)
}

fn encode_with_rows(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    noisy: &wgpu::Buffer,
    guide: Option<&wgpu::Buffer>,
    parameters: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    dims: (u32, u32),
    batch_rows: u32,
) {
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
    let last_y = dims.1 - BLOCK as u32;
    let reference_rows = last_y.div_ceil(STRIDE as u32) + 1;
    let batch_rows = batch_rows.min(reference_rows);
    let matches = GpuBm3dMatchRow::new_batch(ctx, dims.0, batch_rows);
    let filtered = GpuBm3dFilteredRow::new_batch(ctx, matches.columns, batch_rows);
    let accum = GpuBm3dAccumulator::new(ctx, encoder, dims);
    for first in (0..reference_rows).step_by(batch_rows as usize) {
        let ry = (first * STRIDE as u32).min(last_y);
        let rows = batch_rows.min(reference_rows - first);
        crate::bm3d_matching::encode_batch_into(
            ctx, encoder, &luma, parameters, dims, ry, rows, &matches,
        );
        crate::bm3d_filter::encode_batch_into(
            ctx, encoder, noisy, guide, &matches, dims, rows, &filtered,
        );
        encode_bm3d_aggregate_rows(ctx, encoder, &matches, &filtered, &accum, ry, rows);
    }
    encode_bm3d_finish(ctx, encoder, noisy, &accum, dst);
}

#[cfg(test)]
#[path = "bm3d_pass_tests.rs"]
mod tests;
