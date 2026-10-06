use super::*;

// Original serial fit retained as an independent numerical oracle.
fn serial_fit_field(
    samples: &[SweepSample],
    ts: &Tonescale,
    shrink_k: f32,
) -> (HueChromaField, usize, usize) {
    use crate::color::matrices::M_REC2020_TO_SRGB;
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");

    let mut dh_sum = vec![0.0f64; FIELD_N];
    let mut ss_sum = vec![0.0f64; FIELD_N];
    let mut counts = vec![0u32; FIELD_N];
    let mut patches_clipped = 0usize;
    let mut patches_used = 0usize;

    for s in samples {
        // Luminance-preserving tonescale prediction.
        let l_scene =
            0.2627 * s.scene_rec2020[0] + 0.6780 * s.scene_rec2020[1] + 0.0593 * s.scene_rec2020[2];
        if l_scene <= 0.0 {
            patches_clipped += 1;
            continue;
        }
        let l_display_pred = crate::view::acr_fit::model::tonescale_apply(ts, l_scene);
        let scale = l_display_pred / l_scene;
        let pred_rec2020 = [
            s.scene_rec2020[0] * scale,
            s.scene_rec2020[1] * scale,
            s.scene_rec2020[2] * scale,
        ];

        // Convert prediction to Oklab LCh.
        let lab_pred = rec2020_to_oklab(pred_rec2020);
        let c_pred = (lab_pred[1] * lab_pred[1] + lab_pred[2] * lab_pred[2]).sqrt();
        if c_pred < 1e-4 {
            patches_clipped += 1;
            continue; // neutral — no chroma signal
        }
        let h_pred = lab_pred[2].atan2(lab_pred[1]).to_degrees();

        // Measured: display sRGB → Rec.2020 → Oklab.
        let meas_rec2020 = m_srgb_to_rec2020.mul_vec(s.display_srgb);
        let lab_meas = rec2020_to_oklab(meas_rec2020);
        let c_meas = (lab_meas[1] * lab_meas[1] + lab_meas[2] * lab_meas[2]).sqrt();
        let h_meas = if c_meas > 1e-6 {
            lab_meas[2].atan2(lab_meas[1]).to_degrees()
        } else {
            h_pred
        };

        // Residuals. The per-sample ratio is bounded BEFORE averaging so a
        // near-neutral prediction's degenerate ratio can't own a sparse cell.
        let dh = angle_diff_deg(h_meas, h_pred);
        let sat_scale = if c_pred > 1e-6 {
            (c_meas / c_pred).clamp(SAT_RATIO_MIN, SAT_RATIO_MAX)
        } else {
            1.0
        };

        // Lattice coordinates (nearest-bin).
        let hue_norm = h_pred.rem_euclid(360.0) / 360.0;
        let hi = (hue_norm * HUE_BINS as f32).round() as usize % HUE_BINS;
        let chroma_frac = (c_pred / 0.30).clamp(0.0, 1.0);
        let ci = ((chroma_frac * (CHROMA_BINS - 1) as f32).round() as usize).min(CHROMA_BINS - 1);
        let luma_frac = lab_pred[0].clamp(0.0, 1.0);
        let li = ((luma_frac * (LUMA_BINS - 1) as f32).round() as usize).min(LUMA_BINS - 1);

        let idx = li * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi;
        dh_sum[idx] += dh as f64;
        ss_sum[idx] += sat_scale as f64;
        counts[idx] += 1;
        patches_used += 1;
    }

    // Convert sums to count-shrunk means (empty cells stay at the 0 / 1
    // identity defaults; sparsely-supported cells decay most of the way
    // toward them when `shrink_k > 0` — see [`PAIRS_SHRINK_K`]).
    let mut dh_field = vec![0.0f32; FIELD_N];
    let mut ss_field = vec![1.0f32; FIELD_N];
    for i in 0..FIELD_N {
        if counts[i] > 0 {
            let mean_dh = (dh_sum[i] / counts[i] as f64) as f32;
            let mean_ss = (ss_sum[i] / counts[i] as f64) as f32;
            let w = counts[i] as f32 / (counts[i] as f32 + shrink_k);
            dh_field[i] = mean_dh * w;
            ss_field[i] = 1.0 + (mean_ss - 1.0) * w;
        }
    }

    // Two passes of neighbour smoothing.
    smooth_field(&mut dh_field);
    smooth_field(&mut dh_field);
    smooth_field(&mut ss_field);
    smooth_field(&mut ss_field);

    let field = HueChromaField {
        hue_bins: HUE_BINS,
        chroma_bins: CHROMA_BINS,
        luma_bins: LUMA_BINS,
        delta_h_deg: dh_field,
        sat_scale: ss_field,
    };
    (field, patches_used, patches_clipped)
}

#[test]
fn bounded_parallel_observations_match_serial_field_bits() {
    let samples: Vec<_> = (0..65539)
        .map(|i| {
            let f = |salt: usize| ((i * 7919 + salt * 104729) % 65521) as f32 / 65520.0;
            SweepSample {
                scene_rec2020: match i % 31 {
                    0 => [0.0; 3],
                    1 => [-0.1; 3],
                    2 => [0.5; 3],
                    3 => [1e-7, 0.0, 1e-7],
                    _ => [f(1) * 1.5, f(2), f(3)],
                },
                display_srgb: [f(4), f(5), f(6)],
            }
        })
        .collect();
    let ts = Tonescale {
        knots_log2: vec![-10.0, -3.0, 0.0],
        values: vec![0.001, 0.19, 0.95],
    };
    for len in [0, 1, 511, 512, 8191, 8192, 8193, 65539] {
        for shrink in [0.0, PAIRS_SHRINK_K] {
            let (expected, used, clipped) = serial_fit_field(&samples[..len], &ts, shrink);
            for workers in [1, 2, 4] {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(workers)
                    .build()
                    .unwrap();
                let (actual, actual_used, actual_clipped) =
                    pool.install(|| fit_field(&samples[..len], &ts, shrink));
                assert_eq!((actual_used, actual_clipped), (used, clipped));
                for (a, b) in actual
                    .delta_h_deg
                    .iter()
                    .chain(&actual.sat_scale)
                    .zip(expected.delta_h_deg.iter().chain(&expected.sat_scale))
                {
                    assert_eq!(
                        a.to_bits(),
                        b.to_bits(),
                        "len={len} workers={workers} shrink={shrink}"
                    );
                }
            }
        }
    }
    assert!(OBSERVATION_CHUNK * std::mem::size_of::<Option<(usize, f32, f32)>>() <= 256 * 1024);
}
