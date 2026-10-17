use super::*;
use crate::{ChainRunner, GpuImage};

#[test]
#[ignore = "local GPU timing diagnostic, not a live-frame performance gate"]
fn full_stage_warm_timing() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for size in [64, 128, 256, 512] {
        let values: Vec<f32> = (0..size * size)
            .flat_map(|i| [0.18 + ((i * 31) % 127) as f32 / 1000., 0.22, 0.07, 0.37])
            .collect();
        let source = GpuImage::upload(&ctx, &values, size, size);
        let runner = ChainRunner::new(&ctx, &source);
        let run = || {
            ctx.frame_pool.borrow_mut().begin_frame(4629);
            let start = std::time::Instant::now();
            let result = runner.run_blocking(&[&Bm3dPass { strength: 25. }]);
            let milliseconds = start.elapsed().as_secs_f64() * 1000.;
            ctx.frame_pool.borrow_mut().end_frame();
            assert!(result.iter().all(|v| v.is_finite()));
            milliseconds
        };
        run();
        let allocations = ctx.frame_pool.borrow().alloc_count();
        let mut timings: Vec<_> = (0..5).map(|_| run()).collect();
        timings.sort_by(f64::total_cmp);
        assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
        eprintln!("BM3D RGB warm {size}x{size}: median_ms={} samples={timings:?}; includes final readback, not a live frame", timings[2]);
    }
}

fn read(ctx: &GpuContext, buffer: &wgpu::Buffer, bytes: u64) -> Vec<f32> {
    pollster::block_on(crate::chain::read_buffer_async(ctx, buffer, bytes)).unwrap()
}

#[test]
fn median_selects_exact_upper_rank_with_signed_duplicate_and_adjacent_values() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h) in [(8, 8), (9, 9), (64, 65), (1025, 257)] {
        for kind in 0..4 {
            let values: Vec<f32> = (0..w * h)
                .flat_map(|i| {
                    let y = match kind {
                        0 => 0.18,
                        1 => ((i * 31) % 127) as f32 / 31. - 2.,
                        2 => f32::from_bits(0.5f32.to_bits() + (i * 17) % 11),
                        _ => -f32::from_bits(0.5f32.to_bits() + (i * 13) % 11),
                    };
                    [y, y, y, 0.37]
                })
                .collect();
            let image = GpuImage::upload(&ctx, &values, w, h);
            let params = Params::new((w, h), 25.);
            let mut encoder = ctx.device.create_command_encoder(&Default::default());
            let prepared = prepare(&ctx, &mut encoder, &image.buffer, &params);
            ctx.queue.submit(Some(encoder.finish()));
            let noisy = read(&ctx, &prepared.noisy, u64::from(w * h) * 16);
            let mut samples: Vec<_> = noisy.chunks_exact(4).step_by(8).map(|p| p[0]).collect();
            samples.sort_unstable_by(f32::total_cmp);
            let median = samples[samples.len() / 2];
            let key = read(&ctx, &prepared.state, 16)[0].to_bits();
            let bits = if key & 0x80000000 != 0 {
                key ^ 0x80000000
            } else {
                !key
            };
            assert_eq!(bits, median.to_bits(), "{w}x{h} kind{kind}");
            let noise = read(&ctx, &prepared.noise, 16);
            let sigma = 0.2 * params.strength * (median + 0.001);
            for (actual, expected) in
                noise
                    .iter()
                    .zip([6.25 * sigma * sigma, sigma, 1.8 * sigma, 1.8 * sigma])
            {
                assert!((actual - expected).abs() <= expected.abs() * 5e-7 + 1e-12);
            }
            assert!(noisy
                .chunks_exact(4)
                .all(|p| p[3].to_bits() == 0.37f32.to_bits()));
        }
    }
}

#[test]
fn warm_full_stage_reuses_resources_and_reads_back_only_the_final_rgb() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let values: Vec<f32> = (0..23 * 19)
        .flat_map(|i| [0.18 + ((i * 31) % 127) as f32 / 1000., 0.22, 0.07, 0.37])
        .collect();
    let source = GpuImage::upload(&ctx, &values, 23, 19);
    let runner = ChainRunner::new(&ctx, &source);
    let run = |strength| {
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let result = runner.run_blocking(&[&Bm3dPass { strength }]);
        ctx.frame_pool.borrow_mut().end_frame();
        assert_eq!(runner.last_readback_count(), 1);
        assert!(result
            .chunks_exact(4)
            .all(|p| p[3].to_bits() == 0.37f32.to_bits()));
        result
    };
    let first = run(25.);
    assert_ne!(first, values);
    let allocations = ctx.frame_pool.borrow().alloc_count();
    assert!(allocations > 0);
    assert_eq!(first, run(25.));
    assert_ne!(first, run(100.));
    assert_eq!(first, run(25.));
    let changed: Vec<f32> = values
        .chunks_exact(4)
        .flat_map(|p| [p[0] * 1.5, p[1], p[2], p[3]])
        .collect();
    ctx.queue
        .write_buffer(&source.buffer, 0, bytemuck::cast_slice(&changed));
    assert_ne!(first, run(25.));
    ctx.queue
        .write_buffer(&source.buffer, 0, bytemuck::cast_slice(&values));
    assert_eq!(first, run(25.));
    assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
}

#[test]
fn disabled_and_tiny_stages_are_exact_copies_without_scratch_allocations() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h, strength) in [
        (8, 8, 0.),
        (8, 8, -1.),
        (8, 8, 0.0009),
        (7, 13, 100.),
        (13, 7, 100.),
    ] {
        let values: Vec<f32> = (0..w * h)
            .flat_map(|i| [i as f32 / 31. - 1., 0.18, 2., 0.37])
            .collect();
        let source = GpuImage::upload(&ctx, &values, w, h);
        let runner = ChainRunner::new(&ctx, &source);
        ctx.frame_pool.borrow_mut().begin_frame(4629);
        let allocations = ctx.frame_pool.borrow().alloc_count();
        assert_eq!(runner.run_blocking(&[&Bm3dPass { strength }]), values);
        assert_eq!(ctx.frame_pool.borrow().alloc_count(), allocations);
        ctx.frame_pool.borrow_mut().end_frame();
    }
}
