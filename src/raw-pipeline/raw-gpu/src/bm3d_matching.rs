//! Joint block matching for the staged resident BM3D port (#4629).
//! Row outputs feed collaborative filtering and ordered aggregation; shipping
//! hosts remain unchanged until the full stage and boundary are qualified.

use crate::{
    context_pipelines_helpers::compile_source_entry,
    spatial::{alloc_plane, prepare_simple_dispatch, Plane},
    GpuContext,
};

#[path = "generated/bm3d.rs"]
#[allow(dead_code)] // The WGSL and Rust hosts share the complete matching constants.
pub(crate) mod constants;
use constants::{BLOCK, GROUP_MAX, STRIDE};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuBm3dMatches {
    pub count: u32,
    pub sigmas: [f32; 3],
    pub positions: [[u32; 2]; GROUP_MAX],
}

pub struct GpuBm3dMatchRow {
    pub buffer: Plane,
    pub columns: u32,
}

impl GpuBm3dMatchRow {
    pub(crate) fn new(ctx: &GpuContext, width: u32) -> Self {
        assert!(width >= BLOCK as u32);
        let columns = (width - BLOCK as u32).div_ceil(STRIDE as u32) + 1;
        let words = std::mem::size_of::<GpuBm3dMatches>() as u32 / 4;
        let buffer = alloc_plane(ctx, columns * words, 1, "bm3d-match-row");
        Self { buffer, columns }
    }
    /// Qualification readback only; the resident stage consumes the buffer.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_back_blocking(&self, ctx: &GpuContext) -> Vec<GpuBm3dMatches> {
        let bytes = self.columns as u64 * std::mem::size_of::<GpuBm3dMatches>() as u64;
        let words = pollster::block_on(crate::chain::read_buffer_async(ctx, &self.buffer, bytes))
            .expect("BM3D match readback");
        bytemuck::cast_slice(&words).to_vec()
    }
}

/// Luma and noise parameters stay on the GPU across WB updates. `threshold`
/// holds `[tau_squared, sigma_y, sigma_c1, sigma_c2]`. The matching row carries
/// those sigmas to filtering without another storage binding or CPU readback.
/// `reference_y` is one CPU-grid row; storage is bounded to that row's groups.
pub fn encode_bm3d_match_row(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    luma: &wgpu::Buffer,
    threshold: &wgpu::Buffer,
    dims: (u32, u32),
    reference_y: u32,
) -> GpuBm3dMatchRow {
    let row = GpuBm3dMatchRow::new(ctx, dims.0);
    encode_into(ctx, encoder, luma, threshold, dims, reference_y, &row);
    row
}

pub(crate) fn encode_into(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    luma: &wgpu::Buffer,
    threshold: &wgpu::Buffer,
    dims: (u32, u32),
    reference_y: u32,
    row: &GpuBm3dMatchRow,
) {
    assert!(dims.0 >= BLOCK as u32 && dims.1 >= BLOCK as u32);
    assert!(reference_y <= dims.1 - BLOCK as u32);
    let columns = row.columns;
    let pipeline = ctx.bm3d_matching_pipeline.get_or_init(|| {
        let source = format!(
            "{}\n{}\n{}",
            include_str!("generated/bm3d.wgsl"),
            include_str!("bm3d_types.wgsl"),
            include_str!("bm3d_matching.wgsl")
        );
        compile_source_entry(&ctx.device, "bm3d-matching", &source, "main")
    });
    let resources = prepare_simple_dispatch(
        ctx,
        pipeline,
        bytemuck::cast_slice(&[dims.0, dims.1, reference_y, columns]),
        &[luma, threshold, &row.buffer],
        "bm3d-match-row",
    );
    let mut pass = encoder.begin_compute_pass(&Default::default());
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, resources.bind_group.as_ref(), &[]);
    pass.dispatch_workgroups(columns, 1, 1);
}

#[cfg(test)]
#[path = "bm3d_matching_tests.rs"]
mod tests;
