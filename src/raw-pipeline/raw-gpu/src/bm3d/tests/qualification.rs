use super::*;

#[test]
#[ignore = "physical RAW qualification, explicitly provision the fixture"]
fn bm3d_physical_scene_parity() {
    let edge = std::env::var("MAPLE_BM3D_PARITY_EDGE")
        .ok()
        .map(|v| v.parse().expect("integer parity edge"))
        .unwrap_or(512);
    let (w, h, input) = physical_input(edge);
    let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *p = [q[0], q[1], q[2]];
    }
    raw_core::stages::bm3d::apply(&mut cpu, 50.0, None);
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let image = GpuImage::upload(&ctx, &input, w, h);
    let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength: 50.0 }]);
    let mut worst = 0.0_f32;
    let mut total = 0.0_f64;
    for (p, q) in cpu.pixels.iter().zip(gpu.chunks_exact(4)) {
        for c in 0..3 {
            let error = (p[c] - q[c]).abs() / p[c].abs().max(1.0);
            worst = worst.max(error);
            total += f64::from(error);
        }
    }
    eprintln!(
        "BM3D physical test_0007 {w}x{h}: max relative={worst}, mean={}",
        total / f64::from(w * h * 3)
    );
    assert!(worst < 1e-4, "physical BM3D parity: {worst}");
}

#[test]
#[ignore = "controlled-hardware latency gate; run explicitly in release"]
fn bm3d_resident_latency_gate() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let w: u32 = std::env::var("MAPLE_BM3D_BENCH_EDGE")
        .unwrap_or_else(|_| "512".into())
        .parse()
        .unwrap();
    let physical = std::env::var_os("MAPLE_BM3D_BENCH_PHYSICAL").is_some();
    let (w, h, input) = if physical {
        physical_input(w)
    } else {
        (w, w * 2 / 3, fixture(w, w * 2 / 3))
    };
    eprintln!(
        "BM3D benchmark fixture: {}",
        if physical {
            "physical test_0007.DNG"
        } else {
            "synthetic gradient/noise"
        }
    );
    let image = GpuImage::upload(&ctx, &input, w, h);
    let output = GpuImage::upload(&ctx, &input, w, h);
    let pass = DeepDenoisePass { strength: 50.0 };
    eprintln!(
        "BM3D subgroup width: {:?}",
        ctx.bm3d_pipelines().subgroup_width
    );
    let mut elapsed = Vec::with_capacity(20);
    let mut warm_allocations = 0;
    for tick in 0..23 {
        let started = std::time::Instant::now();
        if tick == 22 && std::env::var_os("MAPLE_BM3D_GPU_PROFILE").is_some() {
            super::gpu_profile::begin(&ctx);
        }
        if std::env::var_os("MAPLE_BM3D_PROFILE").is_some() {
            PROFILE.with_borrow_mut(|p| *p = Some(started));
        }
        ctx.frame_pool.borrow_mut().begin_frame(5099);
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("BM3D latency"),
            });
        pass.encode(&ctx, &mut encoder, &image.buffer, &output.buffer, (w, h));
        ctx.queue.submit(Some(encoder.finish()));
        ctx.device.poll(wgpu::Maintain::Wait);
        ctx.frame_pool.borrow_mut().end_frame();
        if tick == 2 {
            warm_allocations = ctx.frame_pool.borrow().alloc_count();
        }
        if tick > 2 {
            elapsed.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(
                ctx.frame_pool.borrow().alloc_count(),
                warm_allocations,
                "warm tick allocated GPU resources"
            );
        }
    }
    super::gpu_profile::flush(&ctx);
    elapsed.sort_by(f64::total_cmp);
    eprintln!(
        "BM3D resident {w}x{h} {}: p50={:.3}ms p95={:.3}ms max={:.3}ms",
        ctx.adapter.get_info().name,
        elapsed[10],
        elapsed[18],
        elapsed[19]
    );
    assert!(
        elapsed[19] < 50.0,
        "BM3D alone exceeds the full slider hard limit: {elapsed:?}"
    );
}

/// Force both cache axes to split, and independently exercise the portable
/// implementation even on a native adapter with subgroup acceleration.
#[test]
fn bm3d_tiled_portable_and_native_match_cpu() {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            subgroups::FORCE_PORTABLE.with(|flag| flag.set(false));
            cached::TEST_CACHE_LIMIT.with(|limit| limit.set(u32::MAX));
        }
    }
    let _reset = Reset;
    cached::TEST_CACHE_LIMIT.with(|limit| limit.set(1024 * 1024));
    let (w, h) = (127, 91);
    let input = fixture(w, h);
    let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (pixel, rgba) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *pixel = [rgba[0], rgba[1], rgba[2]];
    }
    raw_core::stages::bm3d::apply(&mut cpu, 50.0, None);
    for portable in [false, true] {
        subgroups::FORCE_PORTABLE.with(|flag| flag.set(portable));
        let ctx = GpuContext::new_blocking().expect("GPU required for tiled parity");
        let workspace =
            cached::Workspace::new(&ctx, w, h, (w - 8).div_ceil(6) + 1, (h - 8).div_ceil(6) + 1);
        assert!(workspace.is_tiled_for_test((w - 8).div_ceil(6) + 1, (h - 8).div_ceil(6) + 1));
        if portable {
            assert_eq!(ctx.bm3d_pipelines().subgroup_width, None);
        }
        let image = GpuImage::upload(&ctx, &input, w, h);
        let result =
            ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength: 50.0 }]);
        let mut worst = 0.0_f32;
        for ((expected, actual), original) in cpu
            .pixels
            .iter()
            .zip(result.chunks_exact(4))
            .zip(input.chunks_exact(4))
        {
            assert_eq!(actual[3].to_bits(), original[3].to_bits());
            for c in 0..3 {
                worst = worst.max((expected[c] - actual[c]).abs() / expected[c].abs().max(1.0));
            }
        }
        eprintln!("BM3D tiled portable={portable}: max relative={worst}");
        assert!(worst < 1e-4, "tiled BM3D portable={portable}: {worst}");
    }
}

