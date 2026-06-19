//! Sharpen stage — the P3 wave-2 SPATIAL WGSL port (epic #925 / #991).
//!
//! Luminance-only unsharp-mask sharpening on scene-linear Rec.2020, mirroring
//! `raw_core::stages::sharpen::apply`. Like clarity it reads pixel NEIGHBOURHOODS
//! (the unsharp blur + the central-difference edge gradient), so it stays ONE
//! chain [`Pass`] and orchestrates its sub-passes over scratch planes via the
//! [`crate::spatial`] substrate. Unlike clarity's guided-filter DAG, sharpen is a
//! short linear chain: extract luma → blur it → per-pixel USM scale → edge-mix.
//!
//! ## The unsharp mask, in four sub-passes
//!
//! 1. **luma extract** (`sharpen_luma.wgsl`): RGBA → a luma plane (BT.2020).
//! 2. **blur** (the shared `gaussian_blur` WGSL entry from
//!    `capture_sharpening.wgsl`, H + V dispatches): raw-core's
//!    `gaussian_blur_plane_sigma` is a TRUE windowed/renormalized separable
//!    Gaussian at `sigma = radius.clamp(0.5, 3.0)`, clamp-to-edge borders. The
//!    taps are built CPU-side by the same bit-for-bit `gaussian_kernel_1d` port
//!    capture-sharpening uses and uploaded once per encode (#1083 — the previous
//!    3× box-blur cascade truncated every legal radius to the same 1-px box,
//!    making the Radius slider a no-op on BOTH the CPU and GPU paths).
//! 3. **USM scale** (`sharpen_usm.wgsl`): the per-pixel luma USM with the shadow
//!    guard + scale clamp, producing the "full-strength sharpened" RGBA
//!    (amount=100, masking=0). Luma-only: one scalar scales all three channels, so
//!    chroma ratios are preserved (the #439 no-fringing contract).
//! 4. **edge-mix** (`sharpen_mix.wgsl`): blend observed → sharpened by
//!    `mix = overall_mix * edge`, where `edge` gates flat vs edge regions when
//!    masking is on (a central-difference gradient on the ORIGINAL luma plane).
//!
//! ## Buffer budget (every kernel ≤ 4 storage)
//!
//! - luma extract: src + luma (2).
//! - gaussian blur: kernel + in + out (3).
//! - USM scale: src + luma + luma_blur + sharpened (4).
//! - edge-mix: observed(src) + sharpened + luma + dst (4).
//!
//! ## Live-pool note (zero-alloc invariant)
//!
//! The kernel taps live in a [`spatial::pool_data_storage`] buffer of FIXED
//! [`MAX_SHARPEN_KLEN`] capacity (the actual `klen` rides in the uniform), so a
//! radius drag rewrites the pooled buffer's contents every tick without ever
//! resizing it — the buffer object (and the bind group caching it) stays stable
//! within a chain signature, and the dispatch COUNT is radius-independent.
//!
//! Parity-gated DIRECTLY vs `raw_core::stages::sharpen::apply` `< 1e-4` — no CPU
//! oracle in this crate (the test drives the real raw-core stage via the dev-dep).

use crate::capture_sharpening::{gaussian_kernel_1d, GaussParams};
use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{alloc_plane, alloc_rgba, encode_simple, pool_data_storage};

/// Fixed tap-capacity of the pooled sharpen kernel buffer: the longest kernel
/// the clamped sigma range can demand. `sigma <= 3.0` → `half = ceil(3σ) <= 9`
/// → `klen = 2*half + 1 <= 19`. Allocating at the ceiling keeps the pooled
/// buffer's size constant across radius edits (see the live-pool note above).
const MAX_SHARPEN_KLEN: usize = 19;

/// `repr(C)` uniform for `sharpen_luma.wgsl` / `sharpen_usm.wgsl`: pixel count.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// `repr(C)` uniform for `sharpen_mix.wgsl`: dims + the slider-derived (and
/// CPU-clamped, exactly as raw-core) mix scalars. 32 bytes (multiple of 16).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MixParams {
    width: u32,
    height: u32,
    overall_mix: f32,
    detail_atten: f32,
    masking_threshold: f32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

#[derive(Clone, Copy)]
pub struct SharpenSettings {
    pub width: u32,
    pub height: u32,
    pub amount: f32,
    pub radius: f32,
    pub detail: f32,
    pub masking: f32,
}

