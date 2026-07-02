//! Capture-sharpening stage — the P3 wave-2 ITERATIVE WGSL port (epic #925 /
//! #991). Richardson–Lucy deconvolution against a true Gaussian PSF, on a
//! luminance plane so chroma noise isn't amplified. Mirrors
//! `raw_core::stages::capture_sharpening::apply_capture_sharpening`.
//!
//! Like clarity / sharpen it reads pixel NEIGHBOURHOODS (the Gaussian blur), so it
//! stays ONE chain [`Pass`]. But unlike the linear sub-pass chains, its core is an
//! ITERATIVE fixed-point: N Richardson–Lucy iterations, each
//! `estimate *= blur(original / blur(estimate))`. We encode the iteration loop as
//! a per-iteration DISPATCH loop over scratch planes (the NLM shift-loop
//! precedent) — all in one command encoder, so each dispatch sees the prior one's
//! writes via wgpu's implicit inter-pass barrier.
//!
//! ## The Richardson–Lucy loop, in dispatches
//!
//! 1. **extract** (`extract_luma`): RGBA → a Rec.709 luma plane = `original`.
//!    (Rec.709, NOT Rec.2020 — raw-core's deliberate approximation for this stage.)
//! 2. `estimate = original` (a buffer copy — raw-core's `estimate = original.clone()`).
//! 3. **N iterations**, each:
//!    a. `blur_est = blur(estimate)`           (true-Gaussian, clamp-to-edge ×2 axes)
//!    b. `ratio    = clamp(original / max(blur_est, 1e-6), 0, 100)`  (`ratio_step`)
//!    c. `blur_ratio = blur(ratio)`
//!    d. `estimate *= blur_ratio`              (`multiply_step`, in place)
//! 4. **apply** (`apply_scale`): the highlight-faded per-channel scale → dst.
//!
//! ## True Gaussian PSF (distinct from the box blur)
//!
//! The blur is a windowed/renormalized Gaussian — `half = ceil(3σ).max(1)`,
//! weights `exp(-x²/2σ²)` divided by their sum — with CLAMP-TO-EDGE borders. The
//! kernel is built CPU-side ([`gaussian_kernel_1d`], a bit-for-bit port of
//! raw-core's private fn) and uploaded once to a storage buffer; both H and V
//! sweeps read it. This is NOT the box-blur primitive (shrinking partial average).
//!
//! ## Buffer budget (every kernel ≤ 4 storage)
//!
//! - extract: src + luma (2).
//! - gaussian: kernel + in + out (3).
//! - ratio: original + blur_est + ratio (3).
//! - multiply: estimate + blur_ratio (2).
//! - apply: original + estimate + src + dst (4).
//!
//! Parity-gated DIRECTLY vs `apply_capture_sharpening` `< 1e-4` — no CPU oracle in
//! this crate (the test drives the real raw-core stage via the dev-dep).

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{alloc_plane, plane_byte_len};
use wgpu::util::DeviceExt;

/// Hard ceiling on the Gaussian sigma, in pixels — mirrors
/// `raw_core::stages::capture_sharpening::MAX_SIGMA_PX_STAGE`. Above this the
/// stage is a no-op (defense-in-depth against an unbounded kernel allocation).
const MAX_SIGMA_PX_STAGE: f32 = 50.0;

/// The capture-sharpening parameters — the raw-gpu mirror of
/// `raw_core::stages::capture_sharpening::CaptureSharpeningParams` (kept local so
/// the non-test module carries no `raw-core` dependency; the test gates against
/// the real raw-core stage). Field semantics + defaults match raw-core exactly.
#[derive(Clone, Copy, Debug)]
pub struct CaptureSharpeningParams {
    /// Gaussian PSF sigma in pixels. Windowed to `±ceil(3·sigma)` taps and
    /// renormalized; `sigma <= 0`, non-finite, or `> MAX_SIGMA_PX_STAGE` is a no-op.
    pub sigma: f32,
    /// Number of Richardson–Lucy iterations. Reference default: 2.
    pub iterations: u32,
    /// Above this luminance, fade sharpening to avoid amplifying near-clipped
    /// highlights into ringing.
    pub highlight_threshold: f32,
    /// Strength multiplier. 1.0 = full effect; 0.0 = off (bit-identical no-op).
    pub strength: f32,
    /// Noise floor for dampened Richardson–Lucy. The RL update ratio is suppressed
    /// when the blurred estimate falls below this value, preventing noise
    /// amplification in dark regions. Setting to 0.0 disables dampening (classic RL).
    /// Default: 3e-4 (tuned for 14-bit linear scene data). Mirrors raw-core's field.
    pub noise_floor: f32,
}

