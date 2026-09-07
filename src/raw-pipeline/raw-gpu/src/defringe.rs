//! Defringe stage — chroma suppression at high-contrast edges (#3407
//! per-mask, #3411 global).
//!
//! The GPU twin of `raw_core::stages::defringe::apply_params`, and like the
//! CPU stage it is ONE kernel serving both callers off a superset of their
//! parameters:
//!
//! * [`crate::local_spatial::LocalSpatialPass`] runs it over a scratch copy
//!   of one mask layer's output and blends the result back by that layer's
//!   mask weight, driven by the per-mask control's single `0 … 100` amount
//!   ([`DefringeInputs::per_mask`]). That path sets no hue band, so the
//!   kernel never evaluates a hue and its output is bit-identical to the
//!   single-amount kernel it replaces.
//! * The live-chain builder pushes it at develop's 12a slot when the global
//!   ACR controls are engaged — two amounts, each with a hue band.
//!
//! Parity oracle is the real `raw_core::stages::defringe::apply_params` via
//! the test-only dev-dep — no transcribed CPU twin to drift from it. See
//! `defringe/tests.rs` (global bands) and `local_spatial/tests.rs`
//! (per-mask).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared with `defringe.wgsl`. 48 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    width: u32,
    height: u32,
    /// Non-zero when either hue band can claim a pixel. Zero for the
    /// per-mask caller, which is what lets the kernel skip the hue
    /// evaluation entirely and stay bit-identical to the pre-#3411 pass.
    bands_active: u32,
    all_hues_strength: f32,
    purple_strength: f32,
    purple_lo: f32,
    purple_hi: f32,
    green_strength: f32,
    green_lo: f32,
    green_hi: f32,
    _pad: f32,
}

/// The resolved slider set the pass carries — `raw_core::stages::defringe::
/// DefringeParams` in the FFI's own words. Strengths are already normalised
/// to `[0, 1]`; the band edges are ACR's `[0, 100]` axis values as authored.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct DefringeInputs {
    /// Hue-agnostic strength — the per-mask control (#3407).
    pub all_hues_strength: f32,
    pub purple_strength: f32,
    pub purple_lo: f32,
    pub purple_hi: f32,
    pub green_strength: f32,
    pub green_lo: f32,
    pub green_hi: f32,
}

impl DefringeInputs {
    /// The per-mask control's inputs: one `0 … 100` amount, every hue.
    /// Mirrors `raw_core::stages::defringe::DefringeParams::per_mask`.
    pub fn per_mask(amount: f32) -> Self {
        Self {
            all_hues_strength: (amount / 100.0).clamp(0.0, 1.0),
            ..Self::default()
        }
    }

    fn bands_engaged(&self) -> bool {
        self.purple_strength > 0.0 || self.green_strength > 0.0
    }

    /// Whether the stage does anything — the SAME predicate raw-core
    /// applies, so the live builder can't include a pass the CPU chain
    /// would have skipped (or vice versa).
    pub fn is_engaged(&self) -> bool {
        self.all_hues_strength > 0.0 || self.bands_engaged()
    }
}

/// A GPU-resident defringe stage. When the inputs are inert the pass copies
/// `src` → `dst` so the chain's ping-pong still threads the (unchanged)
/// image through, exactly as every other stage's no-op branch does — the
/// local-spatial path relies on that.
pub struct DefringePass {
    pub inputs: DefringeInputs,
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
        if !self.inputs.is_engaged() || count == 0 {
            let byte_len = (count as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        let params = Params {
            count,
            width,
            height,
            bands_active: u32::from(self.inputs.bands_engaged()),
            all_hues_strength: self.inputs.all_hues_strength,
            purple_strength: self.inputs.purple_strength,
            purple_lo: self.inputs.purple_lo,
            purple_hi: self.inputs.purple_hi,
            green_strength: self.inputs.green_strength,
            green_lo: self.inputs.green_lo,
            green_hi: self.inputs.green_hi,
            _pad: 0.0,
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

// The global-band parity tests live in a sibling file to keep this module
// under the 600-LOC budget (mirrors saturation / vignette). The per-mask
// path's parity is gated by `local_spatial/tests.rs`. Native test builds
// only — the headless GPU harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "defringe/tests.rs"]
mod tests;
