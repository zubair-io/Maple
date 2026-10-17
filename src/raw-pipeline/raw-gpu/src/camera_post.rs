//! Post-DCP operations required by the resident camera prefix (#4629).
//! These complete kernels remain staged until retouch/deep denoise and the
//! persistent host boundary can move together in canonical CPU stage order.

use crate::{chain::Pass, context::GpuContext, spatial::encode_simple};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    count: u32,
    strength: f32,
}

pub struct OklabHighlightRecoveryPass;

impl Pass for OklabHighlightRecoveryPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let params = Params {
            width: dims.0,
            height: dims.1,
            count: dims.0 * dims.1,
            strength: 0.0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.oklab_highlight_recovery_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            params.count,
            "oklab-highlight-recovery",
        );
    }
}

pub struct ChromaPrefilterPass {
    pub strength: f32,
}

impl Pass for ChromaPrefilterPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let params = Params {
            width: dims.0,
            height: dims.1,
            count: dims.0 * dims.1,
            strength: self.strength,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.chroma_prefilter_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            params.count,
            "chroma-prefilter",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "camera_post/tests.rs"]
mod tests;
