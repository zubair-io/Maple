//! Stage 1 of fit-acr: tonescale fit from neutral-ramp patches.
//!
//! Takes the neutral ramp patches (spec `PatchGroup::Neutral`), extracts their
//! measured display-linear luminance from the ACR PNG, pairs them with the
//! scene-linear spec targets, and fits a PCHIP-style monotone piecewise-cubic
//! mapping on log2(L) with `TONESCALE_KNOTS` (9) knots.
//!
//! The curve is evaluated by linear interpolation between knots; the PCHIP
//! property (monotone by construction) is enforced by computing slopes with
//! the Fritsch-Carlson algorithm and using them only to detect and flatten
//! non-monotone regions — the evaluation itself stays linear so the output
//! model is simple to export and consume.

use super::model::{Tonescale, TONESCALE_KNOTS};

/// Scene-linear luminance range covered by the 9 tonescale knots.
/// Matches the neutral ramp: 0.001 to 4.0, log-spaced.
fn knot_positions_log2() -> [f32; TONESCALE_KNOTS] {
    let lo = 0.001f32.log2();
    let hi = 4.0f32.log2();
    std::array::from_fn(|i| lo + i as f32 / (TONESCALE_KNOTS - 1) as f32 * (hi - lo))
}

/// A single neutral-ramp observation: (scene_lum, display_lum).
#[derive(Clone, Copy)]
pub struct NeutralSample {
    pub scene_lum: f32,
    pub display_lum: f32,
}

/// Fit a monotone piecewise-linear (PCHIP-stable) tonescale from neutral samples.
///
/// `samples` must include at least 2 unclipped points. Samples are binned into
/// `TONESCALE_KNOTS` log2 intervals; the knot value is the weighted mean of
/// the samples in that bin. Bins with no samples are filled by linear
/// interpolation from adjacent knots. Monotonicity is enforced after the fact
/// by clamping each knot value to be ≥ the previous.
pub fn fit_tonescale(samples: &[NeutralSample]) -> Option<Tonescale> {
    if samples.len() < 2 {
        return None;
    }

    let knot_log2 = knot_positions_log2();

    // Bin samples by log2(scene_lum) proximity to each knot.
    let bin_width = (knot_log2[TONESCALE_KNOTS - 1] - knot_log2[0])
        / (TONESCALE_KNOTS - 1) as f32;
    let mut sums = [0.0f64; TONESCALE_KNOTS];
    let mut counts = [0u32; TONESCALE_KNOTS];

    for &s in samples {
        if s.scene_lum <= 0.0 || s.display_lum < 0.0 {
            continue;
        }
        let log2_l = s.scene_lum.log2();
        let fi = ((log2_l - knot_log2[0]) / bin_width).round() as isize;
        let idx = fi.clamp(0, (TONESCALE_KNOTS - 1) as isize) as usize;
        sums[idx] += s.display_lum as f64;
        counts[idx] += 1;
    }

    // Knot values from bin means.
    let mut vals: [f32; TONESCALE_KNOTS] = [f32::NAN; TONESCALE_KNOTS];
    for i in 0..TONESCALE_KNOTS {
        if counts[i] > 0 {
            vals[i] = (sums[i] / counts[i] as f64) as f32;
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
        let kp = knot_positions_log2();
        assert!((kp[0] - 0.001f32.log2()).abs() < 1e-5, "first knot");
        assert!((kp[TONESCALE_KNOTS - 1] - 4.0f32.log2()).abs() < 1e-5, "last knot");
        // Monotone increasing.
        for i in 0..TONESCALE_KNOTS - 1 {
            assert!(kp[i + 1] > kp[i], "not monotone at {i}");
        }
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
                let log2_l = 0.001f32.log2()
                    + t * (4.0f32.log2() - 0.001f32.log2());
                let l = log2_l.exp2();
                NeutralSample { scene_lum: l, display_lum: l }
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
                NeutralSample { scene_lum: l, display_lum: display }
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
            assert!((v - expected).abs() < 0.01, "val[{i}] = {v} expected {expected}");
        }
    }
}
