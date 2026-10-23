use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::image::{ColorSpace, Image};

#[path = "../../../raw-core/src/stages/bm3d/matching.rs"]
mod matching;
#[path = "../../../raw-core/src/stages/bm3d/pipeline.rs"]
mod pipeline;
#[path = "../../../raw-core/src/stages/bm3d/transforms.rs"]
mod transforms;
use raw_core::stages::bm3d::Progress;

type Captured = (&'static str, std::sync::Arc<wgpu::Buffer>);
thread_local! {
    static CAPTURE: std::cell::RefCell<Option<Vec<Captured>>> = const { std::cell::RefCell::new(None) };
    static PROFILE: std::cell::RefCell<Option<std::time::Instant>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn profile_boundary(ctx: &GpuContext, encoder: &mut wgpu::CommandEncoder, label: &str) {
    PROFILE.with_borrow_mut(|state| {
        if let Some(start) = state {
            let next = ctx
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("BM3D profile"),
                });
            let prior = std::mem::replace(encoder, next);
            ctx.queue.submit(Some(prior.finish()));
            ctx.device.poll(wgpu::Maintain::Wait);
            eprintln!(
                "BM3D phase {label}: {:.3}ms",
                start.elapsed().as_secs_f64() * 1000.0
            );
            *start = std::time::Instant::now();
        }
    });
}

pub(super) fn capture(
    ctx: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    src: &wgpu::Buffer,
    label: &'static str,
) {
    CAPTURE.with_borrow_mut(|state| {
        if let Some(captures) = state {
            let copy = spatial::alloc_plane(ctx, (src.size() / 4) as u32, 1, label);
            encoder.copy_buffer_to_buffer(src, 0, &copy, 0, src.size());
            captures.push((label, copy));
        }
    });
}

#[test]
fn bm3d_intermediate_parity() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (23, 19);
    let input = fixture(w, h);
    let image = GpuImage::upload(&ctx, &input, w, h);
    CAPTURE.with_borrow_mut(|v| *v = Some(Vec::new()));
    ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength: 20.0 }]);
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
    let sigma = SIGMA_K * 0.2 * (sample[sample.len() / 2] + ANCHOR_PEDESTAL);
    let tau = T_MATCH_SQ * sigma * sigma;
    assert_eq!(
        f32::from_bits(values[0][0].to_bits()),
        sigma,
        "median sigma"
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
        tau,
        pipeline::PassKind::Hard,
        "hard",
        None,
        &|| false,
    )
    .unwrap();
    for (phase, guide) in [(0, &noisy[0]), (1, &basic[0])] {
        let bits: Vec<u32> = values[phase * 2].iter().map(|x| x.to_bits()).collect();
        let mut g = 0;
        for y in matching::ref_coords(h as usize) {
            for x in matching::ref_coords(w as usize) {
                let expected = matching::find_group(guide, w as usize, h as usize, x, y, tau);
                let actual: Vec<(usize, usize)> = bits
                    [4 + g * 17 + 1..4 + g * 17 + 1 + bits[4 + g * 17] as usize]
                    .iter()
                    .map(|&v| ((v % w) as usize, (v / w) as usize))
                    .collect();
                assert_eq!(actual, expected, "phase={phase} ref={x},{y}");
                g += 1;
            }
        }
        if phase == 0 {
            let mut worst = 0.0_f32;
            for (i, px) in values[1].chunks_exact(4).enumerate() {
                for c in 0..3 {
                    worst = worst.max((px[c] - basic[c][i]).abs());
                }
            }
            assert!(worst < 1e-5, "basic estimate: {worst}");
        }
    }
}

#[test]
fn bm3d_cached_patch_means_match_cpu_tree() {
    use bytemuck::Zeroable;
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (23, 19);
    let input = fixture(w, h);
    let image = GpuImage::upload(&ctx, &input, w, h);
    let a = spatial::alloc_plane_vec2(&ctx, w, h, "metadata");
    let b = spatial::alloc_plane_vec2(&ctx, w, h, "vertical");
    let params = Params {
        dims: [w, h, 0, 0],
        luma: [LUMA_REC2020[0], LUMA_REC2020[1], LUMA_REC2020[2], 0.0],
        ..Params::zeroed()
    };
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    let stages = [
        (
            &ctx.bm3d_pipelines().prepare_luma,
            &image.buffer,
            a.as_ref(),
        ),
        (&ctx.bm3d_pipelines().vertical_mean, a.as_ref(), b.as_ref()),
        (
            &ctx.bm3d_pipelines().horizontal_mean,
            b.as_ref(),
            a.as_ref(),
        ),
    ];
    for (pipeline, src, dst) in stages {
        spatial::encode_simple(
            &ctx,
            &mut encoder,
            pipeline,
            bytemuck::bytes_of(&params),
            &[src, dst],
            w * h,
            "metadata",
        );
    }
    ctx.queue.submit(Some(encoder.finish()));
    let gpu = pollster::block_on(crate::chain::read_buffer_async(&ctx, &a, a.size())).unwrap();
    let y: Vec<f32> = input
        .chunks_exact(4)
        .map(|p| {
            LUMA_REC2020[0].mul_add(p[0], LUMA_REC2020[1].mul_add(p[1], LUMA_REC2020[2] * p[2]))
        })
        .collect();
    for i in 0..(w * h) as usize {
        assert_eq!(gpu[i * 2], y[i], "luma {i}");
    }
    for row in 0..=h - 8 {
        for col in 0..=w - 8 {
            let cpu = matching::patch_mean(&matching::extract_patch(
                &y,
                w as usize,
                col as usize,
                row as usize,
            ));
            assert_eq!(
                gpu[((row * w + col) * 2 + 1) as usize],
                cpu,
                "mean {col},{row}"
            );
        }
    }
}

