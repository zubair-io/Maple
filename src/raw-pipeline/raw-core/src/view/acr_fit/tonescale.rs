//! Stage 1 of fit-acr: tonescale fit from neutral-ramp patches.
//!
//! Takes the neutral ramp patches (spec `PatchGroup::Neutral`), extracts their
//! measured display-linear luminance from the ACR PNG, pairs them with the
//! scene-linear spec targets, and fits a monotone piecewise-linear mapping
//! on log2(L) with `TONESCALE_KNOTS` (9) knots.
//!
//! Algorithm: samples are aggregated into per-knot bins by nearest log2(L)
//! bin (mean per bin), empty bins are filled by linear interpolation from
//! their neighbours, and a final clamp-up pass enforces monotonicity
//! (`v[i] = max(v[i], v[i-1])`). Evaluation is linear interpolation between
//! knots, flat-extrapolated beyond the ends, so the exported model stays
//! trivial to consume. A smoother PCHIP-style cubic can replace this under
//! #1722 if knot-level linearity shows up in the baked LUT.
//!
//! The knot range is a caller-supplied [`KnotRange`], not a hard-coded span:
//! the synthetic sweep chart's neutral ramp is engineered to cover a known
//! scene-linear range (0.001 to 4.0, [`KnotRange::CHART_DEFAULT`]), but a
//! real photo's display-domain samples (Auto 2.0 M0's JPEG-pair front-end,
//! `from_pairs.rs`) live in a completely different, data-dependent range —
//! using the chart's fixed span there starves the top knots and produces
//! flat-extrapolation artefacts well inside the populated data (#1740 M0.5).

use super::model::{Tonescale, TONESCALE_KNOTS};

/// Scene-linear luminance range the tonescale's knots are log-spaced across.
/// The chart solver uses the fixed [`KnotRange::CHART_DEFAULT`] (matching the
/// synthetic neutral ramp's engineered span); the JPEG-pair front-end derives
/// one from the actual data via [`KnotRange::from_scene_luminances`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KnotRange {
    pub lo: f32,
    pub hi: f32,
}

impl KnotRange {
    /// Absolute floor/ceiling a derived range is clamped into — guards
    /// against a degenerate (all-identical or near-zero) sample set
    /// producing a zero- or negative-width log2 span.
    const FLOOR: f32 = 1e-4;
    const CEILING: f32 = 16.0;

    /// The chart solver's fixed span: 0.001 to 4.0 scene-linear, matching the
    /// synthetic sweep chart's engineered neutral ramp.
    pub const CHART_DEFAULT: KnotRange = KnotRange { lo: 0.001, hi: 4.0 };

    /// Derive a knot range from a population of scene-linear luminances: the
    /// 2nd/98th percentile, clamped into `[FLOOR, CEILING]` and given a
    /// minimum log2 span so a tightly clustered sample set (e.g. a flat grey
    /// card) doesn't collapse the range to a single point. Falls back to
    /// [`KnotRange::CHART_DEFAULT`] when there are too few samples to derive
    /// a percentile from.
    ///
    /// Callers should pass the FULL population of scene luminances the
    /// tonescale will actually be evaluated against — i.e. every pair's
    /// luminance, not just the neutral-chroma subset used to fit the
    /// tonescale's VALUES. The chart solver's own neutral ramp is engineered
    /// to span the exact same range as its sweep patches for this reason: a
    /// range derived only from a neutral-chroma subset can be much narrower
    /// than the full luminance spread of a real photo's dominant (chromatic)
    /// content — e.g. a photo whose near-neutral pixels sit only in deep
    /// shadow while its saturated content spans well into the midtones would
    /// otherwise anchor the whole lattice to a near-black range and push most
    /// of the actual image into flat-scale extrapolation from that dark
    /// anchor (#1740 M0.5 fixture regression on `test_0006`).
    ///
    /// Percentile (not raw min/max) clamping keeps a handful of outlier
    /// pixels — a stray hot pixel or a mis-tagged near-black sample — from
    /// stretching the whole lattice thin; the field fit's own per-cell
    /// identity default already handles the resulting few-percent tail that
    /// falls outside the populated range exactly the way it handles chroma
    /// cells with no coverage.
    pub fn from_scene_luminances(luminances: &[f32]) -> KnotRange {
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
        let lo_raw = pct(0.02).clamp(Self::FLOOR, Self::CEILING);
        let hi_raw = pct(0.98).clamp(Self::FLOOR, Self::CEILING);

        // Minimum span of one log2 stop so a near-flat sample set still
        // yields a usable (non-degenerate) lattice.
        const MIN_LOG2_SPAN: f32 = 1.0;
        let (lo, hi) = if hi_raw.log2() - lo_raw.log2() < MIN_LOG2_SPAN {
            let mid_log2 = (lo_raw.log2() + hi_raw.log2()) * 0.5;
            (
                (mid_log2 - MIN_LOG2_SPAN * 0.5)
                    .exp2()
                    .clamp(Self::FLOOR, Self::CEILING),
                (mid_log2 + MIN_LOG2_SPAN * 0.5)
                    .exp2()
                    .clamp(Self::FLOOR, Self::CEILING),
            )
        } else {
            (lo_raw, hi_raw)
        };
        KnotRange { lo, hi }
    }

