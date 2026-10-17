use super::*;
use raw_gpu::{encode_bm3d_match_row, pool_data_storage, GpuContext};

fn bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_ne_bytes()).collect()
}

fn compare(ctx: &GpuContext, plane: &[f32], width: usize, height: usize, tau_sq: f32) {
    let luma = pool_data_storage(ctx, &bytes(plane), "bm3d-test-luma");
    let threshold = pool_data_storage(ctx, &bytes(&[tau_sq, 0., 0., 0.]), "bm3d-test-threshold");
    let xs = matching::ref_coords(width);
    let ys = matching::ref_coords(height);
    let mut count = 0;
    for ry in ys {
        let mut encoder = ctx.device.create_command_encoder(&Default::default());
        let groups = encode_bm3d_match_row(
            ctx,
            &mut encoder,
            &luma,
            &threshold,
            (width as u32, height as u32),
            ry as u32,
        );
        ctx.queue.submit(Some(encoder.finish()));
        assert_eq!(groups.columns as usize, xs.len());
        let actual = groups.read_back_blocking(ctx);
        for (a, rx) in actual.iter().zip(&xs) {
            let expected = matching::find_group(plane, width, height, *rx, ry, tau_sq);
            let positions: Vec<_> = a.positions[..a.count as usize]
                .iter()
                .map(|p| (p[0] as usize, p[1] as usize))
                .collect();
            assert_eq!(
                positions, expected,
                "{width}x{height} at {rx}/{ry}, threshold {tau_sq}"
            );
            count += 1;
        }
    }
    eprintln!("BM3D matching {width}x{height}, threshold {tau_sq}: {count} exact groups");
}

#[test]
fn gpu_matches_cpu_groups_at_borders_and_preserves_tie_order() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h) in [(8, 8), (9, 12), (17, 23), (32, 25)] {
        for kind in 0..4 {
            let plane: Vec<f32> = (0..w * h)
                .map(|i| match kind {
                    0 => 0.18,
                    1 => ((i % w) as f32 * 0.03) + ((i / w) as f32 * 0.02),
                    2 => ((i % w + i / w) % 2) as f32 * 0.3,
                    _ => ((i * 31) % 127) as f32 / 31. - 0.2,
                })
                .collect();
            for tau_sq in [0., 1e-5, 0.001, 0.1, f32::INFINITY] {
                compare(&ctx, &plane, w, h, tau_sq);
            }
        }
    }
}

#[test]
fn gpu_matches_cpu_at_exact_thresholds_and_on_signed_hdr_noise() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let (width, height) = (41, 35);
    for seed in [0u32, 17, 12345] {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| {
                let bits = (i as u32 ^ seed)
                    .wrapping_mul(747796405)
                    .wrapping_add(2891336453);
                (bits ^ (bits >> 17)) as f32 / u32::MAX as f32 * 16. - 4.
            })
            .collect();
        let reference = matching::extract_patch(&plane, width, 0, 0);
        let candidate = matching::extract_patch(&plane, width, 1, 0);
        let a = matching::patch_mean(&reference);
        let b = matching::patch_mean(&candidate);
        let threshold = reference.iter().zip(candidate).fold(0f32, |sum, (x, y)| {
            let delta = (x - a) - (y - b);
            sum + delta * delta
        }) / (BLOCK * BLOCK) as f32;
        // Exercise the exact comparison boundary and each adjacent f32.
        for tau in [
            0.,
            f32::from_bits(threshold.to_bits() - 1),
            threshold,
            f32::from_bits(threshold.to_bits() + 1),
            f32::INFINITY,
        ] {
            compare(&ctx, &plane, width, height, tau);
        }
    }
}

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_luma_matches_cpu_groups() {
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
        let mut samples: Vec<_> = y.iter().step_by(8).copied().collect();
        samples.sort_unstable_by(f32::total_cmp);
        let anchor = samples[samples.len() / 2] + ANCHOR_PEDESTAL;
        for strength in [1., 25., 100.] {
            let sigma = SIGMA_K * (strength / 100.) * anchor;
            compare(
                &ctx,
                &y,
                image.width as usize,
                image.height as usize,
                T_MATCH_SQ * sigma * sigma,
            );
        }
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
}
