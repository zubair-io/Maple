//! GPU twin of the capture-stage chroma prefilter (#5217).
//! Every pixel reads the same immutable neighborhood as raw-core. Parameters
//! come directly from its source; uniforms and bindings use the live pool.

use crate::{chain::Pass, context::GpuContext};

#[path = "../../raw-core/src/stages/chroma_prefilter_params.rs"]
mod parameters;
use parameters::*;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    sigma: f32,
    pedestal: f32,
    luma: [f32; 4],
    taps: [[f32; 4]; 8],
}

impl GpuContext {
    fn chroma_prefilter_pipeline(&self) -> &wgpu::ComputePipeline {
        self.chroma_prefilter_pipeline.get_or_init(|| {
            crate::context_pipelines_helpers::compile_standalone(
                &self.device,
                "chroma-prefilter",
                include_str!("chroma_prefilter.wgsl"),
            )
        })
    }
}

/// A sparse cross-bilateral chroma filter preserving scene luma and alpha.
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
        (width, height): (u32, u32),
    ) {
        if self.strength < 1e-3 {
            encoder.copy_buffer_to_buffer(
                src,
                0,
                dst,
                0,
                u64::from(width) * u64::from(height) * 16,
            );
            return;
        }
        let params = Params {
            width,
            height,
            sigma: SIGMA_MAX_REL * (self.strength.min(100.0) / 100.0),
            pedestal: PEDESTAL,
            luma: [LUMA_REC2020[0], LUMA_REC2020[1], LUMA_REC2020[2], 0.0],
            taps: std::array::from_fn(|i| [TAPS[i].0 as f32, TAPS[i].1 as f32, SPATIAL_W[i], 0.0]),
        };
        crate::spatial::encode_simple(
            ctx,
            encoder,
            ctx.chroma_prefilter_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            width * height,
            "chroma-prefilter",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "chroma_prefilter/tests.rs"]
mod tests;
