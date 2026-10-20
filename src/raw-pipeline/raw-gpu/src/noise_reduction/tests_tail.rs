//! GPU proof that small absolute Gaussian weights remain effective after normalization.
use super::*;

#[test]
fn normalized_gaussian_tail_denoises_the_impulse_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let (w, h) = (17usize, 17usize);
    let background = 0.02_f32;
    let center = 0.14_f32;
    let delta = center - background;
    let mut plane = vec![background; w * h];
    let i = 8 * w + 8;
    plane[i] = center;
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 1,
        h: (2.0 * delta * delta / (25.0 * 8.125)).sqrt(),
    };
    let gpu = denoise_plane_gpu(
        &ctx,
        &plane,
        &plane,
        w as u32,
        h as u32,
        params,
        NoiseModulation::from_profile(None, 100, false),
    );
    let expected = (8.0 * background + center) / 9.0;
    assert!((gpu[i] - expected).abs() < 2e-6, "{} != {expected}", gpu[i]);
    let cpu = raw_core_denoise_plane(&plane, w, h, params);
    assert!((gpu[i] - cpu[i]).abs() < 1e-5);
}
