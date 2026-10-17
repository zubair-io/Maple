//! Independent local-estimator predictions for mixed-color support (#4628).
use super::*;

#[test]
fn local_witness_color_disagreement_weights_the_ratio() {
    // Half of the local witnesses match the target's surviving R:G=2:1;
    // half belong to a different surface, with R:G=1:30 and much more blue
    // per unit of surviving-channel energy. Averaging all ratios equally
    // imports that unrelated blue into the target.
    let same = [0.3_f32, 0.15, 0.6];
    let other = [0.01_f32, 0.3, 0.9];
    let target = [0.6_f32, 0.3, 1.0];
    let mean_same = (same[0] + same[1]) * 0.5;
    let mean_other = (other[0] + other[1]) * 0.5;
    let mean_target = (target[0] + target[1]) * 0.5;
    let deviation = other[0] / mean_other - target[0] / mean_target;
    let weight_other = (1.0 + 69.4 * deviation * deviation).powi(-2);
    let support = 24.0 + 24.0 * weight_other;
    let ratio =
        (24.0 * same[2] / mean_same + 24.0 * weight_other * other[2] / mean_other) / support;
    let expected = 0.6 + 48.0 / 49.0 * (mean_target * ratio - 0.6);
    let unweighted = 0.6
        + 48.0 / 49.0 * (mean_target * (same[2] / mean_same + other[2] / mean_other) * 0.5 - 0.6);
    assert!(expected < 1.2 && unweighted > 1.8);

    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        for baseline in [-8.0_f32, 0.0, 4.0] {
            let gain = baseline.exp2();
            let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
            image.pixels.fill(order.map(|c| other[c] * gain));
            let mut count = 0;
            for y in 1..8 {
                for x in 1..8 {
                    if (x, y) == (4, 4) {
                        continue;
                    }
                    if count < 24 {
                        image.pixels[y * 9 + x] = order.map(|c| same[c] * gain);
                    }
                    count += 1;
                }
            }
            image.pixels[40] = order.map(|c| target[c] * gain);
            let original = image.pixels.clone();
            apply(
                &mut image,
                HighlightRecoveryMode::ChromaticAdaptation,
                [1.0; 3],
                baseline,
            );
            let clipped = order.iter().position(|&c| c == 2).unwrap();
            assert!((image.pixels[40][clipped] / gain - expected).abs() < 2e-6);
            for (i, (actual, before)) in image.pixels.iter().zip(&original).enumerate() {
                for c in 0..3 {
                    if i != 40 || c != clipped {
                        assert_eq!(actual[c].to_bits(), before[c].to_bits());
                    }
                }
            }
        }
    }
}

#[test]
fn uniform_ratio_support_does_not_collapse_toward_neutral() {
    // Each surround has 48 observations of missing-B / mean(R,G) = 2.
    // Their different surviving R:G ratios give different common weights,
    // which cancel in the normalized fit. Confidence still counts the same
    // 48 observations; it must not manufacture a different blue estimate.
    let target = [0.6_f32, 0.3, 1.0];
    let expected = 0.6 + 48.0 / 49.0 * (0.45 * 2.0 - 0.6);
    for witness in [[0.4, 0.2, 0.6], [0.3, 0.3, 0.6], [0.45, 0.15, 0.6]] {
        let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
        image.pixels.fill(witness);
        image.pixels[40] = target;
        apply(
            &mut image,
            HighlightRecoveryMode::ChromaticAdaptation,
            [1.0; 3],
            0.0,
        );
        assert!((image.pixels[40][2] - expected).abs() < 1e-6);
        assert_eq!(image.pixels[40][..2], target[..2]);
    }
}
