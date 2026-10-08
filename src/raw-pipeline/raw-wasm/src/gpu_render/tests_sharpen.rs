//! #4112 mandatory Metal/lavapipe scene-linear sharpening regression.
//! This stage-level control retains signed/HDR values before the view tail.

use raw_core::image::{ColorSpace, Image};
use raw_gpu::{ChainRunner, GpuContext, GpuImage, SharpenPass};

#[test]
fn high_amount_preserves_positive_light_signed_chroma_and_alpha() {
    if !super::tests::gpu_available() {
        eprintln!("sharpen undershoot: no GPU adapter — skipping (soft pass)");
        return;
    }
    let ctx = GpuContext::new_blocking().expect("gpu context");
    for exposure in [0.1, 1.0, 10.0] {
        for original in [
            [0.1; 3],
            [0.0002; 3],
            [-0.01, 0.10, 0.05],
            [0.0; 3],
            [-0.1; 3],
        ] {
            for amount in [40.0, 100.0, 150.0] {
                for masking in [0.0, 60.0] {
                    let input: Vec<f32> = (0..81)
                        .flat_map(|i| {
                            let rgb = if i == 40 {
                                original.map(|v| v * exposure)
                            } else {
                                [exposure; 3]
                            };
                            [rgb[0], rgb[1], rgb[2], i as f32 / 100.0]
                        })
                        .collect();
                    let mut reference = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
                    for (px, rgba) in reference.pixels.iter_mut().zip(input.chunks_exact(4)) {
                        *px = [rgba[0], rgba[1], rgba[2]];
                    }
                    raw_core::stages::sharpen::apply(&mut reference, amount, 1.0, 25.0, masking);
                    let image = GpuImage::upload(&ctx, &input, 9, 9);
                    let runner = ChainRunner::new(&ctx, &image);
                    let gpu = runner.run_blocking(&[&SharpenPass {
                        amount,
                        radius: 1.0,
                        detail: 25.0,
                        masking,
                    }]);
                    assert!(gpu.iter().all(|v| v.is_finite()));
                    for (i, rgb) in reference.pixels.iter().enumerate() {
                        for c in 0..3 {
                            let diff = (rgb[c] - gpu[i * 4 + c]).abs();
                            assert!(diff < 1e-4, "exposure={exposure}, original={original:?}, masking={masking}, pixel={i}, channel={c}, diff={diff}");
                        }
                        assert_eq!(gpu[i * 4 + 3], input[i * 4 + 3]);
                    }
                    if original == [0.1; 3] {
                        assert!(gpu[160..163].iter().all(|v| *v > 0.0));
                        assert!(gpu[160] < input[160]);
                        let mix = amount / 100.0;
                        let minimum_gain = if mix <= 0.4 {
                            1.0 - mix
                        } else {
                            0.36 / (0.6 + (mix - 0.4))
                        };
                        let minimum = input[160] * minimum_gain;
                        assert!(
                            gpu[160] >= minimum - 1e-7,
                            "unbounded darkening: amount={amount}, input={}, output={}",
                            input[160],
                            gpu[160]
                        );
                    } else if original == [0.0002; 3] {
                        assert!(gpu[160..163].iter().all(|v| *v > 0.0));
                        if input[160] <= 1e-4 {
                            assert_eq!(&gpu[160..163], &input[160..163]);
                        } else {
                            assert!(gpu[160] < input[160]);
                        }
                    } else if original == [-0.01, 0.10, 0.05] {
                        assert!(gpu[160] < 0.0 && gpu[161] > 0.0 && gpu[162] > 0.0);
                    } else {
                        assert_eq!(&gpu[160..163], &input[160..163]);
                    }
                }
            }
        }
    }
}
