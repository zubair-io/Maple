//! Defringe stage — chroma suppression at high-contrast edges (#3407).
//!
//! The GPU twin of `raw_core::stages::defringe::apply`. There is no GLOBAL
//! Defringe slider in Maple, so this pass is never pushed by the live-chain
//! builder on its own: [`crate::local_spatial::LocalSpatialPass`] runs it
//! over a scratch copy of one mask layer's output and blends the result back
//! by that layer's mask weight.
//!
//! Parity oracle is the real `raw_core::stages::defringe::apply` via the
//! test-only dev-dep — no transcribed CPU twin to drift from it. See
//! `local_spatial/tests.rs`.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared with `defringe.wgsl`. 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    width: u32,
    height: u32,
    strength: f32,
}

/// A GPU-resident defringe stage. `amount` is 0 … 100 on the same scale the
/// per-mask `defringe` control carries; below the shared 1e-3 engage
/// threshold the pass copies `src` → `dst` so the chain's ping-pong still
/// threads the (unchanged) image through, exactly as every other stage's
/// no-op branch does.
pub struct DefringePass {
    pub amount: f32,
}

impl Pass for DefringePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let count = width * height;
        if self.amount.abs() < 1e-3 || count == 0 {
            let byte_len = (count as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        let params = Params {
            count,
            width,
            height,
            strength: (self.amount / 100.0).clamp(0.0, 1.0),
        };
        encode_simple(
            ctx,
            encoder,
            ctx.defringe_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            count,
            "defringe",
        );
    }
}
