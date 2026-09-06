//! Tile halos, partial workgroups and profile gates against the real CPU oracle.
use super::*;

fn tiled_parity(profile: Option<&[f32]>) {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let mut changed = 0;
    for (width, height) in [
        (1, 1),
        (3, 7),
        (7, 3),
        (9, 17),
        (17, 9),
        (31, 23),
        (257, 17),
    ] {
        let plane: Vec<f32> = (0..width * height)
            .map(|i| {
                let (x, y) = (i % width, i / width);
                let edge = if (x / 8 + y / 8) % 2 == 0 { 0.0 } else { 0.07 };
                0.1 + edge + 0.003 * ((x * 7 + y * 13) % 5) as f32
            })
            .collect();
        // Distinct from chroma: exercises per-pixel radii 1, 2 and 3 across tiles.
        let guide: Vec<f32> = (0..plane.len()).map(|i| (i % 19) as f32 / 5.0).collect();
        let params = chroma_params(25.0);
        let reference = raw_core::stages::nlm::denoise_plane_cancellable(
            &plane,
            width,
            height,
            raw_core::stages::nlm::NlmParams {
                patch_radius: params.patch_radius,
                search_radius: params.search_radius,
                h: params.h,
            },
            raw_core::cancel::CancelToken::never(),
            &guide,
            profile,
            100,
            true,
        );
        let gpu = denoise_plane_gpu(
            &ctx,
            &plane,
            &guide,
            width as u32,
            height as u32,
            params,
            NoiseModulation::from_profile(profile, 100, true),
        );
        assert!(gpu.iter().all(|value| value.is_finite()));
        let (error, index) = max_diff_at(&reference, &gpu);
        assert!(error < 1e-4, "{width}×{height}: {error} at {index}");
        changed += reference
            .iter()
            .zip(&plane)
            .filter(|(a, b)| (*a - *b).abs() > 1e-5)
            .count();
        for y in 0..height {
            for x in 0..width {
                if x < 2 || y < 2 || x + 2 >= width || y + 2 >= height {
                    assert!((gpu[y * width + x] - plane[y * width + x]).abs() < 1e-6);
                }
            }
        }
    }
    assert!(
        changed > 100,
        "the oracle must actually denoise these tiles"
    );
}

#[test]
fn tiled_partial_workgroups_and_halos_match_cpu() {
    tiled_parity(None);
}

#[test]
fn tiled_partial_workgroups_preserve_profile_radius_gates() {
    tiled_parity(Some(&[0.000003, 0.000000001]));
}

#[test]
fn tiled_weight_lookup_preserves_interpolation_and_cutoff() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (width, height) = (19, 17);
    let params = chroma_params(25.0);
    let center = 8 * width + 8;
    // Odd shifts compare constant differences across the full patch, making
    // SSD/(h²·area) land on both sides of interpolation knots and the x=8 cutoff.
    for energy in [0.001f32, 0.015624, 0.015626, 3.999, 4.001, 7.999, 8.001] {
        let amplitude = params.h * energy.sqrt();
        let plane: Vec<f32> = (0..width * height)
            .map(|i| 0.1 + if i % width % 2 == 0 { 0.0 } else { amplitude })
            .collect();
        let reference = raw_core_denoise_plane(&plane, width, height, params);
        let gpu = denoise_plane_gpu(
            &ctx,
            &plane,
            &plane,
            width as u32,
            height as u32,
            params,
            NoiseModulation::default(),
        );
        let (error, index) = max_diff_at(&reference, &gpu);
        assert!(error < 1e-7, "energy={energy}: {error} at {index}");
        if energy < 8.0 {
            assert!(reference[center] - plane[center] > 1e-6);
        } else {
            assert!((gpu[center] - plane[center]).abs() < 1e-7);
        }
    }
}
