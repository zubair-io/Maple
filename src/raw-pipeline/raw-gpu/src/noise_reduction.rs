//! Noise-reduction stage — the P3 wave-1 SPATIAL WGSL port (epic #925 / #991).
//!
//! Fast non-local-means denoising in Oklab space. The first P3 spatial filter:
//! like clarity/dehaze it reads pixel NEIGHBOURHOODS, so it stays ONE chain
//! [`Pass`] and orchestrates its own sub-passes over scratch planes. NLM's outer
//! loop is over SHIFTS (offsets in a search window), each contributing a
//! patch-similarity-weighted sample to a running accumulator — so the orchestration
//! is a per-shift dispatch loop, distinct from clarity's box-blur DAG and dehaze's
//! linear chain.
//!
//! Two stages, mirroring `raw_core::stages::noise_reduction`:
//! 1. [`NlmLumaPass`] / [`NlmColorPass`] — the GPU-resident stages. Each carries
//!    only its slider amount; drives the shift loop inside `encode`.
//! 2. The headless parity tests (`noise_reduction/tests.rs`) — gated DIRECTLY vs
//!    the real `raw_core::stages::noise_reduction::{apply_luminance,apply_color}`
//!    `< 1e-4`, PLUS a plane-level gate vs `raw_core::stages::nlm::denoise_plane`
//!    (which isolates the NLM math from the Oklab round-trip).
//!
//! Unlike clarity (which ships a small local CPU oracle), NLM has NO non-test CPU
//! oracle: porting `denoise_plane` + the full Oklab round-trip into this crate
//! would duplicate hundreds of lines for no runtime caller. The parity gate runs
//! GPU-vs-the-real-raw-core directly via the test-only `raw-core` dev-dep.
//!
//! ## NLM = non-local means (Buades/Coll/Morel 2005; Darbon 2008 fast variant)
//!
//! `out(p) = (1/Z) · Σ_{q ∈ search}  w(p,q) · I(q)`, where
//! `w(p,q) = exp(-‖patch(p) - patch(q)‖² / (h²·patch_area))` and the centre pixel
//! `q = p` is added at the end with weight = running max weight (self-similarity
//! correction). raw-core computes the patch-SSD with a per-shift separable
//! sliding box-sum (#1195; it previously used a per-shift integral image);
//! either way the patch SSD is a sum of `(I(q) - I(q+d))²` over the (2P+1)²
//! patch. We recompute that sum DIRECTLY in registers (see
//! `noise_reduction.wgsl`) — a materialised-intermediate accumulate would need
//! a 5th storage buffer, over the `downlevel_defaults()` 4-storage cap. The
//! direct register sum matches raw-core's local box-sum to the f32 floor
//! (plane-parity max abs diff ~5e-8). Correctness-only; perf is P4.
//!
//! ## Buffer budget (every kernel ≤ 4 storage)
//!
//! - extract: RGBA-src + plane-out (2).
//! - accumulate (per shift): plane + acc + wsum + max_w (4).
//! - finalize: plane + acc(rw, becomes the denoised plane) + wsum + max_w (4).
//! - writeback luma: src + denoised-L + dst (3); color: src + a + b + dst (4).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{alloc_plane, encode_simple};

// ── Parameters at amount = 100, mirroring raw_core::stages::noise_reduction ────
//
// These MUST match raw-core's constants exactly — the slider→params map is the
// parity contract for the strength `h`, the patch radius, and the search radius.
// (raw-core: `LUMA_PATCH_RADIUS` … `CHROMA_H_MAX` in `stages::noise_reduction`.)
const LUMA_PATCH_RADIUS: usize = 2;
const LUMA_SEARCH_RADIUS: usize = 2;
const LUMA_H_MAX: f32 = 0.04;
const CHROMA_PATCH_RADIUS: usize = 2;
const CHROMA_SEARCH_RADIUS: usize = 3;
const CHROMA_H_MAX: f32 = 0.05;

/// NLM parameters for one plane — the raw-gpu mirror of
/// `raw_core::stages::nlm::NlmParams` (kept local so the non-test module carries
/// no `raw-core` dependency; the test gates against the real raw-core type).
/// `pub(crate)` so the parity test can drive [`encode_nlm_on_plane`] directly.
#[derive(Clone, Copy)]
pub(crate) struct NlmParams {
    patch_radius: usize,
    search_radius: usize,
    h: f32,
}

