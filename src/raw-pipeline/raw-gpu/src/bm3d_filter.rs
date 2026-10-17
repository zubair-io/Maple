//! Resident BM3D collaborative filtering, staged with matching under #4629.
//! One workgroup owns one channel/group; no floating-point atomics or readback.

use crate::{
    bm3d_matching::constants::{BLOCK, GROUP_MAX},
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_plane, prepare_simple_dispatch, Plane},
    GpuBm3dMatchRow, GpuContext,
};

pub struct GpuBm3dFilteredRow {
    pub buffer: Plane,
    pub columns: u32,
}

impl GpuBm3dFilteredRow {
    pub const RECORD_WORDS: usize = 4 + GROUP_MAX * BLOCK * BLOCK;

    pub(crate) fn new(ctx: &GpuContext, columns: u32) -> Self {
        let buffer = alloc_plane(
            ctx,
            columns * 3 * Self::RECORD_WORDS as u32,
            1,
            "bm3d-filter-row",
        );
        Self { buffer, columns }
    }

    /// Qualification only. Records are column-major, then Y/C1/C2; each stores
    /// the weight, three padding words, then weighted (estimate - noisy) deltas.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_back_blocking(&self, ctx: &GpuContext) -> Vec<f32> {
        pollster::block_on(crate::chain::read_buffer_async(
            ctx,
            &self.buffer,
            self.columns as u64 * 3 * Self::RECORD_WORDS as u64 * 4,
        ))
        .expect("BM3D filter readback")
    }
}

/// Noisy and optional basic-estimate buffers pack `[Y,C1,C2,unused]` per pixel.
/// Omit the guide for hard thresholding; supply it for the Wiener pass.
pub fn encode_bm3d_filter_row(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    noisy: &wgpu::Buffer,
    guide: Option<&wgpu::Buffer>,
    matches: &GpuBm3dMatchRow,
    dims: (u32, u32),
) -> GpuBm3dFilteredRow {
    let row = GpuBm3dFilteredRow::new(ctx, matches.columns);
    encode_into(ctx, encoder, noisy, guide, matches, dims, &row);
    row
}

pub(crate) fn encode_into(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    noisy: &wgpu::Buffer,
    guide: Option<&wgpu::Buffer>,
    matches: &GpuBm3dMatchRow,
    dims: (u32, u32),
    row: &GpuBm3dFilteredRow,
) {
    assert_eq!(matches.columns, row.columns);
    let pipeline = ctx.bm3d_filter_pipeline.get_or_init(|| {
        let source = format!(
            "{}\n{}\n{}",
            include_str!("generated/bm3d.wgsl"),
            include_str!("bm3d_types.wgsl"),
            include_str!("bm3d_filter.wgsl")
        );
        compile_source_entry(&ctx.device, "bm3d-filter", &source, "main")
    });
    let resources = prepare_simple_dispatch(
        ctx,
        pipeline,
        bytemuck::cast_slice(&[dims.0, dims.1, u32::from(guide.is_some()), 0]),
        &[noisy, guide.unwrap_or(noisy), &matches.buffer, &row.buffer],
        "bm3d-filter-row",
    );
    let mut pass = encoder.begin_compute_pass(&Default::default());
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
    pass.dispatch_workgroups(matches.columns, 3, 1);
}
