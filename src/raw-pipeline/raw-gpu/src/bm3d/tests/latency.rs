//! Capture-refine qualification (#5217). The refine runs when a capture slider
//! is released, so it carries its own budget and is never a slider-tick gate.
use super::qualification::physical_input;
use super::*;
use crate::{CaptureSharpeningParams, CaptureSharpeningPass, ChromaPrefilterPass};

const MIB: f64 = 1024.0 * 1024.0;
const WARMUP: usize = 3;
const TICKS: usize = 20;

/// (long edge, BM3D binding cap in MiB, p95 budget in ms) for the Mac and
/// iPhone capture configurations of #5213. Budgets are about 1.5x the p95
/// measured on an Apple M5 Max under shared build load and only ratchet down.
const CONFIGS: [(u32, u32, f64); 2] = [(2560, 128, 250.0), (1536, 32, 130.0)];

struct Measurement {
    p50: f64,
    p95: f64,
    max: f64,
    pooled_bytes: u64,
}

fn measure(
    ctx: &GpuContext,
    input: &[f32],
    (w, h): (u32, u32),
    passes: &[&dyn Pass],
) -> Measurement {
    let image = GpuImage::upload(ctx, input, w, h);
    let ping_pong = [
        GpuImage::upload(ctx, input, w, h),
        GpuImage::upload(ctx, input, w, h),
    ];
    ctx.frame_pool.borrow_mut().reset();
    let mut elapsed = Vec::with_capacity(TICKS);
    let mut warm_allocations = 0;
    for tick in 0..WARMUP + TICKS {
        let started = std::time::Instant::now();
        if tick + 1 == WARMUP + TICKS && std::env::var_os("MAPLE_BM3D_GPU_PROFILE").is_some() {
            super::gpu_profile::begin(ctx);
        }
        if std::env::var_os("MAPLE_BM3D_PROFILE").is_some() {
            PROFILE.with_borrow_mut(|p| *p = Some(started));
        }
        ctx.frame_pool.borrow_mut().begin_frame(5217);
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("capture refine latency"),
            });
        for (i, pass) in passes.iter().enumerate() {
            let src = if i == 0 {
                &image
            } else {
                &ping_pong[(i - 1) % 2]
            };
            pass.encode(
                ctx,
                &mut encoder,
                &src.buffer,
                &ping_pong[i % 2].buffer,
                (w, h),
            );
        }
        ctx.queue.submit(Some(encoder.finish()));
        ctx.device.poll(wgpu::Maintain::Wait);
        ctx.frame_pool.borrow_mut().end_frame();
        let allocations = ctx.frame_pool.borrow().alloc_count();
        if tick + 1 == WARMUP {
            warm_allocations = allocations;
        }
        if tick >= WARMUP {
            elapsed.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(
                allocations, warm_allocations,
                "warm tick allocated GPU resources"
            );
        }
    }
    super::gpu_profile::flush(ctx);
    elapsed.sort_by(f64::total_cmp);
    Measurement {
        p50: elapsed[TICKS / 2],
        p95: elapsed[TICKS * 95 / 100 - 1],
        max: elapsed[TICKS - 1],
        pooled_bytes: ctx.frame_pool.borrow().retained_bytes(),
    }
}

#[test]
#[ignore = "controlled-hardware capture-refine gate; run explicitly in release"]
fn capture_refine_latency_gate() {
    let physical = std::env::var_os("MAPLE_BM3D_BENCH_PHYSICAL").is_some();
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let adapter = ctx.adapter.get_info().name;
    let width = ctx.bm3d_pipelines().subgroup_width;
    eprintln!("capture refine on {adapter}, subgroup width {width:?}, physical={physical}");
    let mut failures = Vec::new();
    for (edge, cap_mib, budget) in CONFIGS {
        let (w, h, input) = if physical {
            physical_input(edge)
        } else {
            (edge, edge * 2 / 3, fixture(edge, edge * 2 / 3))
        };
        ctx.set_bm3d_binding_cap(cap_mib << 20);
        let token = CancelToken::new();
        let chroma = ChromaPrefilterPass { strength: 100.0 };
        let denoise = DeepDenoisePass {
            strength: 50.0,
            cancel: Some(token),
        };
        let sharpen = CaptureSharpeningPass {
            params: CaptureSharpeningParams::default(),
        };
        let refine = measure(&ctx, &input, (w, h), &[&chroma, &denoise, &sharpen]);
        let resident = 3.0 * (u64::from(w) * u64::from(h) * 16) as f64 / MIB;
        eprintln!(
            "capture refine {w}x{h} cap={cap_mib}MiB: p50={:.3}ms p95={:.3}ms max={:.3}ms \
             resident images={resident:.1}MiB pooled transient={:.1}MiB peak={:.1}MiB",
            refine.p50,
            refine.p95,
            refine.max,
            refine.pooled_bytes as f64 / MIB,
            resident + refine.pooled_bytes as f64 / MIB,
        );
        for (label, cancel) in [
            ("cancellable", Some(CancelToken::new())),
            ("no token", None),
        ] {
            let alone = measure(
                &ctx,
                &input,
                (w, h),
                &[&DeepDenoisePass {
                    strength: 50.0,
                    cancel,
                }],
            );
            eprintln!(
                "  BM3D alone, {label}: p50={:.3}ms p95={:.3}ms pooled={:.1}MiB",
                alone.p50,
                alone.p95,
                alone.pooled_bytes as f64 / MIB
            );
        }
        if refine.p95 > budget {
            failures.push(format!("{edge}px p95 {:.3}ms > {budget}ms", refine.p95));
        }
    }
    assert!(
        failures.is_empty(),
        "capture refine over budget: {failures:?}"
    );
}