impl Default for CaptureSharpeningParams {
    fn default() -> Self {
        // Matches `raw_core::stages::capture_sharpening::CaptureSharpeningParams::default`.
        Self {
            sigma: 0.68,
            iterations: 2,
            highlight_threshold: 0.99,
            strength: 1.0,
            noise_floor: 3e-4,
        }
    }
}

/// Build a windowed, renormalized 1D Gaussian kernel — a bit-for-bit port of
/// `raw_core::stages::blur::gaussian_kernel_1d` (moved there from
/// capture_sharpening in #1083; the math is unchanged). `half =
/// ceil(3·sigma).max(1)`; weights `exp(-(k²)/(2σ²))` for `k ∈ [-half, half]`,
/// divided by their sum. Both sides are Rust f32, so the uploaded kernel is
/// IDENTICAL to the one raw-core convolves with — the GPU's only delta is float
/// summation order in the conv itself (~1e-6).
///
/// `sigma` is clamped to `(0, MAX_SIGMA_PX_STAGE]` and non-finite rounds up to a
/// tiny lower bound, matching raw-core's same-named fn (the stage-level
/// guard rejects bogus sigma upstream, so this clamp is only the last safeguard).
///
/// `pub(crate)`: the sharpen stage shares this builder (and the `gaussian_blur`
/// WGSL entry point) for its sigma-faithful unsharp blur — see #1083.
pub(crate) fn gaussian_kernel_1d(sigma: f32) -> Vec<f32> {
    let sigma = if sigma.is_finite() && sigma > 0.0 {
        sigma.min(MAX_SIGMA_PX_STAGE)
    } else {
        1e-3
    };
    let half = (3.0 * sigma).ceil().max(1.0) as usize;
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut k: Vec<f32> = (0..=2 * half)
        .map(|i| {
            let x = i as f32 - half as f32;
            (-(x * x) / two_sigma_sq).exp()
        })
        .collect();
    let sum: f32 = k.iter().sum();
    let inv = 1.0 / sum;
    for v in &mut k {
        *v *= inv;
    }
    k
}

/// `repr(C)` uniform shared by the count-only kernels (extract / ratio / multiply).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CountParams {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// `repr(C)` uniform for `gaussian_blur`: dims, kernel length, swept axis.
/// `pub(crate)`: the sharpen stage drives the same WGSL entry point (#1083).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct GaussParams {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) klen: u32,
    pub(crate) axis: u32,
}

/// `repr(C)` uniform for `ratio_step`: count + noise_floor for dampened RL.
/// Mirrors raw-core's dampening: when `noise_floor > 0`, the update ratio is
/// suppressed in low-signal regions via `1 + (ratio-1) * b²/(b² + noise²)`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct RatioParams {
    count: u32,
    noise_floor: f32,
    _pad0: u32,
    _pad1: u32,
}

/// `repr(C)` uniform for `apply_scale`: count + strength + the clamped highlight
/// threshold (`highlight_threshold.min(0.999)`, computed CPU-side).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ApplyParams {
    count: u32,
    strength: f32,
    hi_thresh: f32,
    _pad0: u32,
}

pub(crate) struct DispatchArgs<'a> {
    pub ctx: &'a GpuContext,
    pub encoder: &'a mut wgpu::CommandEncoder,
    pub pipeline: &'a wgpu::ComputePipeline,
    pub params_bytes: &'a [u8],
    pub buffers: &'a [&'a wgpu::Buffer],
    pub count: u32,
    pub label: &'a str,
}

