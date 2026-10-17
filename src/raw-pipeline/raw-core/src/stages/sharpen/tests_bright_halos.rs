use super::*;

/// #4837: amount overdrive must not add a brighter halo than both the
/// observed 3×3 neighborhood and the existing default-strength result.
#[test]
fn strong_sharpening_respects_bright_step_support() {
    for radius in [0.5, 1.0, 3.0] {
        for exposure in [0.1, 1.0, 10.0] {
            for horizontal in [false, true] {
                let mut input = Image::new(17, 17, ColorSpace::SceneLinearRec2020);
                for y in 0..17 {
                    for x in 0..17 {
                        let coordinate = if horizontal { y } else { x };
                        let light = if coordinate < 8 { 0.3 } else { 2.0 } * exposure;
                        input.pixels[y * 17 + x] = [light * -0.1, light, light * 1.2];
                    }
                }
                let mut default = input.clone();
                apply(&mut default, 40.0, radius, 25.0, 0.0);
                for amount in [60.0, 100.0, 150.0] {
                    let mut strong = input.clone();
                    apply(&mut strong, amount, radius, 25.0, 0.0);
                    for edge in [0, 8, 16] {
                        let i = if horizontal {
                            8 * 17 + edge
                        } else {
                            edge * 17 + 8
                        };
                        assert!(strong.pixels[i][1] <= default.pixels[i][1] + 2e-6 * exposure,
                            "unsupported bright halo at amount={amount}, radius={radius}: default={:?}, strong={:?}",
                            default.pixels[i], strong.pixels[i]);
                        assert!(strong.pixels[i][1] > input.pixels[i][1]);
                        assert!(strong.pixels[i][0] < 0.0);
                        assert!((strong.pixels[i][0] / strong.pixels[i][1] + 0.1).abs() < 1e-6);
                        assert!((strong.pixels[i][2] / strong.pixels[i][1] - 1.2).abs() < 1e-6);
                    }
                }
            }
        }
    }
}

#[test]
fn isolated_bright_peak_retains_default_headroom_and_rgb_ratios() {
    for exposure in [0.1, 1.0, 10.0] {
        let mut input = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
        input.pixels.fill([exposure; 3]);
        input.pixels[40] = [2.0 * exposure, 3.0 * exposure, 4.0 * exposure];
        let mut default = input.clone();
        apply(&mut default, 40.0, 1.0, 25.0, 0.0);
        for amount in [60.0, 100.0, 150.0] {
            let mut strong = input.clone();
            apply(&mut strong, amount, 1.0, 25.0, 0.0);
            assert_eq!(strong.pixels[40], default.pixels[40]);
            assert!(strong.pixels[40][2] > input.pixels[40][2]);
            assert!((strong.pixels[40][0] / strong.pixels[40][1] - 2.0 / 3.0).abs() < 1e-6);
        }
    }
}

/// Independent f64 Gaussian and scalar continuation, using a brighter
/// neighbor so the high-amount slider must continue to change the result.
#[test]
fn supported_brightening_is_monotonic_and_matches_scalar_oracle() {
    let mut input = Image::new(9, 9, ColorSpace::SceneLinearRec2020);
    input.pixels.fill([0.1; 3]);
    input.pixels[40] = [1.0; 3];
    input.pixels[41] = [2.0; 3];
    let taps: Vec<f64> = (-3..=3).map(|i| (-0.5 * f64::from(i * i)).exp()).collect();
    let norm = taps.iter().sum::<f64>();
    let blur = taps
        .iter()
        .enumerate()
        .map(|(y, wy)| {
            taps.iter()
                .enumerate()
                .map(|(x, wx)| {
                    wx * wy * f64::from(input.pixels[(y + 1) * 9 + x + 1][0]) / (norm * norm)
                })
                .sum::<f64>()
        })
        .sum::<f64>();
    let delta = 1.0 - blur;
    let anchor = 1.0 + 0.4 * delta;
    let room = 2.0 - anchor;
    assert!(delta > 0.0 && room > 0.0);
    let mut previous = anchor as f32;
    for amount in [60.0, 100.0, 150.0] {
        let mut output = input.clone();
        apply(&mut output, amount, 1.0, 25.0, 0.0);
        let expected = 2.0 - room * room / (room + (f64::from(amount) / 100.0 - 0.4) * delta);
        let actual = output.pixels[40][1];
        assert!((f64::from(actual) - expected).abs() < 2e-6);
        assert!(actual > previous && actual < 2.0);
        previous = actual;
    }
}
