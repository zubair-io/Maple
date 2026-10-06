use super::*;

// Keep the original serial conversions independent of decode_pair and the
// parallel mapping closures so arithmetic/order drift fails bit-exactly.
fn serial_samples(pairs: &[DisplayPair]) -> (Vec<f32>, Vec<SweepSample>) {
    let inverse = M_REC2020_TO_SRGB.inverse().unwrap();
    let mut luminances = Vec::with_capacity(pairs.len());
    let mut sweep = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let maple_linear = [
            srgb_gamma_inv(pair.maple[0]),
            srgb_gamma_inv(pair.maple[1]),
            srgb_gamma_inv(pair.maple[2]),
        ];
        let maple_rec2020 = inverse.mul_vec(maple_linear);
        let jpeg_linear = [
            srgb_gamma_inv(pair.jpeg[0]),
            srgb_gamma_inv(pair.jpeg[1]),
            srgb_gamma_inv(pair.jpeg[2]),
        ];
        luminances.push(
            0.2627 * maple_rec2020[0] + 0.6780 * maple_rec2020[1] + 0.0593 * maple_rec2020[2],
        );
        sweep.push(SweepSample {
            scene_rec2020: maple_rec2020,
            display_srgb: jpeg_linear,
        });
    }
    (luminances, sweep)
}

#[test]
fn pair_conversions_preserve_original_bits_and_order_across_workers() {
    let pairs: Vec<_> = (0..131_079u32)
        .map(|i| {
            let value =
                |salt| (i.wrapping_mul(1_664_525).wrapping_add(salt) % 65_536) as f32 / 65_535.0;
            DisplayPair {
                maple: match i % 37 {
                    0 => [0.0; 3],
                    1 => [1.0; 3],
                    2 => [0.04045, 0.040449, 0.040451],
                    3 => [1e-7, 0.5, 0.0],
                    _ => [value(0), value(1013), value(7919)],
                },
                jpeg: [value(32749), value(991), value(4441)],
            }
        })
        .collect();
    for count in [0, 1, 4095, 4096, 4097, 8193, 65_537, 131_079] {
        let input = &pairs[..count];
        let (expected_luminances, expected_sweep) = serial_samples(input);
        for workers in [1, 2, 4] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .build()
                .unwrap();
            let (actual_luminances, actual_sweep) = pool.install(|| {
                (
                    all_pairs_scene_luminances(input),
                    sweep_samples_from_pairs(input),
                )
            });
            assert_eq!(actual_luminances.len(), count);
            assert_eq!(actual_sweep.len(), count);
            for index in 0..count {
                assert_eq!(
                    actual_luminances[index].to_bits(),
                    expected_luminances[index].to_bits(),
                    "luminance count={count} workers={workers} index={index}"
                );
                for (actual, expected) in actual_sweep[index]
                    .scene_rec2020
                    .iter()
                    .chain(&actual_sweep[index].display_srgb)
                    .zip(
                        expected_sweep[index]
                            .scene_rec2020
                            .iter()
                            .chain(&expected_sweep[index].display_srgb),
                    )
                {
                    assert_eq!(
                        actual.to_bits(),
                        expected.to_bits(),
                        "sweep count={count} workers={workers} index={index}"
                    );
                }
            }
        }
    }
}