/// One compute dispatch over `[params, buffers...]` (params at binding 0). A local
/// copy of the spatial substrate's `encode_simple` shape; capture-sharpening keeps
/// its own so the kernel labels read in-stage.
fn dispatch(args: DispatchArgs) {
    let DispatchArgs {
        ctx,
        encoder,
        pipeline,
        params_bytes,
        buffers,
        count,
        label,
    } = args;
    let params_buf = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: params_bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let mut entries = Vec::with_capacity(buffers.len() + 1);
    entries.push(wgpu::BindGroupEntry {
        binding: 0,
        resource: params_buf.as_entire_binding(),
    });
    for (k, buf) in buffers.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: (k + 1) as u32,
            resource: buf.as_entire_binding(),
        });
    }
    let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &entries,
    });
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some(label),
        timestamp_writes: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    let groups = count.div_ceil(64);
    let gx = groups.min(65535);
    // Guard the empty dispatch: count==0 -> gx==0, and div_ceil(0) panics.
    // (0,0,1) is a safe no-op (the original 1-D (0,1,1) was likewise). #1623
    let gy = if gx == 0 { 0 } else { groups.div_ceil(gx) };
    pass.dispatch_workgroups(gx, gy, 1);
}

pub(crate) struct GaussArgs<'a> {
    pub ctx: &'a GpuContext,
    pub encoder: &'a mut wgpu::CommandEncoder,
    pub kernel: &'a wgpu::Buffer,
    pub klen: u32,
    pub input: &'a wgpu::Buffer,
    pub output: &'a wgpu::Buffer,
    pub scratch: &'a wgpu::Buffer,
    pub width: u32,
    pub height: u32,
}

/// Encode a separable true-Gaussian blur of a scalar plane: H sweep
/// (`input` → scratch) then V sweep (scratch → `output`), reading the uploaded
/// `kernel` both times. Clamp-to-edge borders (the kernel selects this via the
/// shader). Each sweep is its own dispatch so the V sweep sees the H output.
fn cs_gaussian_encode(args: GaussArgs) {
    let GaussArgs {
        ctx,
        encoder,
        kernel,
        klen,
        input,
        output,
        scratch,
        width,
        height,
    } = args;
    let count = width * height;
    let pipeline = ctx.cs_gaussian_pipeline();

    let h_params = GaussParams {
        width,
        height,
        klen,
        axis: 0,
    };
    dispatch(DispatchArgs {
        ctx,
        encoder,
        pipeline,
        params_bytes: bytemuck::bytes_of(&h_params),
        buffers: &[kernel, input, scratch],
        count,
        label: "cs-gaussian-h",
    });

    let v_params = GaussParams {
        width,
        height,
        klen,
        axis: 1,
    };
    dispatch(DispatchArgs {
        ctx,
        encoder,
        pipeline,
        params_bytes: bytemuck::bytes_of(&v_params),
        buffers: &[kernel, scratch, output],
        count,
        label: "cs-gaussian-v",
    });
}

/// Whether `params` is a no-op under raw-core's guard set — if so the stage copies
/// src → dst unchanged. Mirrors `apply_capture_sharpening`'s leading `if`.
fn is_noop(params: &CaptureSharpeningParams) -> bool {
    !params.sigma.is_finite()
        || params.sigma <= 0.0
        || params.sigma > MAX_SIGMA_PX_STAGE
        || params.iterations == 0
        || !params.strength.is_finite()
        || params.strength <= 0.0
        || !params.highlight_threshold.is_finite()
}

/// A GPU-resident capture-sharpening stage. Carries the RL parameters; device,
/// pipelines, and scratch planes come from the [`GpuContext`] / spatial substrate
/// at encode time. Mirrors `apply_capture_sharpening`.
pub struct CaptureSharpeningPass {
    pub params: CaptureSharpeningParams,
}

impl Pass for CaptureSharpeningPass {
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
        let byte_len = (width as u64) * (height as u64) * 4 * std::mem::size_of::<f32>() as u64;

        // No-op guard (sigma/iterations/strength/highlight_threshold) → src→dst.
        if is_noop(&self.params) {
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }

