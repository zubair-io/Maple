use super::*;
use raw_gpu::{encode_bm3d_pass, pool_data_storage, GpuContext, GpuImage};

fn packed(planes: &[Vec<f32>; 3]) -> Vec<f32> {
    (0..planes[0].len())
        .flat_map(|i| [planes[0][i], planes[1][i], planes[2][i], 0.37])
        .collect()
}

fn compare(
    ctx: &GpuContext,
    noisy: &[Vec<f32>; 3],
    w: usize,
    h: usize,
    sigmas: [f32; 3],
    tau: f32,
    uniform: bool,
) {
    let basic_cpu = pipeline::run_pass(
        noisy,
        w,
        h,
        sigmas,
        tau,
        pipeline::PassKind::Hard,
        PASS_1,
        None,
        &|| false,
    )
    .unwrap();
    let final_cpu = pipeline::run_pass(
        noisy,
        w,
        h,
        sigmas,
        tau,
        pipeline::PassKind::Wiener { basic: &basic_cpu },
        PASS_2,
        None,
        &|| false,
    )
    .unwrap();
    let source = GpuImage::upload(ctx, &packed(noisy), w as u32, h as u32);
    let basic = GpuImage::upload(ctx, &vec![0.; w * h * 4], w as u32, h as u32);
    let final_image = GpuImage::upload(ctx, &vec![0.; w * h * 4], w as u32, h as u32);
    let values: Vec<u8> = [tau, sigmas[0], sigmas[1], sigmas[2]]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    let parameters = pool_data_storage(ctx, &values, "bm3d-pass-test-parameters");
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encode_bm3d_pass(
        ctx,
        &mut encoder,
        &source.buffer,
        None,
        &parameters,
        &basic.buffer,
        source.dims(),
    );
    encode_bm3d_pass(
        ctx,
        &mut encoder,
        &source.buffer,
        Some(&basic.buffer),
        &parameters,
        &final_image.buffer,
        source.dims(),
    );
    ctx.queue.submit(Some(encoder.finish()));
    for (name, image, expected) in [
        ("hard", &basic, &basic_cpu),
        ("wiener", &final_image, &final_cpu),
    ] {
        let actual = image.read_back_blocking(ctx);
        let mut max_error = 0f32;
        for (i, pixel) in actual.chunks_exact(4).enumerate() {
            assert_eq!(pixel[3].to_bits(), 0.37f32.to_bits());
            for ch in 0..3 {
                let error = (pixel[ch] - expected[ch][i]).abs();
                max_error = max_error.max(error);
                assert!(
                    error <= 1e-4,
                    "{name} {w}x{h} sigma{sigmas:?} at{i} ch{ch}: {} vs {}, error{error}",
                    pixel[ch],
                    expected[ch][i]
                );
                if uniform {
                    assert_eq!(pixel[ch].to_bits(), noisy[ch][i].to_bits());
                }
            }
        }
        eprintln!(
            "BM3D composed {name} {w}x{h}: {} channels max={max_error}",
            w * h * 3
        );
    }
}

#[test]
fn complete_hard_and_wiener_passes_match_cpu_and_preserve_uniform_fields() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h) in [(8, 8), (9, 12), (23, 19), (41, 35)] {
        for kind in 0..3 {
            let noisy = std::array::from_fn(|ch| {
                (0..w * h)
                    .map(|i| {
                        let base = [0.18, -0.03, 0.07][ch];
                        match kind {
                            0 => base,
                            1 => base + (i % w) as f32 * 0.02 - (i / w) as f32 * 0.015,
                            _ => base + ((i * 31 + ch * 17) % 127) as f32 / 31. - 0.2,
                        }
                    })
                    .collect()
            });
            for (sigmas, tau) in [
                ([0.02, 0.036, 0.036], 0.0025),
                ([0.2, 0.36, 0.36], f32::INFINITY),
            ] {
                compare(&ctx, &noisy, w, h, sigmas, tau, kind == 0);
            }
        }
    }
}

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_two_pass_filtering_matches_cpu() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    for name in ["test_0006.DNG", "test_0005.RAF"] {
        let path = root.join(name);
        let original = std::fs::read(&path).unwrap();
        let raw =
            crate::decode::decode_bytes(&original, path.extension().unwrap().to_str().unwrap())
                .unwrap();
        let model = crate::AdjustmentModel {
            auto_exposure: crate::types::adjustment::AutoExposureMode::Off,
            profile: crate::types::adjustment::Profile::Neutral,
            chroma_prefilter: 50.,
            capture_sharpening_amount: 0.,
            ..Default::default()
        };
        let image = crate::pipeline::develop_scene_linear_sized_from_raw_with_quality(
            &raw,
            &model,
            crate::pipeline::RenderQuality::Amaze,
            64,
        )
        .unwrap();
        let y: Vec<_> = image
            .pixels
            .iter()
            .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
            .collect();
        let c1 = image.pixels.iter().zip(&y).map(|(p, v)| p[0] - v).collect();
        let c2 = image.pixels.iter().zip(&y).map(|(p, v)| p[2] - v).collect();
        let mut sample: Vec<_> = y.iter().step_by(8).copied().collect();
        sample.sort_unstable_by(f32::total_cmp);
        let anchor = sample[sample.len() / 2] + ANCHOR_PEDESTAL;
        let noisy = [y, c1, c2];
        for strength in [1., 25., 100.] {
            let sigma = SIGMA_K * (strength / 100.) * anchor;
            compare(
                &ctx,
                &noisy,
                image.width as usize,
                image.height as usize,
                [
                    sigma,
                    CHROMA_SIGMA_RATIO * sigma,
                    CHROMA_SIGMA_RATIO * sigma,
                ],
                T_MATCH_SQ * sigma * sigma,
                false,
            );
        }
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
}