/// Luma NLM params for a slider `amount` — line-faithful to
/// `raw_core::stages::noise_reduction::luma_params` (private there).
fn luma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: LUMA_PATCH_RADIUS,
        search_radius: LUMA_SEARCH_RADIUS,
        h: t * LUMA_H_MAX,
    }
}

/// Chroma NLM params for a slider `amount` — line-faithful to
/// `raw_core::stages::noise_reduction::chroma_params` (private there).
fn chroma_params(amount: f32) -> NlmParams {
    let t = (amount / 100.0).clamp(0.0, 1.0);
    NlmParams {
        patch_radius: CHROMA_PATCH_RADIUS,
        search_radius: CHROMA_SEARCH_RADIUS,
        h: t * CHROMA_H_MAX,
    }
}

// ── `repr(C)` uniforms for the WGSL kernels ───────────────────────────────────

/// `extract_channel` uniform: pixel count + the Oklab channel (0=L, 1=a, 2=b).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ExtractParams {
    count: u32,
    channel: u32,
    _pad0: u32,
    _pad1: u32,
}

/// `accumulate_shift` uniform: dims, patch radius, the exp normaliser, the shift,
/// and the CPU-computed valid pixel range. 48 bytes (multiple of 16).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AccumParams {
    width: u32,
    height: u32,
    p: i32,
    inv_norm: f32,
    dx: i32,
    dy: i32,
    x_lo: i32,
    x_hi: i32,
    y_lo: i32,
    y_hi: i32,
    _pad0: u32,
    _pad1: u32,
}

/// `finalize` / `writeback_*` uniform: just the pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

// ── The shared shift-loop encoder (denoise ONE plane on the GPU) ───────────────

/// Channel selector for [`encode_denoise_plane`] — which Oklab channel the
/// extract kernel pulls and the writeback kernel later restores.
#[derive(Clone, Copy)]
enum Channel {
    L = 0,
    A = 1,
    B = 2,
}

/// Extract one Oklab channel from `src`, run the full NLM shift loop, and leave
/// the denoised plane in the returned buffer. Mirrors
/// `raw_core::stages::nlm::denoise_plane` wrapped by the Oklab adapter's
/// per-channel extract. The `params.h <= 0 || search_radius == 0` identity case
/// is handled by the caller (the Pass copies src→dst); this always runs the loop.
///
/// Buffers: allocates plane / acc / wsum / max_w scratch planes; zeroes the three
/// accumulators (raw-core starts them at 0.0). Returns the buffer holding the
/// denoised plane (the `acc` plane, written in place by `finalize`).
fn encode_denoise_plane(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    width: u32,
    height: u32,
    channel: Channel,
    params: NlmParams,
) -> crate::spatial::Plane {
    let count = width * height;

    // Extract the channel plane from the RGBA source, then run the NLM core.
    let plane = alloc_plane(ctx, width, height, "nr-plane");
    let ex_params = ExtractParams {
        count,
        channel: channel as u32,
        _pad0: 0,
        _pad1: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.nr_extract_pipeline(),
        bytemuck::bytes_of(&ex_params),
        &[src, &plane],
        count,
        "nr-extract",
    );

    encode_nlm_on_plane(ctx, encoder, plane.as_ref(), width, height, params)
}

