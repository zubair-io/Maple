//! Film grain stage — display-linear deterministic value noise (#1110,
//! tone/zoom design § 10.2), ported to the unified wgpu chain.
//!
//! Ports `raw_core::stages::grain::apply_windowed`: a luminance-modulated,
//! monochromatic, hash-noise grain injected POST-AgX (between [`crate::
//! agx::AgxPass`] and [`crate::display_encode::DisplayEncodePass`]).
//!
//! ## The determinism contract (the whole point)
//!
//! The integer PCG hash in `grain.wgsl` carries IDENTICAL constants to the
//! raw-core stage (seeds, multipliers, the [-1, 1] mapping) and the noise
//! evaluation mirrors the Rust float sequence line-for-line — u32
//! arithmetic wraps in WGSL by spec, matching Rust's `wrapping_*`. The
//! field is a pure function of the absolute pixel coordinate + params, so
//! same-resolution renders are parity-exact across CPU/Metal/WebGPU (the
//! gate in `grain/tests.rs` pins it). Cross-RESOLUTION parity is
//! deliberately statistical — see the raw-core stage docs.
//!
//! Three pieces (the per-stage template, mirroring vignette):
//! 1. [`apply_grain`] — the CPU oracle (line-for-line port, window-aware).
//! 2. [`GrainPass`] — the GPU-resident [`Pass`]; carries amount / size /
//!    roughness. Window-aware kernel; the live chain passes origin (0, 0)
//!    and full = dims.
//! 3. The headless parity test — GPU vs this oracle AND vs the real
//!    raw-core stage, < 1e-4 across param spreads.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// Slider inputs for the film grain stage.
#[derive(Clone, Copy, Debug, Default)]
pub struct GrainParams {
    pub amount: f32,
    pub size: f32,
    pub roughness: f32,
}

/// `repr(C)` params uniform shared by the WGSL kernel (`grain.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    k: f32,
    inv_pitch: f32,
    rho: f32,
    count: u32,
    buf_width: u32,
    origin_x: u32,
    origin_y: u32,
    _pad0: u32,
}

// ── Stage-local constants (verbatim from raw_core::stages::grain) ──────────
// Transcribed (raw-core is a dev-dep only); the parity test pins all of
// them to the real stage. The hash constants live in the WGSL kernel and
// in the local oracle below.
const GRAIN_SEED: u32 = 0x4D41_504C;
const GRAIN_SEED2: u32 = GRAIN_SEED ^ 0x9E37_79B9;
const GRAIN_K: f32 = 0.2;
const GRAIN_PITCH_MIN: f32 = 1.0;
const GRAIN_PITCH_MAX: f32 = 6.0;
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

#[inline]
fn pcg(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

#[inline]
fn lattice(ix: u32, iy: u32, seed: u32) -> f32 {
    let h = pcg(ix.wrapping_add(pcg(iy.wrapping_add(seed))));
    (h as f32) * (2.0 / 4_294_967_295.0) - 1.0
}

#[inline]
fn quintic(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn value_noise(u: f32, v: f32, seed: u32) -> f32 {
    let i = u.floor();
    let j = v.floor();
    let fu = u - i;
    let fv = v - j;
    let iu = i as u32;
    let jv = j as u32;
    let n00 = lattice(iu, jv, seed);
    let n10 = lattice(iu.wrapping_add(1), jv, seed);
    let n01 = lattice(iu, jv.wrapping_add(1), seed);
    let n11 = lattice(iu.wrapping_add(1), jv.wrapping_add(1), seed);
    let sx = quintic(fu);
    let sy = quintic(fv);
    let nx0 = n00 + (n10 - n00) * sx;
    let nx1 = n01 + (n11 - n01) * sx;
    nx0 + (nx1 - nx0) * sy
}

/// Hoist the per-render params exactly as `raw_core::stages::grain::
/// grain_params` does (same float sequence).
fn grain_params(amount: f32, size: f32, roughness: f32, long_edge: u32) -> (f32, f32, f32) {
    let pitch = (GRAIN_PITCH_MIN + (size / 100.0) * (GRAIN_PITCH_MAX - GRAIN_PITCH_MIN))
        * (long_edge as f32)
        / 2000.0;
    let k = GRAIN_K * amount / 100.0;
    let rho = roughness / 100.0;
    (k, 1.0 / pitch, rho)
}

/// Window-aware grain on an interleaved RGBA f32 buffer (alpha untouched).
/// This is the CPU oracle — a line-for-line port of
/// `raw_core::stages::grain::apply_windowed`. The whole-image
/// `|amount| < 1e-3` short-circuit is the caller's (the chain doesn't
/// enqueue the pass).
pub fn apply_grain(
    buf: &mut [f32],
    dims: (usize, usize),
    origin: (u32, u32),
    full: (u32, u32),
    params: &GrainParams,
) {
    let (width, height) = dims;
    debug_assert_eq!(buf.len(), width * height * 4);
    let long_edge = full.0.max(full.1);
    let (k, inv_pitch, rho) =
        grain_params(params.amount, params.size, params.roughness, long_edge);
    for (row_idx, row) in buf.chunks_exact_mut(width * 4).enumerate() {
        let py = origin.1 + row_idx as u32;
        for (col_idx, px_chunk) in row.chunks_exact_mut(4).enumerate() {
            let px = origin.0 + col_idx as u32;
            let u = px as f32 * inv_pitch;
            let v = py as f32 * inv_pitch;
            let n1 = value_noise(u, v, GRAIN_SEED);
            let n2 = value_noise(u * 2.0, v * 2.0, GRAIN_SEED2);
            let n = (n1 + rho * n2) / (1.0 + rho);
            let yd = (LUMA_REC2020[0] * px_chunk[0]
                + LUMA_REC2020[1] * px_chunk[1]
                + LUMA_REC2020[2] * px_chunk[2])
                .clamp(0.0, 1.0);
            let wl = (4.0 * yd * (1.0 - yd)).clamp(0.0, 1.0);
            let delta = k * wl * n;
            px_chunk[0] += delta;
            px_chunk[1] += delta;
            px_chunk[2] += delta;
        }
    }
}

/// A GPU-resident film-grain stage. Carries the slider values; the
/// window is fixed at origin (0, 0) / full = dims by `encode` (the live
/// chain renders whole frames — the kernel is window-aware for tiles).
pub struct GrainPass {
    pub params: GrainParams,
}

impl Pass for GrainPass {
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
        let (k, inv_pitch, rho) = grain_params(
            self.params.amount,
            self.params.size,
            self.params.roughness,
            width.max(height),
        );

        let params = Params {
            k,
            inv_pitch,
            rho,
            count: pixel_count,
            buf_width: width,
            origin_x: 0,
            origin_y: 0,
            _pad0: 0,
        };
        // Pooled per-pixel dispatch: params @0, src @1, dst @2 — 2 storage
        // buffers, well under the ≤4/stage budget.
        encode_simple(
            ctx,
            encoder,
            ctx.grain_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "grain",
        );
    }
}

// The parity tests live in a sibling file to keep this module under the
// 600-LOC budget. Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "grain/tests.rs"]
mod tests;
