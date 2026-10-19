//! A local witness's surviving channels identify whether its missing-channel
//! ratio belongs to the target surface. Spatial proximity alone is insufficient.
use super::*;

#[test]
fn local_recovery_downweights_foreign_hue_without_changing_known_channels() {
    for permutation in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        for baseline in [-3.0_f32, 0.0, 2.0] {
            let gain = baseline.exp2();
            let permute = |p: [f32; 3]| permutation.map(|c| p[c] * gain);
            let mut image = Image::new(11, 11, ColorSpace::CameraNativeLinearRgb);
            for (i, p) in image.pixels.iter_mut().enumerate() {
                // The upper surface's R/G differs from the target. Its high
                // B/known-energy ratio must not paint the target blue.
                *p = permute(if i / 11 < 5 {
                    [0.1, 0.4, 0.8]
                } else {
                    [0.45, 0.3, 0.6]
                });
            }
            let index = 5 * 11 + 5;
            image.pixels[index] = permute([0.9, 0.6, 1.0]);
            let before = image.pixels.clone();
            apply(
                &mut image,
                HighlightRecoveryMode::ChromaticAdaptation,
                [1.0; 3],
                baseline,
            );
            let clipped = permutation.iter().position(|&c| c == 2).unwrap();
            // Matching donors predict B=1.2; retain the existing 48/49 spatial
            // coverage blend. Foreign-donor influence must remain below 0.001.
            let expected = (0.9 + (48.0 / 49.0) * (1.2 - 0.9)) * gain;
            assert!(
                (image.pixels[index][clipped] - expected).abs() < 0.001 * gain,
                "permutation={permutation:?} BE={baseline}: {:?}, expected near {expected}",
                image.pixels[index]
            );
            for c in 0..3 {
                if c != clipped {
                    assert_eq!(image.pixels[index][c].to_bits(), before[index][c].to_bits());
                }
            }
            for (i, p) in image.pixels.iter().enumerate() {
                if i != index {
                    assert_eq!(*p, before[i], "unclipped donor changed");
                }
            }
            assert!(
                image.pixels[index][clipped] > gain,
                "retain scene-linear headroom"
            );
        }
    }
}
