use super::*;

/// #4837: direct Metal/CPU parity, both masking branches, borders, HDR and
/// signed chroma. The step remains visibly sharpened at the preserved default.
#[test]
fn strong_bright_halo_control_matches_cpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (17, 17);
    for exposure in [0.1, 1.0, 10.0] {
        let input: Vec<f32> = (0..w * h)
            .flat_map(|i| {
                let light = if i % w < 8 { 0.3 } else { 2.0 } * exposure;
                [light * -0.1, light, light * 1.2, 0.75]
            })
            .collect();
        for radius in [0.5, 1.0, 3.0] {
            for masking in [0.0, 50.0] {
                let settings = SharpenSettings {
                    width: w,
                    height: h,
                    amount: 40.0,
                    radius,
                    detail: 25.0,
                    masking,
                };
                let default = raw_core_sharpen(&input, w, h, settings);
                for amount in [40.0, 100.0, 150.0] {
                    let settings = SharpenSettings { amount, ..settings };
                    let cpu = raw_core_sharpen(&input, w, h, settings);
                    let gpu = sharpen_gpu(&ctx, &input, w, h, settings);
                    assert!(max_diff_at(&cpu, &gpu).0 < 1e-4);
                    for y in [0, 8, 16] {
                        let i = (y * w as usize + 8) * 4;
                        assert!(gpu[i + 1] <= default[i + 1] + 2e-6 * exposure);
                        assert!(gpu[i + 1] > input[i + 1]);
                        assert!(gpu[i] < 0.0);
                        assert_eq!(gpu[i + 3], 0.75);
                    }
                }
            }
        }
    }
}
