//! Final display-encoded manual warp (#2435). Matrix preparation lives in raw-core.
use crate::{chain::Pass, context::GpuContext, spatial::encode_simple};

pub struct GeometryPass {
    pub inverse: [[f32; 3]; 3],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    rows: [[f32; 4]; 3],
    width: u32,
    height: u32,
    count: u32,
    pad: u32,
}

impl Pass for GeometryPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let params = Params {
            rows: self.inverse.map(|r| [r[0], r[1], r[2], 0.0]),
            width: dims.0,
            height: dims.1,
            count: dims.0 * dims.1,
            pad: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.geometry_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            params.count,
            "manual-geometry",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
