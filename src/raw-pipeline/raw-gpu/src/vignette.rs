//! Vignette stage — the scene-linear radial EV gain (#1109, tone/zoom
//! design § 10.1), ported to the unified wgpu chain.
//!
//! Ports `raw_core::stages::vignette::apply_windowed`: an elliptical,
//! smoothstep-feathered exp2 gain anchored to the full render rect.
//! Sits between dehaze and sharpen in the chain (develop's 12c position,
//! after `local_adjustments` — which is not GPU-ported and defaults to a
//! no-op).
//!
//! Three pieces (the per-stage template, mirroring saturation):
//! 1. [`apply_vignette`] — the CPU oracle: a line-for-line port of the
//!    raw-core stage over a flat RGBA f32 buffer (alpha untouched),
//!    window-aware like the kernel.
//! 2. [`VignettePass`] — the GPU-resident [`Pass`]; carries `amount` and
//!    `feather`. The kernel is window-aware (tile origin + full dims ride
//!    the params uniform — tile-safe by construction); the live chain
//!    renders the whole frame, so `encode` passes origin (0, 0) and
//!    full = dims.
//! 3. The headless parity test (`vignette/tests.rs`) — GPU vs this oracle
//!    AND vs the real `raw_core::stages::vignette::apply` (dev-dep),
//!    < 1e-4 across amount/feather spreads.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel (`vignette.wgsl`).
/// Hoisted mask params + the window; 48 bytes (12 × 4, 16-aligned).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    e0: f32,
    e1: f32,
    ev: f32,
    inv_half_w: f32,
    inv_half_h: f32,
    count: u32,
    buf_width: u32,
    origin_x: u32,
    origin_y: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

// ── Stage-local constants (verbatim from raw_core::stages::vignette) ───────
// Transcribed (raw-core is a dev-dep only); the parity test pins every one
// of them to the real stage. Same precedent as scene_tone's #1103 block.
const VIGNETTE_M0: f32 = 0.7;
const VIGNETTE_K_EV: f32 = 1.5;
const VIGNETTE_W_MIN: f32 = 0.05;
const VIGNETTE_W_MAX: f32 = 0.9;

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Hoist the mask params exactly as `raw_core::stages::vignette::
/// vignette_mask_params` does — same float sequence, so the kernel's
/// uniform carries the same values the CPU stage derives.
fn mask_params(amount: f32, feather: f32) -> (f32, f32, f32) {
    let width = VIGNETTE_W_MIN + (feather / 100.0) * (VIGNETTE_W_MAX - VIGNETTE_W_MIN);
    let e0 = VIGNETTE_M0 - width * 0.5;
    let e1 = VIGNETTE_M0 + width * 0.5;
    let ev = VIGNETTE_K_EV * amount / 100.0;
    (e0, e1, ev)
}

#[derive(Clone, Copy)]
pub struct VignetteOptions {
    pub origin: (u32, u32),
    pub full: (u32, u32),
    pub amount: f32,
    pub feather: f32,
}

/// Window-aware vignette on an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a line-for-line port of
/// `raw_core::stages::vignette::apply_windowed`. `origin` is the buffer's
/// top-left in full-image pixels; `full` the full image dims. The
/// whole-image `|amount| < 1e-3` short-circuit is the caller's (the chain
/// doesn't enqueue the pass), mirroring raw-core's `apply` early-return;
/// this oracle applies unconditionally so partial-engagement tests stay
/// honest.
pub fn apply_vignette(buf: &mut [f32], width: usize, height: usize, options: VignetteOptions) {
    let VignetteOptions {
        origin,
        full,
        amount,
        feather,
    } = options;
    debug_assert_eq!(buf.len(), width * height * 4);
    let (e0, e1, ev) = mask_params(amount, feather);
    let inv_half_w = 2.0 / full.0 as f32;
    let inv_half_h = 2.0 / full.1 as f32;
    for (row_idx, row) in buf.chunks_exact_mut(width * 4).enumerate() {
        let py = origin.1 + row_idx as u32;
        let ny = (py as f32 + 0.5) * inv_half_h - 1.0;
        let ny2 = ny * ny;
        for (col_idx, px_chunk) in row.chunks_exact_mut(4).enumerate() {
            let px = origin.0 + col_idx as u32;
            let nx = (px as f32 + 0.5) * inv_half_w - 1.0;
            let r = (nx * nx + ny2).sqrt();
            let m = smoothstep(e0, e1, r);
            let gain = (ev * m).exp2();
            px_chunk[0] *= gain;
            px_chunk[1] *= gain;
            px_chunk[2] *= gain;
            // px_chunk[3] (alpha) untouched
        }
    }
}

/// A GPU-resident vignette stage. Carries the two slider values; the
/// window is fixed at origin (0, 0) / full = dims by `encode` (the live
/// chain renders whole frames — the kernel itself is window-aware for the
/// tile path, #11).
pub struct VignettePass {
    pub amount: f32,
    pub feather: f32,
}

impl Pass for VignettePass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let pixel_count = width * height;
        let (e0, e1, ev) = mask_params(self.amount, self.feather);

        let params = Params {
            e0,
            e1,
            ev,
            inv_half_w: 2.0 / width as f32,
            inv_half_h: 2.0 / height as f32,
            count: pixel_count,
            buf_width: width,
            origin_x: 0,
            origin_y: 0,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        // Pooled per-pixel dispatch: params @0, src @1, dst @2 — 2 storage
        // buffers, well under the ≤4/stage budget.
        encode_simple(
            ctx,
            encoder,
            ctx.vignette_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "vignette",
        );
    }
}

// The parity tests live in a sibling file to keep this module under the
// 600-LOC budget. Compiled only for native test builds — the headless GPU
// harness has no wasm path.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "vignette/tests.rs"]
mod tests;
