//! Conservative smoothing of the Auto1 residual field (#4636).

/// Exchange residuals between supported neighbours without changing the
/// sample-weighted correction or diffusing away the confidence feather.
/// Exchange the unfeathered residual with mass = count × confidence, then
/// restore confidence. Equal/opposite flux preserves sum(count × delta).
pub(super) fn smooth_final_residual(
    delta: &mut [[f32; 3]],
    counts: &[u32],
    confidence: &[f32],
    n: usize,
) {
    let mut next = delta.to_vec();
    for stride in [1, n, n * n] {
        for i in 0..delta.len() {
            if counts[i] == 0 || confidence[i] == 0.0 {
                continue;
            }
            let coordinate = (i / stride) % n;
            next[i] = delta[i];
            for neighbour in [
                (coordinate > 0).then(|| i - stride),
                (coordinate + 1 < n).then(|| i + stride),
            ]
            .into_iter()
            .flatten()
            {
                if counts[neighbour] == 0 || confidence[neighbour] == 0.0 {
                    continue;
                }
                let mass = counts[i] as f32 * confidence[i];
                let neighbour_mass = counts[neighbour] as f32 * confidence[neighbour];
                let weight = 0.25 * mass.min(neighbour_mass) / mass;
                for channel in 0..3 {
                    next[i][channel] += confidence[i]
                        * weight
                        * (delta[neighbour][channel] / confidence[neighbour]
                            - delta[i][channel] / confidence[i]);
                }
            }
        }
        delta.copy_from_slice(&next);
    }
}

#[cfg(test)]
mod final_smoothing_tests {
    use super::smooth_final_residual;

    #[test]
    fn unequal_populations_exchange_equal_correction_mass() {
        let mut values = vec![[0.0; 3]; 8];
        let mut counts = vec![0; 8];
        values[1] = [0.8; 3];
        counts[0] = 1;
        counts[1] = 9;
        smooth_final_residual(&mut values, &counts, &[1.0; 8], 2);
        for channel in 0..3 {
            assert!((values[0][channel] - 0.2).abs() < 1e-6);
            assert!((values[1][channel] - 7.0 / 9.0).abs() < 1e-6);
            assert!((values[0][channel] + 9.0 * values[1][channel] - 7.2).abs() < 1e-6);
        }
        assert!(values[2..].iter().all(|value| *value == [0.0; 3]));
    }

    #[test]
    fn isolated_thin_support_retains_its_signal() {
        let mut values = vec![[0.0; 3]; 125];
        let mut counts = vec![0; 125];
        for coordinate in 0..5 {
            let i = coordinate * 31;
            values[i] = [0.1, -0.2, 0.3];
            counts[i] = coordinate as u32 + 1;
        }
        let expected = values.clone();
        smooth_final_residual(&mut values, &counts, &[1.0; 125], 5);
        assert_eq!(values, expected);
    }

    #[test]
    fn constant_correction_keeps_the_existing_confidence_feather() {
        let mut values = vec![[0.0; 3]; 27];
        let mut counts = vec![0; 27];
        let mut confidence = vec![0.0; 27];
        for (i, weight) in [1.0, 0.5, 0.1].into_iter().enumerate() {
            confidence[i] = weight;
            counts[i] = (i as u32 + 1).pow(2);
            values[i] = [0.2 * weight, -0.3 * weight, 0.4 * weight];
        }
        let before = values.clone();
        smooth_final_residual(&mut values, &counts, &confidence, 3);
        for (actual, expected) in values.iter().zip(&before) {
            for channel in 0..3 {
                assert!((actual[channel] - expected[channel]).abs() < 1e-7);
            }
        }
    }

    #[test]
    fn varying_confidence_preserves_sample_weighted_correction() {
        let counts: Vec<u32> = (0..125).map(|i| (i * 7 % 13) as u32).collect();
        let confidence: Vec<f32> = (0..125).map(|i| (i * 3 % 11) as f32 / 10.0).collect();
        let mut values: Vec<[f32; 3]> = (0..125)
            .map(|i| {
                if counts[i] == 0 {
                    [0.0; 3]
                } else {
                    [
                        confidence[i] * i as f32 / 124.0,
                        confidence[i] * -0.5,
                        confidence[i] * (i % 11) as f32 / 10.0,
                    ]
                }
            })
            .collect();
        let before = values.clone();
        smooth_final_residual(&mut values, &counts, &confidence, 5);
        for channel in 0..3 {
            let mass = |v: &[[f32; 3]]| {
                v.iter()
                    .zip(&counts)
                    .map(|(p, n)| p[channel] as f64 * *n as f64)
                    .sum::<f64>()
            };
            assert!((mass(&before) - mass(&values)).abs() < 1e-4);
        }
        for (i, value) in values.iter().enumerate() {
            if counts[i] == 0 || confidence[i] == 0.0 {
                assert_eq!(*value, [0.0; 3]);
            } else {
                assert!((-1e-7..=1.0000001).contains(&(value[0] / confidence[i])));
                assert!((value[1] / confidence[i] + 0.5).abs() < 1e-7);
                assert!((-1e-7..=1.0000001).contains(&(value[2] / confidence[i])));
            }
        }
    }

    #[test]
    fn all_axes_preserve_weighted_mean_and_component_bounds() {
        let counts: Vec<u32> = (0..125).map(|i| (i * 7 % 13) as u32).collect();
        let mut values: Vec<[f32; 3]> = (0..125)
            .map(|i| {
                if counts[i] == 0 {
                    [0.0; 3]
                } else {
                    [i as f32 / 124.0, -0.5, (i % 11) as f32 / 10.0]
                }
            })
            .collect();
        let before = values.clone();
        smooth_final_residual(&mut values, &counts, &[1.0; 125], 5);
        for channel in 0..3 {
            let mass = |v: &[[f32; 3]]| {
                v.iter()
                    .zip(&counts)
                    .map(|(p, n)| p[channel] as f64 * *n as f64)
                    .sum::<f64>()
            };
            assert!((mass(&before) - mass(&values)).abs() < 1e-4);
        }
        for (i, value) in values.iter().enumerate() {
            if counts[i] == 0 {
                assert_eq!(*value, [0.0; 3]);
            } else {
                assert!((0.0..=1.0).contains(&value[0]));
                assert_eq!(value[1], -0.5);
                assert!((0.0..=1.0).contains(&value[2]));
            }
        }
    }
}
