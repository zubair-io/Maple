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
//! 2. **blur** (the box-blur primitive ×3): raw-core's `gaussian_blur_plane` is
//!    THREE successive box-blur passes at `r_box = (radius_px / 3).max(1)` (Wells
//!    1986 Gaussian approximation), so we chain three [`spatial::box_blur_encode`]
//!    calls — already bit-faithful to `box_blur_channel`'s shrinking window.
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
//! - box blur: in + out (+ an internal h-scratch) (≤ 3, via the primitive).
//! - USM scale: src + luma + luma_blur + sharpened (4).
//! - edge-mix: observed(src) + sharpened + luma + dst (4).
//!
//! Parity-gated DIRECTLY vs `raw_core::stages::sharpen::apply` `< 1e-4` — no CPU
//! oracle in this crate (the test drives the real raw-core stage via the dev-dep).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{alloc_plane, alloc_rgba, box_blur_encode, encode_simple};

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

/// Encode the full sharpen pipeline, reading `src` (RGBA) and writing `dst`
/// (RGBA). Mirrors `raw_core::stages::sharpen::apply` exactly. The caller handles
/// the `amount.abs() < 1e-3` identity short-circuit; this always runs the chain.
///
/// `radius_px` / `r_box` follow raw-core: `radius.clamp(0.5, 3.0).round() as
/// usize`, floored to 1, then the box radius is `(radius_px / 3).max(1)`.
#[allow(clippy::too_many_arguments)] // GPU encode plumbing: ctx/encoder/src/dst/dims/sliders.
fn encode_sharpen(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    dst: &wgpu::Buffer,
    width: u32,
    height: u32,
    amount: f32,
    radius: f32,
    detail: f32,
    masking: f32,
) {
    let count = width * height;

    // radius (PSF sigma) → integer box radius, mirroring raw-core's two clamps.
    let radius_px = (radius.clamp(0.5, 3.0).round() as i64).max(1) as usize;
    let r_box = (radius_px / 3).max(1) as u32;

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

    // 2. Blur the luma plane: raw-core's gaussian_blur_plane == 3 box passes at
    //    r_box. Ping-pong between `luma_blur` and a scratch so the final blurred
    //    plane lands in `luma_blur` (3 passes → odd count → ends in the buffer the
    //    first pass wrote, so seed accordingly).
    let luma_blur = alloc_plane(ctx, width, height, "sharpen-luma-blur");
    let blur_scratch = alloc_plane(ctx, width, height, "sharpen-blur-scratch");
    // pass 0: luma -> luma_blur ; pass 1: luma_blur -> scratch ; pass 2: scratch -> luma_blur
    box_blur_encode(ctx, encoder, &luma, &luma_blur, width, height, r_box);
    box_blur_encode(ctx, encoder, &luma_blur, &blur_scratch, width, height, r_box);
    box_blur_encode(ctx, encoder, &blur_scratch, &luma_blur, width, height, r_box);

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
/// * `radius` — PSF sigma in pixels (clamped 0.5..3.0).
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
            width,
            height,
            self.amount,
            self.radius,
            self.detail,
            self.masking,
        );
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / noise_reduction's tests.rs split). Native test builds
// only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "sharpen/tests.rs"]
mod tests;
