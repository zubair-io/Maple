//! sRGB gamma-encode stage — a P4a view-tail WGSL port (epic #925 / #992-pre).
//!
//! Ports `raw_core::view::encode::srgb_gamma_encode` (the per-channel sRGB OETF,
//! IEC 61966-2-1): the f32 → f32 transfer encode that closes the GPU view tail's
//! display-correctness gap. Because the Auto Profile curve + residual LUT were
//! *fit in gamma space*, this stage MUST run between `display_encode`
//! (`rec2020_to_srgb`) and `auto_profile_curve` — exactly where raw-core's
//! `render` view tail calls it (between `rec2020_to_srgb` and `apply_curve`).
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_srgb_gamma`] — the CPU oracle: a faithful per-channel port of
//!    `srgb_gamma` (clamp-to-`[0,1]`-then-piecewise) over a flat RGBA f32 buffer.
//! 2. [`SrgbGammaPass`] — the GPU-resident [`Pass`]. Carries no parameters (the
//!    transfer is fixed). The kernel is pure per-channel, so it compiles
//!    standalone (no generated color matrices — like exposure / scene_tone).
//! 3. The headless parity test (`#[cfg(test)] mod tests`) — GPU vs
//!    `raw_core::view::encode::srgb_gamma_encode` (the real stage, via the
//!    test-only raw-core dev-dep) `< 1e-4`, on a buffer exercising the
//!    negative-clamp, the high-clamp (> 1), the linear toe, the knee, and the
//!    power branch.
//!
//! This is the transfer/OETF step ONLY — it is NOT the dither/quantize-to-u8
//! step (`dither_and_quantize`), which is the format-changing display-OUTPUT
//! stage of the live path (P4b), outside this f32-RGBA crate's scope.

use crate::chain::Pass;
use crate::context::GpuContext;
use wgpu::util::DeviceExt;

