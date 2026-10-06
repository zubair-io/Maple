use super::*;

#[test]
fn knot_positions_span_neutral_ramp() {
    let kp = KnotRange::CHART_DEFAULT.knot_positions_log2();
    assert!((kp[0] - 0.001f32.log2()).abs() < 1e-5, "first knot");
    assert!(
        (kp[TONESCALE_KNOTS - 1] - 4.0f32.log2()).abs() < 1e-5,
        "last knot"
    );
    // Monotone increasing.
    for i in 0..TONESCALE_KNOTS - 1 {
        assert!(kp[i + 1] > kp[i], "not monotone at {i}");
    }
}

#[test]
fn knot_range_from_scene_luminances_matches_percentile_bounds() {
    // 100 luminances log-uniform in [0.01, 2.0]; the derived range should
    // sit close to the 2nd/98th percentile of that span, not the raw
    // min/max.
    let lums: Vec<f32> = (0..100)
        .map(|i| {
            let t = i as f32 / 99.0;
            let log2_l = 0.01f32.log2() + t * (2.0f32.log2() - 0.01f32.log2());
            log2_l.exp2()
        })
        .collect();
    let range = KnotRange::from_scene_luminances(&lums);
    assert!(
        range.lo > 0.01 * 0.5 && range.lo < 0.01 * 4.0,
        "derived lo {} should be near the low percentile, not the chart default 0.001",
        range.lo
    );
    assert!(
        range.hi > 2.0 * 0.5 && range.hi < 2.0 * 2.0,
        "derived hi {} should be near the high percentile, not the chart default 4.0",
        range.hi
    );
}

#[test]
fn knot_range_from_scene_luminances_falls_back_on_sparse_input() {
    let lums = vec![0.5, 0.6];
    assert_eq!(
        KnotRange::from_scene_luminances(&lums),
        KnotRange::CHART_DEFAULT,
        "too few samples to derive a percentile — must fall back to the chart default"
    );
}

#[test]
fn knot_range_from_scene_luminances_enforces_minimum_span() {
    // All luminances identical -> a degenerate zero-width span must be
    // widened to the minimum log2 span, not left collapsed.
    let lums = vec![0.3f32; 20];
    let range = KnotRange::from_scene_luminances(&lums);
    assert!(
        range.hi.log2() - range.lo.log2() >= 0.99,
        "degenerate sample set must still yield a usable span, got lo={} hi={}",
        range.lo,
        range.hi
    );
}

#[test]
fn fit_tonescale_identity_mapping() {
    // Samples where display = scene (identity renderer).  Verifies that:
    // (a) the fit does not fail, and
    // (b) the fitted tonescale is monotone (it should be, by construction).
    // We do NOT check absolute accuracy here — that belongs in the
    // integration test (fit_acr_solver.rs) which uses a dense analytic
    // renderer.  The nearest-bin aggregation in the solver introduces
    // bin-mean drift that makes per-knot accuracy checks fragile with
    // few samples.
    let samples: Vec<NeutralSample> = (0..32)
        .map(|i| {
            let t = i as f32 / 31.0;
            let log2_l = 0.001f32.log2() + t * (4.0f32.log2() - 0.001f32.log2());
            let l = log2_l.exp2();
            NeutralSample::new(l, l)
        })
        .collect();
    let ts = fit_tonescale(&samples).expect("must fit");
    // Monotone (guaranteed by clamp-up pass).
    for i in 0..ts.values.len() - 1 {
        assert!(
            ts.values[i + 1] >= ts.values[i],
            "not monotone at knot {i}: {} -> {}",
            ts.values[i],
            ts.values[i + 1]
        );
    }
    // Positivity.
    assert!(ts.values[0] > 0.0, "first knot value not positive");
    // Upper bound: display values should be positive and not wildly large.
    for (i, &v) in ts.values.iter().enumerate() {
        assert!(v >= 0.0 && v <= 10.0, "knot {i} value {v:.4} out of [0,10]");
    }
}

#[test]
fn fit_tonescale_is_monotone() {
    // Noisy samples.
    let samples: Vec<NeutralSample> = (0..64)
        .map(|i| {
            let t = i as f32 / 63.0;
            let log2_l = 0.001f32.log2() + t * (4.0f32.log2() - 0.001f32.log2());
            let l = log2_l.exp2();
            // Display is a simple tone curve.
            let display = if l < 1.0 { l.powf(0.5) * 0.8 } else { 0.8 };
            NeutralSample::new(l, display)
        })
        .collect();
    let ts = fit_tonescale(&samples).expect("must fit");
    for i in 0..ts.values.len() - 1 {
        assert!(
            ts.values[i + 1] >= ts.values[i],
            "not monotone at knot {i}: {} -> {}",
            ts.values[i],
            ts.values[i + 1]
        );
    }
}

