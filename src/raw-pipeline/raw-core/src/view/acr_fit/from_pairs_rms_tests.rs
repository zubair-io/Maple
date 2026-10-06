use super::super::model::{
    apply_model, ciede2000, srgb_linear_to_lab, HueChromaField, CHROMA_BINS, FIELD_N, HUE_BINS,
    LUMA_BINS,
};
use super::*;

// Original serial calculation: independent of the parallel evaluator and its scratch.
fn serial_reference(pairs: &[DisplayPair], model: &AcrModel) -> f32 {
    let inverse = M_REC2020_TO_SRGB.inverse().unwrap();
    let mut total = 0.0f64;
    for pair in pairs {
        let (source, target) = decode_pair(pair, &inverse);
        let predicted = M_REC2020_TO_SRGB.mul_vec(apply_model(model, source));
        let predicted = predicted.map(|value| value.clamp(0.0, 1.0));
        let error = ciede2000(srgb_linear_to_lab(target), srgb_linear_to_lab(predicted));
        total += (error as f64) * (error as f64);
    }
    if pairs.is_empty() {
        0.0
    } else {
        (total / pairs.len() as f64).sqrt() as f32
    }
}

#[test]
fn parallel_rms_matches_original_serial_order_across_chunks_and_threads() {
    let model = AcrModel {
        tonescale: Tonescale {
            knots_log2: vec![-10.0, -5.0, 0.0, 2.0],
            values: vec![0.001, 0.06, 0.9, 3.5],
        },
        field: HueChromaField {
            hue_bins: HUE_BINS,
            chroma_bins: CHROMA_BINS,
            luma_bins: LUMA_BINS,
            delta_h_deg: (0..FIELD_N).map(|i| (i % 13) as f32 - 6.0).collect(),
            sat_scale: (0..FIELD_N).map(|i| 0.8 + (i % 7) as f32 * 0.05).collect(),
        },
        stats: FitStats {
            patches_used: 0,
            patches_clipped: 0,
            fit_rms_de: 0.0,
            overlap_rms_rel: None,
        },
    };
    let pairs: Vec<_> = (0..131_079u32)
        .map(|i| {
            let unit =
                |salt| (i.wrapping_mul(1_664_525).wrapping_add(salt) % 65_536) as f32 / 65_535.0;
            DisplayPair {
                maple: [unit(0), unit(1013), unit(7919)],
                jpeg: [unit(32749), unit(991), unit(4441)],
            }
        })
        .collect();
    for threads in [1, 2, 4] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
        for count in [0, 1, 4095, 4096, 4097, 65_535, 65_536, 65_537, 131_079] {
            let input = &pairs[..count];
            let reference_started = std::time::Instant::now();
            let expected = serial_reference(input, &model);
            let reference_ms = reference_started.elapsed().as_secs_f64() * 1000.0;
            let parallel_started = std::time::Instant::now();
            let actual = pool
                .install(|| compute_fit_rms_de_from_pairs(input, &model.tonescale, &model.field));
            let parallel_ms = parallel_started.elapsed().as_secs_f64() * 1000.0;
            if count == 131_079 {
                // Single ordered diagnostic sample; correctness, not speed, is gated.
                eprintln!("rms pairs={count} threads={threads} serial_ms={reference_ms:.4} parallel_ms={parallel_ms:.4}");
            }
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "count={count}, threads={threads}"
            );
        }
    }
}
