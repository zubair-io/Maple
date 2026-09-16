use super::*;

fn recover(img: &mut Image, neutral: [f32; 3], baseline: f32) {
    apply(
        img,
        HighlightRecoveryMode::ChromaticAdaptation,
        neutral,
        baseline,
    );
}

fn mixed_field() -> Image {
    let mut image = Image::new(13, 13, ColorSpace::CameraNativeLinearRgb);
    for (i, pixel) in image.pixels.iter_mut().enumerate() {
        let (x, y) = ((i % 13) as f32, (i / 13) as f32);
        *pixel = [0.15 + x * 0.03, 0.12 + y * 0.025, 0.3 + (x - y) * 0.01];
    }
    for (i, pixel) in [
        (5 * 13 + 5, [2.1, 0.2, 0.6]),
        (5 * 13 + 6, [0.4, 1.0, 0.5]),
        (6 * 13 + 5, [0.3, 0.5, 1.3]),
        (6 * 13 + 6, [2.1, 1.1, 0.4]),
        (6 * 13 + 7, [2.1, 0.3, 1.3]),
        (7 * 13 + 6, [0.4, 1.1, 1.3]),
        (7 * 13 + 7, [2.1, 1.1, 1.3]),
    ] {
        image.pixels[i] = pixel;
    }
    image
}

#[test]
fn every_partial_mask_uses_the_same_known_energy_for_target_and_witnesses() {
    for mask in 1u8..7 {
        let truth: [f32; 3] = std::array::from_fn(|c| {
            if mask & (1 << c) != 0 {
                1.6 + c as f32 * 0.2
            } else {
                0.3 + c as f32 * 0.1
            }
        });
        let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
        image.pixels.fill(truth.map(|v| v * 0.1));
        let center = 4 * 9 + 4;
        let observed = truth.map(|v| v.min(1.0));
        image.pixels[center] = observed;
        recover(&mut image, [1.0; 3], 0.0);
        let known_mean = (0..3)
            .filter(|c| mask & (1 << c) == 0)
            .map(|c| truth[c])
            .sum::<f32>()
            / (3 - mask.count_ones()) as f32;
        for c in 0..3 {
            if mask & (1 << c) == 0 {
                assert_eq!(image.pixels[center][c].to_bits(), observed[c].to_bits());
            } else {
                let expected = known_mean + (48.0 / 49.0) * (truth[c] - known_mean);
                assert!((image.pixels[center][c] - expected).abs() < 2e-6);
                assert!(
                    image.pixels[center][c] > 1.0,
                    "scene range must remain unbounded"
                );
            }
        }
    }
}

#[test]
fn channel_permutation_does_not_change_the_estimate() {
    let input = mixed_field();
    let neutral = [0.5, 1.0, 0.8];
    let mut reference = input.clone();
    recover(&mut reference, neutral, 0.0);
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let mut image = input.clone();
        for pixel in &mut image.pixels {
            *pixel = order.map(|c| pixel[c]);
        }
        recover(&mut image, order.map(|c| neutral[c]), 0.0);
        for (actual, expected) in image.pixels.iter().zip(&reference.pixels) {
            assert_eq!(
                actual.map(f32::to_bits),
                order.map(|c| expected[c].to_bits())
            );
        }
    }
}

#[test]
fn baseline_gain_preserves_reconstruction_including_witness_selection() {
    let input = mixed_field();
    let neutral = [0.5, 1.0, 0.8];
    let mut reference = input.clone();
    recover(&mut reference, neutral, 0.0);
    for baseline in [-16.0_f32, -8.0, 4.0] {
        let gain = baseline.exp2();
        let mut image = input.clone();
        for pixel in &mut image.pixels {
            *pixel = pixel.map(|v| v * gain);
        }
        recover(&mut image, neutral, baseline);
        for (actual, expected) in image.pixels.iter().zip(&reference.pixels) {
            assert_eq!(
                actual.map(|v| (v / gain).to_bits()),
                expected.map(f32::to_bits)
            );
        }
    }
}

#[test]
fn nonpositive_or_cancelling_known_energy_leaves_the_target_untouched() {
    for center in [
        [1.0, 0.0, 0.0],
        [1.0, -0.3, -0.2],
        [1.0, 0.4, -0.4],
        [1.0, 1e-5, 0.0],
    ] {
        for order in [[0, 1, 2], [1, 0, 2], [2, 1, 0]] {
            let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
            image.pixels.fill([0.4; 3]);
            let observed = order.map(|c| center[c]);
            image.pixels[4 * 9 + 4] = observed;
            recover(&mut image, [1.0; 3], 0.0);
            assert_eq!(image.pixels[4 * 9 + 4], observed);
        }
    }
}

#[test]
fn either_known_channel_can_supply_energy_across_a_dark_edge() {
    for green in [-0.1, 0.0, 1e-5, 2e-4, 0.25] {
        for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [2, 1, 0]] {
            let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
            image.pixels.fill(order.map(|c| [0.5, 0.25, 0.5][c]));
            let observed = order.map(|c| [1.0, green, 0.5][c]);
            image.pixels[4 * 9 + 4] = observed;
            recover(&mut image, [1.0; 3], 0.0);
            let clipped = order.iter().position(|c| *c == 0).unwrap();
            let expected = (green + 0.5) / 2.0 * (1.0 + 48.0 / 49.0 * (4.0 / 3.0 - 1.0));
            assert!((image.pixels[4 * 9 + 4][clipped] - expected).abs() < 1e-6);
            assert!(image.pixels[4 * 9 + 4][clipped] > 0.0);
            for c in 0..3 {
                if c != clipped {
                    assert_eq!(image.pixels[4 * 9 + 4][c], observed[c]);
                }
            }
        }
    }
}

#[test]
fn negative_witnesses_do_not_turn_a_positive_saturated_channel_negative() {
    for baseline in [-8.0_f32, 0.0, 4.0] {
        let gain = baseline.exp2();
        for order in [[0, 1, 2], [1, 0, 2], [0, 2, 1]] {
            let mut image = Image::new(9, 9, ColorSpace::CameraNativeLinearRgb);
            let witness = order.map(|c| [0.4, -0.4, 0.4][c] * gain);
            image.pixels.fill(witness);
            let center = 4 * 9 + 4;
            image.pixels[center] = order.map(|c| [0.5, 1.0, 0.5][c] * gain);
            recover(&mut image, [1.0; 3], baseline);
            assert_eq!(image.pixels[center], [0.5 * gain; 3]);
            for (index, pixel) in image.pixels.iter().enumerate() {
                if index != center {
                    assert_eq!(*pixel, witness);
                }
            }
        }
    }
}