    fn knot_positions_log2(&self) -> [f32; TONESCALE_KNOTS] {
        let lo = self.lo.log2();
        let hi = self.hi.log2();
        std::array::from_fn(|i| lo + i as f32 / (TONESCALE_KNOTS - 1) as f32 * (hi - lo))
    }
}

/// A tonescale observation and its heuristic neutral preference.
#[derive(Clone, Copy)]
pub struct NeutralSample {
    pub scene_lum: f32,
    pub display_lum: f32,
    /// Gaussian chroma weight in (0, 1]; chart neutrals have unit weight.
    pub neutral_weight: f32,
    /// Whether this observation meets the original near-neutral criterion.
    pub is_neutral: bool,
}

impl NeutralSample {
    /// A known neutral chart/ramp observation. Photo pairs weight chroma.
    pub const fn new(scene_lum: f32, display_lum: f32) -> Self {
        Self {
            scene_lum,
            display_lum,
            neutral_weight: 1.0,
            is_neutral: true,
        }
    }
}

/// Fit a monotone piecewise-linear (PCHIP-stable) tonescale from neutral
/// samples over the chart solver's fixed [`KnotRange::CHART_DEFAULT`] span.
/// Chart-fit callers (`mod.rs`) keep using this entry point unchanged.
///
/// `samples` must include at least 2 unclipped points. Samples are binned into
/// `TONESCALE_KNOTS` log2 intervals; the knot value is the weighted mean of
/// the samples in that bin. Bins with no samples are filled by linear
/// interpolation from adjacent knots. Monotonicity is enforced after the fact
/// by clamping each knot value to be ≥ the previous.
pub fn fit_tonescale(samples: &[NeutralSample]) -> Option<Tonescale> {
    fit_tonescale_with_range(samples, KnotRange::CHART_DEFAULT)
}