        // Upload the Gaussian kernel (built CPU-side, bit-identical to raw-core).
        let kernel_vals = gaussian_kernel_1d(self.params.sigma);
        let klen = kernel_vals.len() as u32;
        let kernel_buf = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("cs-kernel"),
                contents: bytemuck::cast_slice(&kernel_vals),
                usage: wgpu::BufferUsages::STORAGE,
            });

        // 1. extract → `original` luma plane.
        let original = alloc_plane(ctx, width, height, "cs-original");
        let cnt = CountParams {
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        dispatch(DispatchArgs {
            ctx,
            encoder,
            pipeline: ctx.cs_extract_pipeline(),
            params_bytes: bytemuck::bytes_of(&cnt),
            buffers: &[src, &original],
            count,
            label: "cs-extract",
        });

        // 2. estimate = original.clone().
        let estimate = alloc_plane(ctx, width, height, "cs-estimate");
        encoder.copy_buffer_to_buffer(&original, 0, &estimate, 0, plane_byte_len(width, height));

        // Reusable scratch planes for the RL loop.
        let blur_est = alloc_plane(ctx, width, height, "cs-blur-est");
        let ratio = alloc_plane(ctx, width, height, "cs-ratio");
        let blur_ratio = alloc_plane(ctx, width, height, "cs-blur-ratio");
        let gauss_scratch = alloc_plane(ctx, width, height, "cs-gauss-scratch");

        // 3. N Richardson–Lucy iterations.
        for _ in 0..self.params.iterations {
            // a. blur_est = blur(estimate).
            cs_gaussian_encode(GaussArgs {
                ctx,
                encoder,
                kernel: &kernel_buf,
                klen,
                input: &estimate,
                output: &blur_est,
                scratch: &gauss_scratch,
                width,
                height,
            });
            // b. Dampened RL ratio: mirrors raw-core's per-pixel dampen step.
            //    ratio[i] = 1 + (raw_ratio-1) * b²/(b² + noise²)
            //    where raw_ratio = clamp(original[i] / max(blur_est[i], 1e-6), 0, 100).
            //    When noise_floor <= 0 the kernel falls through to the classic undampened
            //    clamp (noise2 = 0.0 in WGSL, so dampen = b2/(b2+0) = 1 when b > 0).
            let ratio_params = RatioParams {
                count,
                noise_floor: self.params.noise_floor,
                _pad0: 0,
                _pad1: 0,
            };
            dispatch(DispatchArgs {
                ctx,
                encoder,
                pipeline: ctx.cs_ratio_pipeline(),
                params_bytes: bytemuck::bytes_of(&ratio_params),
                buffers: &[&original, &blur_est, &ratio],
                count,
                label: "cs-ratio",
            });
            // c. blur_ratio = blur(ratio).
            cs_gaussian_encode(GaussArgs {
                ctx,
                encoder,
                kernel: &kernel_buf,
                klen,
                input: &ratio,
                output: &blur_ratio,
                scratch: &gauss_scratch,
                width,
                height,
            });
            // d. estimate *= blur_ratio (in place).
            dispatch(DispatchArgs {
                ctx,
                encoder,
                pipeline: ctx.cs_multiply_pipeline(),
                params_bytes: bytemuck::bytes_of(&cnt),
                buffers: &[&estimate, &blur_ratio],
                count,
                label: "cs-multiply",
            });
        }

        // 4. apply: highlight-faded per-channel scale → dst. hi_thresh clamped
        //    CPU-side to < 1.0 (raw-core's `.min(0.999)`).
        let apply_params = ApplyParams {
            count,
            strength: self.params.strength,
            hi_thresh: self.params.highlight_threshold.min(0.999),
            _pad0: 0,
        };
        dispatch(DispatchArgs {
            ctx,
            encoder,
            pipeline: ctx.cs_apply_pipeline(),
            params_bytes: bytemuck::bytes_of(&apply_params),
            buffers: &[&original, &estimate, src, dst],
            count,
            label: "cs-apply",
        });
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity / noise_reduction's tests.rs split). Native test builds
// only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "capture_sharpening/tests.rs"]
mod tests;