/// `repr(C)` params uniform shared by the WGSL kernel (`srgb_gamma.wgsl`).
/// `count` is the RGBA pixel count; `_pad*` round the struct to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// Single-channel piecewise sRGB gamma encode. Verbatim port of
/// `raw_core::view::encode::srgb_gamma`: clamp to `[0, 1]` FIRST (both ends, so
/// the power branch never sees a negative base), then the IEC 61966-2-1 OETF.
#[inline]
fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB gamma encode on an interleaved RGBA f32 buffer (alpha untouched). This is
/// the CPU oracle — a faithful per-channel port of
/// `raw_core::view::encode::srgb_gamma_encode`. f32 → f32; no quantize.
pub fn apply_srgb_gamma(buf: &mut [f32]) {
    for px in buf.chunks_exact_mut(4) {
        px[0] = srgb_gamma(px[0]);
        px[1] = srgb_gamma(px[1]);
        px[2] = srgb_gamma(px[2]);
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident sRGB gamma-encode stage (per-channel IEC OETF). Carries no
/// parameters — the transfer is fixed. The device, pipeline, and ping-pong
/// buffers come from the [`GpuContext`] / [`ChainRunner`].
pub struct SrgbGammaPass;

impl Pass for SrgbGammaPass {
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

        let params = Params {
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        let params_buf = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("srgb-gamma-params"),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let pipeline = ctx.srgb_gamma_pipeline();
        // Fresh bind group per pass: a bind group's bound buffers are fixed at
        // creation, so each ping-pong direction (src/dst) needs its own.
        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("srgb-gamma-bg"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: src.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: dst.as_entire_binding(),
                },
            ],
        });

        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("srgb-gamma-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(pixel_count.div_ceil(64), 1, 1);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;

    /// A buffer that exercises EVERY branch of the transfer:
    ///   - a negative channel → the lower clamp (must NOT reach `pow(neg, ..)`),
    ///   - 0.0 and 0.001 → the linear toe (`x * 12.92`),
    ///   - 0.0031308 → the knee itself,
    ///   - 0.05 / 0.18 / 0.5 → the power branch (the common display range),
    ///   - 1.0 → the high edge,
    ///   - 2.0 / 5.0 → the upper clamp (HDR overshoot → 1.0 before encode).
    fn gamma_buffer() -> Vec<f32> {
        vec![
            // r,      g,    b,    a       branch
            -0.10, 0.00, 0.001, 1.0, // r: neg-clamp, g: toe@0, b: toe
            0.003_130_8, 0.05, 0.18, 0.7, // r: knee, g/b: power branch
            0.50, 1.00, 2.00, 1.0, // r: power, g: high edge, b: upper-clamp
            5.00, -0.50, 0.20, 0.5, // r: upper-clamp, g: neg-clamp, b: power
        ]
    }

    /// Run `raw_core::view::encode::srgb_gamma_encode` on a flat interleaved RGBA
    /// f32 buffer, returning a new buffer (alpha carried through). The input is
    /// `DisplayLinearSrgb` (the space `srgb_gamma_encode` asserts). This is the
    /// ticket's actual reference — the Rust stage itself.
    fn raw_core_srgb_gamma(buf: &[f32]) -> Vec<f32> {
        use raw_core::image::{ColorSpace, Image};
        let count = buf.len() / 4;
        let mut img = Image::new(count as u32, 1, ColorSpace::DisplayLinearSrgb);
        for (i, chunk) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        let mut out = Vec::with_capacity(buf.len());
        for (i, p) in img.pixels.iter().enumerate() {
            out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
        }
        out
    }

    /// THE PARITY GATE (the ticket's contract): the WGSL srgb_gamma kernel
    /// matches `raw_core::view::encode::srgb_gamma_encode` — the actual Rust
    /// stage, via the test-only raw-core dev-dep — within 1e-4, on a buffer
    /// exercising the negative-clamp, high-clamp, linear toe, knee, and power
    /// branch (the full [0, 1]+ range).
    #[test]
    fn wgsl_srgb_gamma_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking();
        let input = gamma_buffer();
        let count = (input.len() / 4) as u32;

        let reference = raw_core_srgb_gamma(&input);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SrgbGammaPass]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core srgb_gamma_encode: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "GPU vs raw-core srgb_gamma_encode max abs diff {max_diff} exceeds 1e-4"
        );
    }

    /// Pin the local CPU oracle to raw-core's stage too, so the convenience
    /// oracle this crate exports can't silently drift. (The GPU gate above
    /// doesn't depend on the local oracle.)
    #[test]
    fn local_oracle_matches_raw_core_stage_within_1e_4() {
        let input = gamma_buffer();
        let reference = raw_core_srgb_gamma(&input);
        let mut local = input.clone();
        apply_srgb_gamma(&mut local);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-4,
            "local oracle vs raw-core srgb_gamma_encode diff {max_diff} exceeds 1e-4"
        );
    }

    /// Out-of-range input must be clamped on BOTH ends on the GPU: a negative
    /// channel encodes to 0.0, an HDR-overshoot channel (> 1) encodes to 1.0,
    /// and alpha passes through untouched. (A one-sided clamp would surface here
    /// as a NaN from `pow(neg, 1/2.4)` on the negative channel.)
    #[test]
    fn out_of_range_input_clamps_both_ends_on_gpu() {
        let ctx = GpuContext::new_blocking();
        // r negative → 0, g HDR → 1, b in-range mid, alpha = 0.5 (must survive).
        let input = vec![-0.3_f32, 4.0, 0.18, 0.5];
        let img = GpuImage::upload(&ctx, &input, 1, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SrgbGammaPass]);
        assert!(gpu[0].abs() < 1e-6, "negative channel must clamp to 0: {}", gpu[0]);
        assert!(
            (gpu[1] - 1.0).abs() < 1e-6,
            "HDR-overshoot channel must clamp to 1: {}",
            gpu[1]
        );
        assert!(
            (0.0..=1.0).contains(&gpu[2]),
            "in-range channel must stay in [0, 1]: {}",
            gpu[2]
        );
        assert_eq!(gpu[3], 0.5, "alpha must pass through unchanged");
    }
}