fn fixture(w: u32, h: u32) -> Vec<f32> {
    (0..w * h)
        .flat_map(|i| {
            let y = 0.2 + (i % w) as f32 / w as f32 * 0.4;
            let n = ((i * 7919) % 97) as f32 / 97.0 - 0.5;
            [
                y + 0.15 * n,
                y - 0.08 * n,
                y + 0.4 * n,
                (i % 7) as f32 / 7.0,
            ]
        })
        .collect()
}

#[test]
fn bm3d_gpu_matches_cpu_both_passes_and_clamped_grid() {
    let ctx = GpuContext::new_blocking().expect("BM3D parity requires a GPU");
    for (w, h) in [(8, 8), (13, 15), (23, 19), (39, 37), (79, 73)] {
        for strength in [20.0, 100.0] {
            let input = fixture(w, h);
            let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
                *p = [q[0], q[1], q[2]];
            }
            raw_core::stages::bm3d::apply(&mut cpu, strength, None);
            let image = GpuImage::upload(&ctx, &input, w, h);
            let runner = ChainRunner::new(&ctx, &image);
            let pass = DeepDenoisePass { strength };
            let gpu = runner.run_blocking(&[&pass]);
            let again = runner.run_blocking(&[&pass]);
            assert_eq!(gpu, again, "GPU BM3D must be deterministic");
            let mut worst = 0.0_f32;
            let mut moved = 0.0_f32;
            for (i, (p, q)) in cpu.pixels.iter().zip(gpu.chunks_exact(4)).enumerate() {
                for c in 0..3 {
                    worst = worst.max((p[c] - q[c]).abs());
                    moved = moved.max((p[c] - input[i * 4 + c]).abs());
                }
                assert_eq!(q[3], input[i * 4 + 3]);
            }
            eprintln!("BM3D {w}x{h} s={strength}: worst={worst} effect={moved}");
            assert!(moved > 0.001);
            assert!(worst < 1e-4, "BM3D {w}x{h} s={strength}: {worst}");
        }
    }
}

#[test]
#[ignore = "physical RAW qualification, explicitly provision the fixture"]
fn bm3d_physical_scene_parity() {
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
    let (w, h, input) = render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
        &raw,
        &model,
        RenderQuality::Preview,
        512,
        CancelToken::never(),
    )
    .unwrap();
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
fn bm3d_gpu_noop_and_uniform_fields() {
    let ctx = GpuContext::new_blocking().expect("BM3D parity requires a GPU");
    for (w, h, strength) in [(7, 9, 100.0), (9, 7, 100.0), (16, 19, 0.0)] {
        let input = fixture(w, h);
        let image = GpuImage::upload(&ctx, &input, w, h);
        assert_eq!(
            ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength }]),
            input
        );
    }
    for rgb in [[0.18, 0.18, 0.18, 0.7], [-0.2, 0.4, 2.1, 1.0]] {
        let input = rgb.repeat(17 * 13);
        let image = GpuImage::upload(&ctx, &input, 17, 13);
        let gpu =
            ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass { strength: 100.0 }]);
        for (i, (a, b)) in input.iter().zip(&gpu).enumerate() {
            assert_eq!(a, b, "uniform lane {i} field {rgb:?}");
        }
    }
}

#[test]
#[ignore = "controlled-hardware latency gate; run explicitly in release"]
fn bm3d_resident_latency_gate() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let w: u32 = std::env::var("MAPLE_BM3D_BENCH_EDGE")
        .unwrap_or_else(|_| "512".into())
        .parse()
        .unwrap();
    let h = w * 2 / 3;
    let input = fixture(w, h);
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
