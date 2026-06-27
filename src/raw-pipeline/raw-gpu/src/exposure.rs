//! Exposure stage — the P1a proof kernel.
//!
//! `apply_exposure_gain` is the CPU oracle (parity reference). `ExposurePass`
//! runs the same math GPU-resident as a [`Pass`] in a [`ChainRunner`] chain.
//! `run_exposure_gpu_async` is the P0 one-shot entry point, retained so the
//! raw-wasm WebGPU parity binding keeps working unchanged.

use crate::chain::Pass;
use crate::context::GpuContext;
use wgpu::util::DeviceExt;

/// `repr(C)` params uniform shared by the WGSL kernel (`exposure.wgsl`).
/// `count` is the number of RGBA pixels; `_pad*` round the struct to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    ev: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

/// Scene-linear exposure gain on an interleaved RGBA f32 buffer:
/// `rgb *= 2^ev`, alpha untouched. This is the CPU oracle — it mirrors the
/// `baseline_exposure.exp2()` multiply in `pipeline::develop` (and the additive-
/// EV user exposure), kept standalone so the GPU substrate isolates plumbing
/// rather than full pipeline integration.
pub fn apply_exposure_gain(buf: &mut [f32], ev: f32) {
    let gain = ev.exp2();
    for px in buf.chunks_exact_mut(4) {
        px[0] *= gain;
        px[1] *= gain;
        px[2] *= gain;
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident exposure stage. Carries only its `ev`; the device, pipeline,
/// and ping-pong buffers come from the [`GpuContext`] / [`ChainRunner`] at
/// encode time. Each pass builds its OWN params uniform and bind group inside
/// `encode`, so an N-pass chain with a different `ev` per pass produces the
/// composed gain `2^(sum of evs)` — a single shared uniform could not.
pub struct ExposurePass {
    pub ev: f32,
}

impl Pass for ExposurePass {
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

        // Per-pass uniform: each ExposurePass binds its own `ev`. wgpu keeps
        // this buffer + bind group alive via the command buffer until submit.
        let params = Params {
            ev: self.ev,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        };
        let params_buf = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("exposure-params"),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let pipeline = ctx.exposure_pipeline();
        // Fresh bind group per pass: a bind group's bound buffers are fixed at
        // creation, so each ping-pong direction (src/dst) needs its own.
        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("exposure-bg"),
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
            label: Some("exposure-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        let groups = pixel_count.div_ceil(64);
        let gx = groups.min(65535);
        // Guard the empty dispatch: pixel_count==0 -> gx==0, and div_ceil(0)
        // panics. (0,0,1) is a safe no-op (the original 1-D (0,1,1) was). #1623
        let gy = if gx == 0 { 0 } else { groups.div_ceil(gx) };
        pass.dispatch_workgroups(gx, gy, 1);
    }
}

/// Native blocking entry: run the WGSL exposure kernel on the default adapter
/// (Metal on macOS) and return the result buffer. Not compiled for wasm (which
/// awaits the async fn directly). `Err` when no adapter/device is available or
/// the readback fails (#1079).
#[cfg(not(target_arch = "wasm32"))]
pub fn run_exposure_gpu(input: &[f32], ev: f32) -> Result<Vec<f32>, String> {
    pollster::block_on(run_exposure_gpu_async(input, ev))
}

/// P0 one-shot async runner, retained for the raw-wasm WebGPU parity binding.
/// Builds a one-pixel-row `GpuImage` and runs a single-pass exposure chain, so
/// it shares the exact code path the substrate exercises. GPU-resident: upload →
/// dispatch → one readback (readback is test/export-only, never interactive).
/// `Err` when GPU init or the readback fails (#1079) — the parity bindings
/// surface it instead of aborting through the FFI.
pub async fn run_exposure_gpu_async(input: &[f32], ev: f32) -> Result<Vec<f32>, String> {
    let ctx = GpuContext::new_async().await?;
    let pixel_count = (input.len() / 4) as u32;
    let img = crate::image::GpuImage::upload(&ctx, input, pixel_count, 1);
    let runner = crate::chain::ChainRunner::new(&ctx, &img);
    Ok(runner
        .run_async(&[&ExposurePass { ev }])
        .await?
        .expect("single-pass exposure chain never cancels"))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;
    use crate::test_buffer;

    #[test]
    fn exposure_gain_doubles_rgb_at_plus_one_ev_and_keeps_alpha() {
        // Two RGBA pixels. +1 EV → gain = 2^1 = 2.0.
        let mut buf = vec![0.1, 0.2, 0.4, 1.0, 0.5, 0.5, 0.5, 0.3];
        apply_exposure_gain(&mut buf, 1.0);
        assert!((buf[0] - 0.2).abs() < 1e-6);
        assert!((buf[1] - 0.4).abs() < 1e-6);
        assert!((buf[2] - 0.8).abs() < 1e-6);
        assert!((buf[3] - 1.0).abs() < 1e-6, "alpha untouched");
        assert!((buf[4] - 1.0).abs() < 1e-6);
        assert!((buf[7] - 0.3).abs() < 1e-6, "alpha untouched");
    }

    /// The migrated P0 parity test: the one-shot GPU runner matches the CPU
    /// oracle within 1e-4 across a spread of EVs.
    #[test]
    fn wgsl_exposure_matches_cpu_oracle_within_1e_4() {
        let input = test_buffer(256);
        for &ev in &[-3.0_f32, 0.0, 0.5, 4.0] {
            let mut cpu = input.clone();
            apply_exposure_gain(&mut cpu, ev);
            let gpu = run_exposure_gpu(&input, ev).expect("gpu exposure run");
            let max_diff = cpu
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            eprintln!("PARITY ev={ev}: max abs diff = {max_diff:e}");
            assert!(
                max_diff < 1e-4,
                "ev={ev}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
            );
        }
    }

    /// >cap 2-D dispatch regression: with more than 65535 workgroups the
    /// dispatch tiles into a 2-D grid (`gy > 1`). The buggy 1-D index
    /// (`gid.x` alone) addressed only the first 65535*64 pixels and left the
    /// `gy==1` tile untouched; the fixed index
    /// (`gid.y * ng.x * 64u + gid.x`) reaches every pixel. This test uses a
    /// 2176x2176-equivalent buffer (4,734,976 px → 73,984 groups → gx=65535,
    /// gy=2) so the high-index path is exercised; on small images the new and
    /// old indices coincide and would pass regardless.
    #[test]
    fn wgsl_exposure_matches_cpu_oracle_above_dispatch_cap() {
        // 2176 * 2176 = 4,734,976 pixels.
        let pixel_count: usize = 2176 * 2176;
        // Sanity: confirm this buffer actually drives a 2-D dispatch (gy > 1).
        let groups = (pixel_count as u32).div_ceil(64);
        let gx = groups.min(65535);
        let gy = groups.div_ceil(gx);
        assert!(groups > 65535, "buffer must exceed the 65535-group 1-D cap");
        assert!(gy > 1, "dispatch must tile into 2-D (gy>1), got gy={gy}, gx={gx}");

        let input = test_buffer(pixel_count);
        let ev = 0.5_f32;
        let mut cpu = input.clone();
        apply_exposure_gain(&mut cpu, ev);
        let gpu = run_exposure_gpu(&input, ev).expect("gpu exposure run");

        // Track the worst diff AND its location so a regression that only
        // misses the gy==1 tile (high pixel indices) is unmistakable.
        let (max_diff, worst_idx) = cpu
            .iter()
            .zip(&gpu)
            .enumerate()
            .map(|(idx, (a, b))| ((a - b).abs(), idx))
            .fold((0.0_f32, 0usize), |(m, mi), (d, idx)| {
                if d > m { (d, idx) } else { (m, mi) }
            });
        eprintln!(
            ">CAP PARITY ev={ev} pixels={pixel_count} gx={gx} gy={gy}: \
             max abs diff = {max_diff:e} at flat idx {worst_idx} (px {})",
            worst_idx / 4
        );
        assert!(
            max_diff < 1e-4,
            "above-cap GPU vs CPU max abs diff {max_diff} exceeds 1e-4 \
             (worst at px {})",
            worst_idx / 4
        );
    }

    /// The headless P1a proof: an N-pass chain of `ExposurePass(ev_i)` equals
    /// the CPU oracle composed over all passes, < 1e-4, with exactly one
    /// readback for the whole chain (zero inter-pass CPU readback).
    #[test]
    fn n_pass_exposure_chain_matches_composed_oracle_within_1e_4() {
        let ctx = GpuContext::new_blocking().expect("gpu context");
        let input = test_buffer(256);
        let evs = [0.5_f32, -1.0, 2.0]; // composed gain = 2^(0.5 - 1 + 2)
        let img = GpuImage::upload(&ctx, &input, 256, 1);
        let passes: Vec<ExposurePass> = evs.iter().map(|&ev| ExposurePass { ev }).collect();
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p as &dyn Pass).collect();

        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&pass_refs);

        let mut cpu = input.clone();
        for &ev in &evs {
            apply_exposure_gain(&mut cpu, ev);
        }
        let max = cpu
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("N-PASS PARITY (evs={evs:?}): max abs diff = {max:e}");
        assert!(max < 1e-4, "n-pass max abs diff {max} exceeds 1e-4");

        // Exactly one readback for the whole 3-pass chain — proves zero
        // inter-pass CPU readback. Assert on the SAME runner instance that ran.
        assert_eq!(
            runner.last_readback_count(),
            1,
            "expected exactly one readback for the whole chain"
        );
    }
}
