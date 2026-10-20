//! Gaussian tails remain meaningful after NLM weight normalization.
use super::{accumulate, denoise_plane, fast_neg_exp, NlmParams};

#[test]
fn gaussian_lookup_boundary_retains_positive_tail_weights() {
    for x in [8.0_f32, 8.125, 9.0, 16.0, 32.0, 80.0] {
        let expected = (-x).exp();
        assert_eq!(fast_neg_exp(x).to_bits(), expected.to_bits(), "x={x}");
    }
    let before = fast_neg_exp(f32::from_bits(8.0_f32.to_bits() - 1));
    let at = fast_neg_exp(8.0);
    assert!(before >= at && before - at < 2e-8);
}

#[test]
fn normalized_gaussian_tails_denoise_an_isolated_chroma_impulse() {
    for exposure in [0.5_f32, 1.0, 2.0] {
        let (w, h) = (17, 17);
        let background = 0.02 * exposure;
        let center = 0.14 * exposure;
        let delta = center - background;
        let mut plane = vec![background; w * h];
        let i = 8 * w + 8;
        plane[i] = center;
        let params = NlmParams {
            patch_radius: 2,
            search_radius: 1,
            h: (2.0 * delta * delta / (25.0 * 8.125)).sqrt(),
        };
        let out = denoise_plane(&plane, w, h, params);
        // Every neighboring patch has the same SSD: all eight positive
        // weights and the max-weight center normalize to an equal average.
        let expected = (8.0 * background + center) / 9.0;
        assert!(
            (out[i] - expected).abs() < 2e-6 * exposure,
            "exposure={exposure}: {} != {expected}",
            out[i]
        );
    }
}

#[test]
fn vector_and_scalar_tail_weights_match_the_gaussian() {
    let arguments = [8.0_f32, 8.125, 9.0, 16.0, 32.0, 80.0, 0.0, 7.99, 12.0, 24.0];
    for n in [1, 3, 4, 5, 8, 10] {
        let values: Vec<_> = (0..n).map(|i| 0.01 + i as f32 * 0.013).collect();
        let mut acc = vec![0.0; n];
        let mut weights = vec![0.0; n];
        let mut maxima = vec![0.0; n];
        accumulate::accumulate(
            &arguments[..n],
            &values,
            &mut acc,
            &mut weights,
            &mut maxima,
            1.0,
        );
        for i in 0..n {
            let expected = if arguments[i] < 8.0 {
                fast_neg_exp(arguments[i])
            } else {
                (-arguments[i]).exp()
            };
            assert_eq!(weights[i].to_bits(), expected.to_bits(), "n={n} lane={i}");
            assert_eq!(maxima[i].to_bits(), expected.to_bits());
            assert_eq!(acc[i].to_bits(), (expected * values[i]).to_bits());
        }
    }
}