/// The NLM core on an ALREADY-EXTRACTED scalar plane (mirrors
/// `raw_core::stages::nlm::denoise_plane`): zero the accumulators, run the shift
/// loop, finalize. Returns the buffer holding the denoised plane (the `acc`
/// plane, written in place by `finalize`). `pub(crate)` so the parity test can
/// gate this in ISOLATION against `denoise_plane` — no Oklab round-trip — which
/// separates the two independent error sources (NLM math vs the color transform).
pub(crate) fn encode_nlm_on_plane(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    plane: &wgpu::Buffer,
    width: u32,
    height: u32,
    params: NlmParams,
) -> crate::spatial::Plane {
    let count = width * height;

    // Accumulators, zeroed (raw-core's `vec![0.0; n]`).
    let acc = alloc_plane(ctx, width, height, "nr-acc");
    let wsum = alloc_plane(ctx, width, height, "nr-wsum");
    let max_w = alloc_plane(ctx, width, height, "nr-max-w");
    encoder.clear_buffer(&acc, 0, None);
    encoder.clear_buffer(&wsum, 0, None);
    encoder.clear_buffer(&max_w, 0, None);

    // Shift loop. dx, dy ∈ [-s, s]², skipping (0, 0) and any shift whose valid
    // pixel range is empty — both mirror raw-core's `process_shift` (the centre
    // is added in `finalize`, empty ranges early-return there).
    let p = params.patch_radius as i32;
    let s = params.search_radius as i32;
    let patch_area = ((2 * params.patch_radius + 1) * (2 * params.patch_radius + 1)) as f32;
    let inv_norm = 1.0 / (params.h * params.h * patch_area);
    let wi = width as i32;
    let hi = height as i32;

    for dy in -s..=s {
        for dx in -s..=s {
            if dx == 0 && dy == 0 {
                continue;
            }
            // Valid range: patch at p AND patch at p+d must fit (raw-core's isize
            // max/min). Empty range → skip the dispatch (raw-core early-returns).
            let x_lo = p.max(p - dx);
            let x_hi = (wi - 1 - p).min(wi - 1 - dx - p);
            let y_lo = p.max(p - dy);
            let y_hi = (hi - 1 - p).min(hi - 1 - dy - p);
            if x_lo > x_hi || y_lo > y_hi {
                continue;
            }
            let ac_params = AccumParams {
                width,
                height,
                p,
                inv_norm,
                dx,
                dy,
                x_lo,
                x_hi,
                y_lo,
                y_hi,
                _pad0: 0,
                _pad1: 0,
            };
            encode_simple(
                ctx,
                encoder,
                ctx.nr_accumulate_pipeline(),
                bytemuck::bytes_of(&ac_params),
                &[plane, &acc, &wsum, &max_w],
                count,
                "nr-accumulate-shift",
            );
        }
    }

    // Finalize: out = (acc + mw·plane) / (wsum + mw), written in place to acc.
    let fin_params = CountParams {
        count,
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.nr_finalize_pipeline(),
        bytemuck::bytes_of(&fin_params),
        &[plane, &acc, &wsum, &max_w],
        count,
        "nr-finalize",
    );

    acc
}

/// A GPU-resident luminance-NR stage. Carries only its `nr_luminance` slider
/// value ([0, 100]); device, pipelines, and scratch planes come from the
/// [`GpuContext`] / spatial substrate at encode time. NLM-denoises the Oklab L
/// channel, leaves a/b untouched. Mirrors
/// `raw_core::stages::noise_reduction::apply_luminance`.
pub struct NlmLumaPass {
    pub nr_luminance: f32,
}

impl Pass for NlmLumaPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let params = luma_params(self.nr_luminance);
        // |amount| < 1e-3 (or h <= 0 / search_radius == 0) is identity in
        // raw-core — copy src → dst and bail so the ping-pong threads it through.
        if self.nr_luminance.abs() < 1e-3 || params.h <= 0.0 || params.search_radius == 0 {
            copy_through(encoder, src, dst, width, height);
            return;
        }
        let denoised_l = encode_denoise_plane(ctx, encoder, src, width, height, Channel::L, params);
        let count = width * height;
        let wb_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.nr_writeback_luma_pipeline(),
            bytemuck::bytes_of(&wb_params),
            &[src, &denoised_l, dst],
            count,
            "nr-writeback-luma",
        );
    }
}

/// A GPU-resident color-NR stage. Carries only its `nr_color` slider value
/// ([0, 100]). NLM-denoises the Oklab a and b channels with a wider search window
/// than luma, leaves L untouched. Mirrors
/// `raw_core::stages::noise_reduction::apply_color`.
pub struct NlmColorPass {
    pub nr_color: f32,
}

impl Pass for NlmColorPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let params = chroma_params(self.nr_color);
        if self.nr_color.abs() < 1e-3 || params.h <= 0.0 || params.search_radius == 0 {
            copy_through(encoder, src, dst, width, height);
            return;
        }
        // Denoise a and b independently (raw-core runs them as two
        // `denoise_plane` calls); then a single writeback restores both.
        let denoised_a = encode_denoise_plane(ctx, encoder, src, width, height, Channel::A, params);
        let denoised_b = encode_denoise_plane(ctx, encoder, src, width, height, Channel::B, params);
        let count = width * height;
        let wb_params = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.nr_writeback_color_pipeline(),
            bytemuck::bytes_of(&wb_params),
            &[src, &denoised_a, &denoised_b, dst],
            count,
            "nr-writeback-color",
        );
    }
}

/// Copy `src` → `dst` (the identity short-circuit shared by both passes, so the
/// chain's ping-pong still threads the unchanged image through).
fn copy_through(
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    width: u32,
    height: u32,
) {
    let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
    encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / dehaze's tests.rs split). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "noise_reduction/tests.rs"]
mod tests;
