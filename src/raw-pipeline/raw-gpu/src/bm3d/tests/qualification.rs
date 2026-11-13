use super::*;

/// The second pass ranks candidates on the first-pass estimate, whose
/// transforms and divisions cannot be bit-exact across CPU, Metal and Vulkan,
/// so a near tie there may legitimately flip a group. The gate therefore pins
/// first-pass groups to the CPU, second-pass groups to the GPU's own guide,
/// and bounds the output by its mean and 99.9th-percentile error.
#[test]
#[ignore = "physical RAW qualification, explicitly provision the fixture"]
fn bm3d_physical_scene_parity() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    for edge in [2560, 1536] {
        let (w, h, input) = physical_input(edge);
        let mut cpu = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (p, q) in cpu.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *p = [q[0], q[1], q[2]];
        }
        raw_core::stages::bm3d::apply(&mut cpu, 50.0, None);
        let image = GpuImage::upload(&ctx, &input, w, h);
        CAPTURE.with_borrow_mut(|v| *v = Some(Vec::new()));
        let gpu = ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
            strength: 50.0,
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
        let sigma = SIGMA_K * 0.5 * (sample[sample.len() / 2].max(0.0) + ANCHOR_PEDESTAL);
        assert_eq!(values[0][0].to_bits(), sigma.to_bits(), "{edge}px sigma");
        let tau = T_MATCH_SQ * sigma * sigma;
        let gpu_guide: Vec<f32> = values[1].chunks_exact(4).map(|p| p[0]).collect();
        for (pass, guide) in [(0, &noisy[0]), (1, &gpu_guide)] {
            let mut g = 0;
            for y in matching::ref_coords(h as usize) {
                for x in matching::ref_coords(w as usize) {
                    let expected = matching::find_group(guide, w as usize, h as usize, x, y, tau);
                    let actual = captured_group(&values[pass * 2], w, g);
                    assert_eq!(actual, expected, "{edge}px pass={pass} ref={x},{y}");
                    g += 1;
                }
            }
        }
        let mut errors: Vec<f32> = cpu
            .pixels
            .iter()
            .zip(gpu.chunks_exact(4))
            .flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs() / p[c].abs().max(1.0)))
            .collect();
        errors.sort_unstable_by(f32::total_cmp);
        let mean = errors.iter().map(|e| f64::from(*e)).sum::<f64>() / errors.len() as f64;
        let p999 = errors[errors.len() * 999 / 1000];
        let max = errors[errors.len() - 1];
        eprintln!(
            "BM3D physical test_0007 {w}x{h}: mean relative={mean:e} p99.9={p999:e} max={max:e}"
        );
        assert!(mean <= 1e-6, "{edge}px mean relative error {mean}");
        assert!(p999 <= 1e-4, "{edge}px p99.9 relative error {p999}");
        assert!(max <= 1e-2, "{edge}px max relative error {max}");
    }
}

/// Force both cache axes to split, and independently exercise the portable
/// implementation even on a native adapter with subgroup acceleration.
#[test]
fn bm3d_tiled_portable_and_native_match_cpu() {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            subgroups::FORCE_PORTABLE.with(|flag| flag.set(false));
        }
    }
    let _reset = Reset;
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
        ctx.set_bm3d_binding_cap(1 << 20);
        let workspace =
            cached::Workspace::new(&ctx, w, h, (w - 8).div_ceil(6) + 1, (h - 8).div_ceil(6) + 1);
        assert!(workspace.is_tiled_for_test((w - 8).div_ceil(6) + 1, (h - 8).div_ceil(6) + 1));
        if portable {
            assert_eq!(ctx.bm3d_pipelines().subgroup_width, None);
        }
        let image = GpuImage::upload(&ctx, &input, w, h);
        let result = ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
            strength: 50.0,
            cancel: None,
        }]);
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
        let result = ChainRunner::new(&ctx, &image).run_blocking(&[&DeepDenoisePass {
            strength: 50.0,
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
        let sigma = SIGMA_K * 0.5 * (sample[sample.len() / 2].max(0.0) + ANCHOR_PEDESTAL);
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
        let mut moved = false;
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
                moved |= actual[c] != original[c];
            }
        }
        eprintln!("BM3D signed HDR scale={scale} offset={offset}: max relative={worst}");
        assert!(worst < 1e-4, "signed HDR BM3D: {worst}");
        assert!(moved, "a negative median switched GPU BM3D off");
    }
}

pub(super) fn physical_input(edge: u32) -> (u32, u32, Vec<f32>) {
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
