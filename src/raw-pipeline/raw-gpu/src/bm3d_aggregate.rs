//! Deterministic BM3D overlap aggregation (#4629).
//! Reference rows must be encoded in CPU grid order. Each pixel then adds
//! column/member contributions in the same order, without float atomics.

use crate::{
    bm3d_matching::constants::{BLOCK, SEARCH_HALF, STRIDE},
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_rgba, encode_simple, Plane},
    GpuBm3dFilteredRow, GpuBm3dMatchRow, GpuContext,
};

pub(crate) struct GpuBm3dAccumulator {
    numerator: Plane,
    denominator: Plane,
    dims: (u32, u32),
}

impl GpuBm3dAccumulator {
    pub(crate) fn new(
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        dims: (u32, u32),
    ) -> Self {
        let numerator = alloc_rgba(ctx, dims.0, dims.1, "bm3d-numerator");
        let denominator = alloc_rgba(ctx, dims.0, dims.1, "bm3d-denominator");
        encoder.clear_buffer(&numerator, 0, None);
        encoder.clear_buffer(&denominator, 0, None);
        Self {
            numerator,
            denominator,
            dims,
        }
    }
}

pub(crate) fn encode_bm3d_aggregate_rows(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    matches: &GpuBm3dMatchRow,
    filtered: &GpuBm3dFilteredRow,
    accumulator: &GpuBm3dAccumulator,
    reference_y: u32,
    rows: u32,
) {
    assert_eq!(matches.columns, filtered.columns);
    let (width, height) = accumulator.dims;
    let first_y = reference_y.saturating_sub(SEARCH_HALF as u32);
    let last_reference = (reference_y + (rows - 1) * STRIDE as u32).min(height - BLOCK as u32);
    let last_y = (last_reference + SEARCH_HALF as u32 + BLOCK as u32).min(height);
    let count = width * (last_y - first_y);
    let pipeline = ctx.bm3d_aggregate_pipeline.get_or_init(|| {
        let source = format!(
            "{}\n{}\n{}",
            include_str!("generated/bm3d.wgsl"),
            include_str!("bm3d_types.wgsl"),
            include_str!("bm3d_aggregate.wgsl")
        );
        compile_source_entry(&ctx.device, "bm3d-aggregate", &source, "main")
    });
    encode_simple(
        ctx,
        encoder,
        pipeline,
        bytemuck::cast_slice(&[
            width,
            count,
            first_y,
            matches.columns,
            reference_y,
            rows,
            height,
            0,
        ]),
        &[
            &matches.buffer,
            &filtered.buffer,
            &accumulator.numerator,
            &accumulator.denominator,
        ],
        count,
        "bm3d-aggregate-row",
    );
}

pub(crate) fn encode_bm3d_finish(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    noisy: &wgpu::Buffer,
    accumulator: &GpuBm3dAccumulator,
    dst: &wgpu::Buffer,
) {
    let (width, height) = accumulator.dims;
    let pipeline = ctx.bm3d_finish_pipeline.get_or_init(|| {
        compile_source_entry(
            &ctx.device,
            "bm3d-finish",
            include_str!("bm3d_finish.wgsl"),
            "main",
        )
    });
    encode_simple(
        ctx,
        encoder,
        pipeline,
        bytemuck::cast_slice(&[width * height, 0, 0, 0]),
        &[noisy, &accumulator.numerator, &accumulator.denominator, dst],
        width * height,
        "bm3d-finish",
    );
}
