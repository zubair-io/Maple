//! Texture stage — a P2 wave-3b SPATIAL stage (epic #925 / #990).
//!
//! Texture IS clarity at a different scale. `raw_core::stages::texture::apply` is
//! byte-for-byte `raw_core::stages::clarity::apply` with the guided-filter radius
//! changed from 20 (structure scale) to 2 (fine-detail scale) — same eps, same
//! Rec.2020 luma weights, same luma floor, same base/detail recombine. So this
//! stage reuses the WHOLE spatial pipeline clarity established
//! ([`crate::spatial::clarity_texture_encode`]) and the shared CPU oracle
//! ([`crate::clarity::apply_guided_clarity`]) — only the radius constant differs.
//!
//! Two pieces (the spatial machinery is already shared):
//! 1. [`apply_texture`] — the CPU oracle: the shared guided-clarity port at
//!    radius 2 (parity-pinned to `raw_core::stages::texture::apply` below).
//! 2. [`TexturePass`] — the GPU-resident stage; drives `clarity_texture_encode`
//!    at the fine-detail radius (2) inside `encode`.
//!
//! The headless parity test (`texture/tests.rs`) gates GPU vs the real
//! `raw_core::stages::texture::apply` `< 1e-4` on a border-varying image — the
//! same non-vacuous edge-coverage discipline as clarity, at the smaller radius.

use crate::chain::Pass;
use crate::clarity::apply_guided_clarity;
use crate::context::GpuContext;
use crate::spatial;

/// Guided-filter window radius for texture's fine-detail scale (effective reach
/// `2r = 4` px per side). Mirrors `raw_core::stages::texture`'s
/// `TEXTURE_GUIDED_RADIUS` (a private const there; pinned by the parity test).
pub const TEXTURE_GUIDED_RADIUS: u32 = 2;

/// Luminance-preserving local-contrast enhancement at the fine-detail scale
/// (~4 px effective reach), on an interleaved RGBA f32 buffer (alpha untouched).
/// The CPU oracle — `raw_core::stages::texture::apply` is clarity's body at
/// radius 2, so this delegates to the shared [`apply_guided_clarity`] with
/// `radius = 2`. `texture` in [-100, +100]; `|texture| < 1e-3` is a no-op.
pub fn apply_texture(buf: &mut [f32], width: usize, height: usize, texture: f32) {
    apply_guided_clarity(buf, width, height, texture, TEXTURE_GUIDED_RADIUS as usize);
}

/// A GPU-resident texture stage. Carries only its `texture` slider value
/// ([-100, +100]); device, pipelines, and scratch buffers come from the
/// [`GpuContext`] / spatial substrate at encode time. Drives the shared
/// clarity/texture spatial pipeline at the fine-detail radius (2).
pub struct TexturePass {
    pub texture: f32,
}

impl Pass for TexturePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        // |texture| < 1e-3 is identity in raw-core — copy src → dst and bail so
        // the chain's ping-pong still threads the (unchanged) image through.
        if self.texture.abs() < 1e-3 {
            let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        spatial::clarity_texture_encode(
            ctx,
            encoder,
            src,
            dst,
            spatial::ClarityTextureArgs {
                width,
                height,
                r: TEXTURE_GUIDED_RADIUS,
                amount: self.texture / 100.0,
            },
        );
    }
}

// Parity tests live in a sibling file (mirrors clarity's split). Native only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "texture/tests.rs"]
mod tests;