/// Same as [`fit_tonescale`] but over a caller-supplied [`KnotRange`] instead
/// of the chart's fixed span — the JPEG-pair front-end (`from_pairs.rs`)
/// derives its range from the FULL pair population's scene luminances via
/// [`KnotRange::from_scene_luminances`] so the lattice covers the luminance
/// span the model is actually evaluated against (#1740 M0.5).
pub fn fit_tonescale_with_range(samples: &[NeutralSample], range: KnotRange) -> Option<Tonescale> {
    if samples.len() < 2
        || !range.lo.is_finite()
        || !range.hi.is_finite()
        || range.lo <= 0.0
        || range.hi <= range.lo
    {
        return None;
    }

    let knot_log2 = range.knot_positions_log2();

    // Bin samples by log2(scene_lum) proximity to each knot.
    let bin_width = (knot_log2[TONESCALE_KNOTS - 1] - knot_log2[0]) / (TONESCALE_KNOTS - 1) as f32;
    let mut sums = [0.0f64; TONESCALE_KNOTS];
    let mut counts = [0u32; TONESCALE_KNOTS];
    let mut weight_sums = [0.0f64; TONESCALE_KNOTS];
    let mut neutral_sums = [0.0f64; TONESCALE_KNOTS];
    let mut neutral_counts = [0u32; TONESCALE_KNOTS];

    for &s in samples {
        if !s.scene_lum.is_finite()
            || s.scene_lum <= 0.0
            || !s.display_lum.is_finite()
            || s.display_lum < 0.0
            || !s.neutral_weight.is_finite()
            || s.neutral_weight <= 0.0
            || s.neutral_weight > 1.0
        {
            continue;
        }
        let log2_l = s.scene_lum.log2();
        let fi = ((log2_l - knot_log2[0]) / bin_width).round() as isize;
        let idx = fi.clamp(0, (TONESCALE_KNOTS - 1) as isize) as usize;
        sums[idx] += s.display_lum as f64 * s.neutral_weight as f64;
        weight_sums[idx] += s.neutral_weight as f64;
        if s.is_neutral {
            neutral_sums[idx] += s.display_lum as f64;
            neutral_counts[idx] += 1;
        }
        counts[idx] += 1;
    }

    if counts.iter().map(|&n| u64::from(n)).sum::<u64>() < 2 {
        return None;
    }

    // #3633: a handful of recovered glints must not own a global tone knot.
    // Borrow sqrt(available observations) from the soft neutral estimate.
    // Dense neutral evidence dominates this sublinear prior; sparse bins get
    // support from the wider population. All-neutral chart bins remain exact.
    // This is a stability heuristic, not a count of independent evidence:
    // tiny chroma weights influence the soft mean little, but count as support.
    // Auto pairs use the fixed embedded-JPEG pixel lattice (pairs.rs), so source
    // render resolution changes footprints, not the available sample count.
    let mut vals: [f32; TONESCALE_KNOTS] = [f32::NAN; TONESCALE_KNOTS];
    for i in 0..TONESCALE_KNOTS {
        if counts[i] > 0 {
            vals[i] = if neutral_counts[i] == counts[i] {
                (neutral_sums[i] / neutral_counts[i] as f64) as f32
            } else {
                let prior = (counts[i] as f64).sqrt();
                let soft_mean = sums[i] / weight_sums[i];
                ((neutral_sums[i] + prior * soft_mean) / (neutral_counts[i] as f64 + prior)) as f32
            };
        }
    }

    // Fill NaN knots by linear interpolation between known knots.
    fill_nan_linear(&mut vals);

    // Enforce strict monotonicity (clamp-up pass).
    for i in 1..TONESCALE_KNOTS {
        if vals[i] < vals[i - 1] {
            vals[i] = vals[i - 1];
        }
    }

    Some(Tonescale {
        knots_log2: knot_log2.to_vec(),
        values: vals.to_vec(),
    })
}

#[cfg(test)]
mod support_tests {
    use super::*;

    const RANGE: KnotRange = KnotRange { lo: 0.01, hi: 0.5 };

    fn highlight_samples(glints_are_neutral: bool) -> Vec<NeutralSample> {
        let mut samples = vec![NeutralSample::new(0.01, 0.01); 300];
        samples.extend(vec![NeutralSample::new(0.5, 0.55); 21]);
        samples.extend(vec![
            NeutralSample {
                scene_lum: 0.5,
                display_lum: 0.6,
                neutral_weight: 0.2,
                is_neutral: false,
            };
            10_000
        ]);
        samples.extend(vec![
            NeutralSample {
                scene_lum: 0.5,
                display_lum: 0.75,
                neutral_weight: if glints_are_neutral { 0.7 } else { 0.2 },
                is_neutral: glints_are_neutral,
            };
            7
        ]);
        samples
    }

    #[test]
    fn sparse_highlight_glints_do_not_move_the_global_curve() {
        let before = highlight_samples(true);
        let after = highlight_samples(false);
        let fit = |s: &[NeutralSample]| fit_tonescale_with_range(s, RANGE).unwrap();
        let a = fit(&before);
        let b = fit(&after);
        // This reproduces #3633's seven-glint classification change. The
        // former neutral-only mean moves the highlight knot by 0.05.
        let neutral_only = |s: &[NeutralSample]| {
            s.iter()
                .filter(|p| p.is_neutral)
                .copied()
                .collect::<Vec<_>>()
        };
        let old_a = fit(&neutral_only(&before));
        let old_b = fit(&neutral_only(&after));
        assert!((old_a.values[8] - old_b.values[8]).abs() > 0.04);
        assert_eq!(a.values[0], b.values[0], "shadow observations changed");
        for (x, y) in a.values.iter().zip(&b.values) {
            assert!(
                (x - y).abs() < 0.012,
                "sparse glints shifted knot {x} → {y}"
            );
        }
    }

