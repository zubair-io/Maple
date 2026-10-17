use super::*;
use raw_gpu::{Bm3dPass, ChainRunner, GpuContext, GpuImage};

fn compare(ctx: &GpuContext, image: &Image, strength: f32, identity: bool) {
    let mut expected = image.clone();
    apply(&mut expected, strength, None);
    let rgba: Vec<_> = image
        .pixels
        .iter()
        .enumerate()
        .flat_map(|(i, p)| [p[0], p[1], p[2], (i % 19) as f32 / 19.])
        .collect();
    let source = GpuImage::upload(ctx, &rgba, image.width, image.height);
    let runner = ChainRunner::new(ctx, &source);
    let actual = runner.run_blocking(&[&Bm3dPass { strength }]);
    assert_eq!(runner.last_readback_count(), 1);
    let mut maximum = 0f32;
    for (i, p) in actual.chunks_exact(4).enumerate() {
        assert_eq!(p[3].to_bits(), rgba[i * 4 + 3].to_bits());
        for ch in 0..3 {
            let error = (p[ch] - expected.pixels[i][ch]).abs();
            maximum = maximum.max(error);
            assert!(
                error <= 1e-4,
                "{}x{} strength{strength} pixel{i} ch{ch}: {} vs {} error{error}",
                image.width,
                image.height,
                p[ch],
                expected.pixels[i][ch]
            );
            if identity {
                assert_eq!(p[ch].to_bits(), image.pixels[i][ch].to_bits());
            }
        }
    }
    assert_eq!(source.read_back_blocking(ctx), rgba);
    eprintln!(
        "BM3D RGB {}x{} strength{strength}: {} channels max={maximum}",
        image.width,
        image.height,
        image.pixels.len() * 3
    );
}

#[test]
fn full_rgb_stage_matches_cpu_for_uniform_noise_edges_hdr_and_skip_cases() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for (w, h) in [(7, 13), (8, 8), (9, 12), (23, 19), (41, 35)] {
        for kind in 0..4 {
            let mut image = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for (i, pixel) in image.pixels.iter_mut().enumerate() {
                *pixel = std::array::from_fn(|ch| {
                    let base = [0.18, -0.03, 0.7][ch];
                    match kind {
                        0 => base,
                        1 => {
                            base + (i % w as usize) as f32 * 0.02 - (i / w as usize) as f32 * 0.015
                        }
                        2 => base + ((i * 31 + ch * 17) % 127) as f32 / 1000.,
                        _ => {
                            base + if i % w as usize > w as usize / 2 {
                                3.
                            } else {
                                -0.2
                            }
                        }
                    }
                });
            }
            for strength in [0., 0.001, 1., 25., 100., 150.] {
                compare(&ctx, &image, strength, kind == 0 || strength == 0. || w < 8);
            }
        }
    }
}

#[test]
fn full_rgb_stage_handles_black_negative_and_bright_noise_anchors() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for base in [0., -0.001, -0.2, 0.000001, 4.] {
        for noisy in [false, true] {
            let mut image = Image::new(23, 19, ColorSpace::SceneLinearRec2020);
            for (i, pixel) in image.pixels.iter_mut().enumerate() {
                *pixel = std::array::from_fn(|ch| {
                    base + if noisy {
                        ((i * 31 + ch * 17) % 127) as f32 / 10000.
                    } else {
                        0.
                    }
                });
            }
            for strength in [1., 25., 100.] {
                compare(&ctx, &image, strength, !noisy);
            }
        }
    }
}

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_full_rgb_denoise_matches_cpu() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    for name in ["test_0006.DNG", "test_0005.RAF"] {
        let path = root.join(name);
        let original = std::fs::read(&path).unwrap();
        let raw =
            crate::decode::decode_bytes(&original, path.extension().unwrap().to_str().unwrap())
                .unwrap();
        for size in [64, 128, 256] {
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
                size,
            )
            .unwrap();
            for strength in [1., 25., 100.] {
                compare(&ctx, &image, strength, false);
            }
        }
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
}
