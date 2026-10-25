use super::*;
use crate::{chain::ChainRunner, image::GpuImage};
use raw_core::image::{ColorSpace, Image};

#[path = "../../../raw-core/src/stages/bm3d/exact.rs"]
mod exact;
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
    ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
        strength: 20.0,
        cancel: None,
    }]);
    let captures = CAPTURE.with_borrow_mut(|v| v.take().unwrap());
    let values: Vec<Vec<f32>> = captures
        .iter()
        .map(|(_, b)| {
            pollster::block_on(crate::chain::read_buffer_async(&ctx, b, b.size())).unwrap()
        })
        .collect();
    let noisy = opponent_planes(&input);
    let mut sample: Vec<f32> = noisy[0].iter().step_by(8).copied().collect();
    sample.sort_unstable_by(f32::total_cmp);
    let sigma = SIGMA_K * 0.2 * (sample[sample.len() / 2].max(0.0) + ANCHOR_PEDESTAL);
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
        let mut g = 0;
        for y in matching::ref_coords(h as usize) {
            for x in matching::ref_coords(w as usize) {
                let expected = matching::find_group(guide, w as usize, h as usize, x, y, tau);
                let actual = captured_group(&values[phase * 2], w, g);
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
        .map(|p| exact::luminance([p[0], p[1], p[2]]))
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

#[test]
fn bm3d_transpose_matches_indexed_basis() {
    use bytemuck::Zeroable;
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let source = format!(
        "{}\n{}\n{}",
        include_str!("common.wgsl"),
        format!(
            "{}\n{}",
            include_str!("basis_uniform.wgsl"),
            include_str!("filter_helpers.wgsl")
        ),
        r#"
        @group(0) @binding(1) var<storage,read_write> output:array<vec4<f32>>;
        @compute @workgroup_size(256) fn main(@builtin(local_invocation_index) lane:u32) {
            let member=lane%16u;let block=lane/16u;
            let v=vec4<f32>(f32(block),f32(block+16u),f32(block+32u),f32(block+48u))+vec4<f32>(f32(member*1000u));
            output[lane]=inverse_vertical_transpose(v,lane);
        }
    "#
    );
    let pipeline =
        crate::context_pipelines_helpers::compile_source(&ctx.device, "transpose-proof", &source);
    let mut params = Params::zeroed();
    params.basis = std::array::from_fn(|i| {
        std::array::from_fn(|j| if i / 2 == i % 2 * 4 + j { 1.0 } else { 0.0 })
    });
    let output = GpuImage::upload(&ctx, &vec![0.0; 256 * 4], 256, 1);
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    spatial::encode_simple(
        &ctx,
        &mut encoder,
        &pipeline,
        bytemuck::bytes_of(&params),
        &[&output.buffer],
        64,
        "transpose-proof",
    );
    ctx.queue.submit(Some(encoder.finish()));
    let gpu = output.read_back_blocking(&ctx);
    for lane in 0..256usize {
        for q in 0..4usize {
            let expected = ((lane % 64) + (lane / 64 + q * 4) * 1000) as f32;
            assert_eq!(gpu[lane * 4 + q], expected, "lane={lane} component={q}");
        }
    }
}

fn opponent_planes(input: &[f32]) -> [Vec<f32>; 3] {
    std::array::from_fn(|c| {
        input
            .chunks_exact(4)
            .map(|p| {
                let y = exact::luminance([p[0], p[1], p[2]]);
                [y, p[0] - y, p[2] - y][c]
            })
            .collect()
    })
}

fn captured_group(groups: &[f32], width: u32, g: usize) -> Vec<(usize, usize)> {
    let pitch = width.next_power_of_two();
    let start = 4 + g * (GROUP_MAX + 1);
    let count = groups[start].to_bits() as usize;
    groups[start + 1..start + 1 + count]
        .iter()
        .map(|v| {
            let bits = v.to_bits();
            (
                (bits & (pitch - 1)) as usize,
                (bits >> pitch.trailing_zeros()) as usize,
            )
        })
        .collect()
}

pub(super) fn fixture(w: u32, h: u32) -> Vec<f32> {
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
            let pass = DeepDenoisePass {
                strength,
                cancel: None,
            };
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
fn bm3d_gpu_noop_and_uniform_fields() {
    let ctx = GpuContext::new_blocking().expect("BM3D parity requires a GPU");
    for (w, h, strength) in [(7, 9, 100.0), (9, 7, 100.0), (16, 19, 0.0)] {
        let input = fixture(w, h);
        let image = GpuImage::upload(&ctx, &input, w, h);
        assert_eq!(
            ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
                strength,
                cancel: None
            }]),
            input
        );
    }
    for rgb in [[0.18, 0.18, 0.18, 0.7], [-0.2, 0.4, 2.1, 1.0]] {
        let input = rgb.repeat(17 * 13);
        let image = GpuImage::upload(&ctx, &input, 17, 13);
        let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
            strength: 100.0,
            cancel: None,
        }]);
        for (i, (a, b)) in input.iter().zip(&gpu).enumerate() {
            assert_eq!(a, b, "uniform lane {i} field {rgb:?}");
        }
    }
}

#[path = "tests/cancellation.rs"]
mod cancellation;
#[path = "tests/latency.rs"]
mod latency;
#[path = "tests/qualification.rs"]
mod qualification;
