use super::*;

// Original loop, independent of the production iterator/parallel closure.
fn serial_reference(pairs: &[DisplayPair]) -> Vec<NeutralSample> {
    let inverse = M_REC2020_TO_SRGB.inverse().unwrap();
    let chroma_max = NEUTRAL_CHROMA_FRAC * 0.30;
    let mut samples = Vec::new();
    for pair in pairs {
        let (maple, jpeg) = decode_pair(pair, &inverse);
        let lab = rec2020_to_oklab(maple);
        let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        let neutral_weight = (-(chroma / chroma_max).powi(2)).exp();
        if !neutral_weight.is_finite() || neutral_weight <= 0.0 {
            continue;
        }
        let scene_lum = rec2020_luma(maple);
        if scene_lum <= 0.0 {
            continue;
        }
        samples.push(NeutralSample {
            scene_lum,
            display_lum: 0.2126 * jpeg[0] + 0.7152 * jpeg[1] + 0.0722 * jpeg[2],
            neutral_weight,
            is_neutral: chroma <= chroma_max,
        });
    }
    samples
}

fn bits(sample: &NeutralSample) -> (u32, u32, u32, bool) {
    (
        sample.scene_lum.to_bits(),
        sample.display_lum.to_bits(),
        sample.neutral_weight.to_bits(),
        sample.is_neutral,
    )
}

#[test]
fn neutral_samples_preserve_exact_fields_rejections_and_order() {
    let pairs: Vec<_> = (0..131_079u32)
        .map(|i| {
            let unit =
                |salt| (i.wrapping_mul(1_664_525).wrapping_add(salt) % 65_536) as f32 / 65_535.0;
            let maple = match i % 7 {
                0 => [0.0; 3],
                1 => [f32::NAN, 0.5, 0.5],
                2 => [unit(0); 3],
                _ => [unit(0), unit(1013), unit(7919)],
            };
            DisplayPair {
                maple,
                jpeg: [unit(991), unit(4441), unit(32749)],
            }
        })
        .collect();
    for threads in [1, 2, 4] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
        for count in [0, 1, 4095, 4096, 4097, 65_537, 131_079] {
            let input = &pairs[..count];
            let started = std::time::Instant::now();
            let expected = serial_reference(input);
            let serial_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = std::time::Instant::now();
            let actual = pool.install(|| neutral_samples_from_pairs(input));
            if count == pairs.len() {
                eprintln!("neutral pairs={count} threads={threads} serial_ms={serial_ms:.4} evaluator_ms={:.4}", started.elapsed().as_secs_f64() * 1000.0);
                assert!(expected.len() > 0 && expected.len() < count);
            }
            assert_eq!(
                actual.len(),
                expected.len(),
                "count={count}, threads={threads}"
            );
            for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
                assert_eq!(
                    bits(actual),
                    bits(expected),
                    "count={count}, threads={threads}, index={index}"
                );
            }
        }
    }
}