#[test]
fn bm3d_signed_hdr_matches_cpu() {
    let ctx = GpuContext::new_blocking().expect("GPU required for signed HDR parity");
    let (w, h) = (53, 47);
    for (scale, offset) in [(40.0, -8.0), (1.0, -2.0)] {
        let mut input = fixture(w, h);
        for pixel in input.chunks_exact_mut(4) {
            for channel in &mut pixel[..3] {
                *channel = *channel * scale + offset;
            }
        }
        assert!(input
            .chunks_exact(4)
            .any(|p| p[..3].iter().any(|c| *c < 0.0)));
        let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (pixel, rgba) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *pixel = [rgba[0], rgba[1], rgba[2]];
        }
        raw_core::stages::bm3d::apply(&mut cpu, 50.0, None);
        let image = GpuImage::upload(&ctx, &input, w, h);
        CAPTURE.with_borrow_mut(|v| *v = Some(Vec::new()));
        let result =
            ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength: 50.0 }]);
        let captures = CAPTURE.with_borrow_mut(|v| v.take().unwrap());
        let values: Vec<Vec<f32>> = captures
            .iter()
            .map(|(_, b)| {
                pollster::block_on(crate::chain::read_buffer_async(&ctx, b, b.size())).unwrap()
            })
            .collect();
        let noisy: [Vec<f32>; 3] = std::array::from_fn(|c| {
            input
                .chunks_exact(4)
                .map(|p| {
                    let y = LUMA_REC2020[0]
                        .mul_add(p[0], LUMA_REC2020[1].mul_add(p[1], LUMA_REC2020[2] * p[2]));
                    match c {
                        0 => y,
                        1 => p[0] - y,
                        _ => p[2] - y,
                    }
                })
                .collect()
        });
        let mut sample: Vec<f32> = noisy[0].iter().step_by(8).copied().collect();
        sample.sort_unstable_by(f32::total_cmp);
        let sigma = SIGMA_K * 0.5 * (sample[sample.len() / 2] + ANCHOR_PEDESTAL);
        assert_eq!(
            values[0][0].to_bits(),
            sigma.to_bits(),
            "signed median sigma"
        );
        let basic = pipeline::run_pass(
            &noisy,
            w as usize,
            h as usize,
            [
                sigma,
                sigma * CHROMA_SIGMA_RATIO,
                sigma * CHROMA_SIGMA_RATIO,
            ],
            T_MATCH_SQ * sigma * sigma,
            pipeline::PassKind::Hard,
            "hard",
            None,
            &|| false,
        )
        .unwrap();
        let basic_worst = values[1]
            .chunks_exact(4)
            .enumerate()
            .flat_map(|(i, p)| (0..3).map(move |c| (i, c, p[c])))
            .map(|(i, c, v)| (v - basic[c][i]).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("HDR sigma={sigma} basic worst={basic_worst}");

        let mut worst = 0.0_f32;
        for ((expected, actual), original) in cpu
            .pixels
            .iter()
            .zip(result.chunks_exact(4))
            .zip(input.chunks_exact(4))
        {
            assert_eq!(actual[3].to_bits(), original[3].to_bits());
            for c in 0..3 {
                assert!(actual[c].is_finite());
                worst = worst.max((expected[c] - actual[c]).abs() / expected[c].abs().max(1.0));
            }
        }
        eprintln!("BM3D signed HDR scale={scale} offset={offset}: max relative={worst}");
        assert!(worst < 1e-4, "signed HDR BM3D: {worst}");
    }
}

fn physical_input(edge: u32) -> (u32, u32, Vec<f32>) {
    use raw_core::{
        pipeline::{
            render_scene_linear_sized_from_raw_with_quality_f32_cancellable, RenderQuality,
        },
        types::adjustment::AutoExposureMode,
        xmp::AdjustmentModel,
        CancelToken,
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0007.DNG");
    let raw = raw_core::decode::decode(&path).expect("physical test_0007.DNG required");
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        nr_color: 0.0,
        sharpen_amount: 0.0,
        ..Default::default()
    };
    render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
        &raw,
        &model,
        RenderQuality::Preview,
        edge,
        CancelToken::never(),
    )
    .unwrap()
}