/// Encode the full sharpen pipeline, reading `src` (RGBA) and writing `dst`
/// (RGBA). Mirrors `raw_core::stages::sharpen::apply` exactly. The caller handles
/// the `amount.abs() < 1e-3` identity short-circuit; this always runs the chain.
///
/// `sigma` follows raw-core: `radius.clamp(0.5, 3.0)`, kept FLOAT — the taps
/// come from the same `gaussian_kernel_1d` raw-core convolves with (#1083).
fn encode_sharpen(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    settings: SharpenSettings,
) {
    let SharpenSettings {
        width,
        height,
        amount,
        radius,
        detail,
        masking,
    } = settings;
    let count = width * height;

    // radius (PSF sigma) → the true-Gaussian taps, mirroring raw-core's clamp.
    let sigma = radius.clamp(0.5, 3.0);
    let taps = gaussian_kernel_1d(sigma);
    debug_assert!(
        taps.len() <= MAX_SHARPEN_KLEN,
        "sharpen kernel ({} taps) exceeds the pooled buffer capacity ({MAX_SHARPEN_KLEN})",
        taps.len()
    );
    let klen = taps.len().min(MAX_SHARPEN_KLEN) as u32;
    // Fixed-capacity upload (zero-padded tail) so the pooled buffer never
    // resizes across radius edits — see the live-pool note in the module docs.
    let mut padded = [0.0f32; MAX_SHARPEN_KLEN];
    padded[..klen as usize].copy_from_slice(&taps[..klen as usize]);
    let kernel = pool_data_storage(ctx, bytemuck::cast_slice(&padded), "sharpen-gauss-kernel");

    // 1. Extract the luma plane (BT.2020).
    let luma = alloc_plane(ctx, width, height, "sharpen-luma");
    let cnt = CountParams {
        count,
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.sharpen_luma_pipeline(),
        bytemuck::bytes_of(&cnt),
        &[src, &luma],
        count,
        "sharpen-luma",
    );

    // 2. Blur the luma plane: raw-core's `gaussian_blur_plane_sigma` == one
    //    H sweep then one V sweep of the true windowed Gaussian, clamp-to-edge.
    //    Same `gaussian_blur` WGSL entry capture-sharpening uses; the V dispatch
    //    sees the H output via wgpu's implicit inter-pass barrier.
    let luma_blur = alloc_plane(ctx, width, height, "sharpen-luma-blur");
    let blur_scratch = alloc_plane(ctx, width, height, "sharpen-blur-scratch");
    let h_params = GaussParams {
        width,
        height,
        klen,
        axis: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.cs_gaussian_pipeline(),
        bytemuck::bytes_of(&h_params),
        &[kernel.as_ref(), &luma, &blur_scratch],
        count,
        "sharpen-gauss-h",
    );
    let v_params = GaussParams {
        width,
        height,
        klen,
        axis: 1,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.cs_gaussian_pipeline(),
        bytemuck::bytes_of(&v_params),
        &[kernel.as_ref(), &blur_scratch, &luma_blur],
        count,
        "sharpen-gauss-v",
    );

    // 3. Per-pixel USM scale → the full-strength sharpened RGBA.
    let sharpened = alloc_rgba(ctx, width, height, "sharpen-sharpened");
    encode_simple(
        ctx,
        encoder,
        ctx.sharpen_usm_pipeline(),
        bytemuck::bytes_of(&cnt),
        &[src, &luma, &luma_blur, &sharpened],
        count,
        "sharpen-usm",
    );

    // 4. Edge-aware amount/masking blend → dst. Slider scalars clamped CPU-side
    //    exactly as raw-core (overall_mix to [0,1.5], the others to [0,1]).
    let mix_params = MixParams {
        width,
        height,
        overall_mix: (amount / 100.0).clamp(0.0, 1.5),
        detail_atten: (detail / 100.0).clamp(0.0, 1.0),
        masking_threshold: (masking / 100.0).clamp(0.0, 1.0),
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
    };
    encode_simple(
        ctx,
        encoder,
        ctx.sharpen_mix_pipeline(),
        bytemuck::bytes_of(&mix_params),
        &[src, &sharpened, &luma, dst],
        count,
        "sharpen-mix",
    );
}

/// A GPU-resident sharpen stage. Carries the four sliders that drive
/// `raw_core::stages::sharpen::apply`; device, pipelines, and scratch planes come
/// from the [`GpuContext`] / spatial substrate at encode time.
///
/// * `amount` — 0..150 (>100 boosts the mix beyond unity, up to 1.5).
/// * `radius` — PSF sigma in pixels (clamped 0.5..3.0), driving the true
///   separable Gaussian unsharp blur — kept float end-to-end (#1083).
/// * `detail` — 0..100 (how much sharpening leaks into flat regions when masking
///   is non-zero).
/// * `masking` — 0..100 (gradient threshold for the edge-only mix).
pub struct SharpenPass {
    pub amount: f32,
    pub radius: f32,
    pub detail: f32,
    pub masking: f32,
}

impl Pass for SharpenPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        // amount == 0 short-circuits the whole stage in raw-core — copy src → dst
        // and bail so the chain's ping-pong threads the unchanged image through.
        if self.amount.abs() < 1e-3 {
            let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        encode_sharpen(
            ctx,
            encoder,
            src,
            dst,
            SharpenSettings {
                width,
                height,
                amount: self.amount,
                radius: self.radius,
                detail: self.detail,
                masking: self.masking,
            },
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / noise_reduction's tests.rs split). Native test builds
// only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "sharpen/tests.rs"]
mod tests;
