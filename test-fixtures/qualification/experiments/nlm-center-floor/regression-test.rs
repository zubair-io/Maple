// All eight noncentral patch distances are equal, so their Gaussian weights
// and the maximum-neighbor center weight are equal. Their absolute magnitude
// cancels: the normalized center must be 1/9, for any finite equal weights.
#[test]
fn equal_tiny_gaussian_weights_keep_the_normalized_nine_sample_mean() {
    use super::{denoise_plane, NlmParams};
    let mut plane = vec![0.0_f32; 9];
    plane[4] = 1.0;
    let expected = (1.0_f64 / 9.0) as f32;
    for squared_distance_over_h2 in [8.0_f32, 16.0, 32.0, 64.0] {
        let params = NlmParams {
            patch_radius: 0,
            search_radius: 1,
            h: squared_distance_over_h2.sqrt().recip(),
        };
        let actual = denoise_plane(&plane, 3, 3, params)[4];
        assert!((actual - expected).abs() <= 5e-6,
            "equal weights at exponent {squared_distance_over_h2}: expected {expected}, got {actual}");
    }
}