    #[test]
    fn all_neutral_bins_preserve_the_chart_fit_exactly() {
        let samples: Vec<_> = (0..64)
            .map(|i| {
                let x = 0.01 * 50.0f32.powf(i as f32 / 63.0);
                NeutralSample::new(x, x.sqrt())
            })
            .collect();
        let weighted: Vec<_> = samples
            .iter()
            .enumerate()
            .map(|(i, &s)| NeutralSample {
                neutral_weight: 0.1 + (i % 9) as f32 * 0.1,
                ..s
            })
            .collect();
        let a = fit_tonescale_with_range(&samples, RANGE).unwrap();
        let b = fit_tonescale_with_range(&weighted, RANGE).unwrap();
        assert_eq!(a.knots_log2, b.knots_log2);
        assert_eq!(a.values, b.values);
    }

    #[test]
    fn weighted_fit_rejects_invalid_or_insufficient_observations() {
        for weight in [0.0, -1.0, 1.1, f32::NAN, f32::INFINITY] {
            let invalid = NeutralSample {
                neutral_weight: weight,
                ..NeutralSample::new(0.2, 0.3)
            };
            assert!(fit_tonescale_with_range(&[invalid; 2], RANGE).is_none());
        }
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(
                fit_tonescale_with_range(&[NeutralSample::new(value, 0.3); 2], RANGE).is_none()
            );
            assert!(
                fit_tonescale_with_range(&[NeutralSample::new(0.2, value); 2], RANGE).is_none()
            );
        }
        let one_valid = [NeutralSample::new(0.2, 0.3), NeutralSample::new(0.0, 0.3)];
        assert!(fit_tonescale_with_range(&one_valid, RANGE).is_none());
        for range in [
            KnotRange { lo: 0.0, hi: 1.0 },
            KnotRange { lo: 1.0, hi: 1.0 },
            KnotRange {
                lo: 0.1,
                hi: f32::NAN,
            },
        ] {
            assert!(fit_tonescale_with_range(&[NeutralSample::new(0.2, 0.3); 2], range).is_none());
        }
    }

    #[test]
    fn soft_only_observations_produce_a_finite_monotone_fit() {
        let samples: Vec<_> = (0..32)
            .map(|i| NeutralSample {
                scene_lum: 0.01 + i as f32 * 0.01,
                display_lum: 0.1 + i as f32 * 0.02,
                neutral_weight: f32::MIN_POSITIVE,
                is_neutral: false,
            })
            .collect();
        let fit = fit_tonescale_with_range(&samples, RANGE).unwrap();
        assert!(fit
            .values
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0));
        assert!(fit.values.windows(2).all(|w| w[1] >= w[0]));
    }
}

/// Fill `NaN` entries by linear interpolation between the nearest valid neighbours.
/// If all values are NaN, fills with 0.0. If only the first or last is valid,
/// extends flat.
fn fill_nan_linear(vals: &mut [f32]) {
    let n = vals.len();
    // Find first valid.
    let first_valid = (0..n).find(|&i| !vals[i].is_nan());
    let last_valid = (0..n).rfind(|&i| !vals[i].is_nan());
    let (first, last) = match (first_valid, last_valid) {
        (Some(f), Some(l)) => (f, l),
        _ => {
            vals.fill(0.0);
            return;
        }
    };
    // Fill left of first.
    for i in 0..first {
        vals[i] = vals[first];
    }
    // Fill right of last.
    for i in (last + 1)..n {
        vals[i] = vals[last];
    }
    // Fill interior gaps.
    let mut i = first;
    while i <= last {
        if vals[i].is_nan() {
            // Find next valid.
            let j = (i..=last).find(|&k| !vals[k].is_nan()).unwrap_or(last);
            let lo_val = vals[i - 1];
            let hi_val = vals[j];
            let gap = (j - (i - 1)) as f32;
            for k in i..j {
                let t = (k - (i - 1)) as f32 / gap;
                vals[k] = lo_val + t * (hi_val - lo_val);
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
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
}