#[test]
fn fill_nan_linear_fills_interior() {
    let mut vals = [f32::NAN; 5];
    vals[0] = 0.0;
    vals[4] = 1.0;
    fill_nan_linear(&mut vals);
    for (i, &v) in vals.iter().enumerate() {
        assert!(!v.is_nan(), "NaN at {i}");
        let expected = i as f32 / 4.0;
        assert!(
            (v - expected).abs() < 0.01,
            "val[{i}] = {v} expected {expected}"
        );
    }
}

fn sorted_reference(luminances: &[f32]) -> KnotRange {
    let mut lums: Vec<f32> = luminances
        .iter()
        .copied()
        .filter(|l| l.is_finite() && *l > 0.0)
        .collect();
    if lums.len() < 8 {
        return KnotRange::CHART_DEFAULT;
    }
    lums.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f32| -> f32 {
        let idx = ((lums.len() - 1) as f32 * p).round() as usize;
        lums[idx.min(lums.len() - 1)]
    };
    // 2nd/98th percentile. #1740 M1 calibration note: widening the
    // ceiling to the 99.9th percentile was tried as a posterized-
    // highlight fix (pull the highlight population inside the fitted
    // lattice) and REJECTED — stretching the 9-knot span across the
    // outlier tail coarsens midtone resolution enough to regress
    // fixtures whose signal lives there (test_0006 baseline_auto mean
    // ΔE00 4.40 → 6.43 on the ACR-parity harness). The highlight
    // plateau is instead fixed where it belongs: the JPEG-pair
    // front-end's identity-decay extrapolation
    // (`from_pairs::shape_tonescale_for_display_domain`) and the bake's
    // soft shoulder (`acr_fit::bake::shoulder_01`) — the top ~2% past
    // the last knot decays to identity instead of compounding the
    // boundary gain.
    let lo_raw = pct(0.02).clamp(KnotRange::FLOOR, KnotRange::CEILING);
    let hi_raw = pct(0.98).clamp(KnotRange::FLOOR, KnotRange::CEILING);

    // Minimum span of one log2 stop so a near-flat sample set still
    // yields a usable (non-degenerate) lattice.
    const MIN_LOG2_SPAN: f32 = 1.0;
    let (lo, hi) = if hi_raw.log2() - lo_raw.log2() < MIN_LOG2_SPAN {
        let mid_log2 = (lo_raw.log2() + hi_raw.log2()) * 0.5;
        (
            (mid_log2 - MIN_LOG2_SPAN * 0.5)
                .exp2()
                .clamp(KnotRange::FLOOR, KnotRange::CEILING),
            (mid_log2 + MIN_LOG2_SPAN * 0.5)
                .exp2()
                .clamp(KnotRange::FLOOR, KnotRange::CEILING),
        )
    } else {
        (lo_raw, hi_raw)
    };
    KnotRange { lo, hi }
}

#[test]
fn selection_matches_original_sort_exactly() {
    let mut cases = vec![
        vec![],
        vec![1.0; 7],
        vec![0.1; 8],
        vec![0.5; 4097],
        vec![1e-10; 100],
        vec![100.0; 100],
        vec![f32::NAN, f32::INFINITY, -1.0, -0.0, 0.0],
        vec![
            f32::NAN,
            -1.0,
            0.0,
            0.0001,
            0.01,
            0.1,
            0.2,
            0.3,
            0.5,
            1.0,
            2.0,
            4.0,
            16.0,
            f32::INFINITY,
        ],
    ];
    cases.push(
        (0..1000)
            .map(|i| if i % 2 == 0 { 0.001 } else { 10.0 })
            .collect(),
    );
    cases.push(
        (0..1_000_003u32)
            .map(|i| (i.wrapping_mul(1_664_525).wrapping_add(1013) % 1_000_000) as f32 / 65535.0)
            .collect(),
    );
    for input in cases {
        let started = std::time::Instant::now();
        let expected = sorted_reference(&input);
        let sorted_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = std::time::Instant::now();
        let actual = KnotRange::from_scene_luminances(&input);
        if input.len() > 1_000_000 {
            eprintln!(
                "knot population={} sorted_ms={sorted_ms:.4} selected_ms={:.4}",
                input.len(),
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
        assert_eq!(
            actual.lo.to_bits(),
            expected.lo.to_bits(),
            "lo population={}",
            input.len()
        );
        assert_eq!(
            actual.hi.to_bits(),
            expected.hi.to_bits(),
            "hi population={}",
            input.len()
        );
    }
}
