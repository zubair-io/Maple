//! Auto white-balance estimators: grey-world / white-patch CCT+tint solve.
//!
//! Extracted from `white_balance.rs` to keep that file within the 600-LOC
//! file-budget gate (#1468). Pure code move — no logic change.
//!
//! Re-exported from `white_balance` so existing call sites at
//! `crate::stages::white_balance::*` continue to compile unchanged.

use super::white_balance::wb_gains;

/// Rough CCT estimator from a G-normalised `AsShotNeutral` (R, 1, B).
///
/// Anchors: `log2(B/R) = 0` → 5500 K, `±1` → `±2500 K`. Good to within
/// ~500 K for the common daylight / tungsten / cloudy range — better than
/// the 6500 K fallback that otherwise shows up when rawler can't surface a
/// CCT itself.
///
/// The sign convention: high B/R → blue image → cool source → LOWER CCT
/// (this matches the reference renderer: a bluer image means the camera
/// was shot under a warmer-than-D65 light, which has high-CCT in Kelvin,
/// BUT the NEUTRAL vector has B>R in that case — so log2(B/R) > 0 →
/// 5500 + positive offset → HIGHER Kelvin). This is single-sourced from
/// `raw-wasm/src/lib.rs:estimate_cct_from_neutral`; the WASM binding now
/// calls this version and the old copy has been removed.
///
/// # Example
/// ```
/// use raw_core::stages::white_balance::estimate_cct_from_neutral;
/// let cct = estimate_cct_from_neutral([0.5, 1.0, 0.7]);
/// assert!(cct > 3000.0 && cct < 12000.0);
/// ```
pub fn estimate_cct_from_neutral(as_shot_neutral: [f32; 3]) -> f32 {
    let r = as_shot_neutral[0].max(0.01);
    let b = as_shot_neutral[2].max(0.01);
    let log2_ratio = (b / r).ln() / core::f32::consts::LN_2;
    (5500.0 + log2_ratio * 2500.0).clamp(2000.0, 12000.0)
}

/// Convert a G-normalised scene neutral `[r, 1, b]` to `(temperature_k, tint)`.
///
/// The neutral is the G-normalised measured chromaticity of the probe
/// scene (as if `AsShotNeutral` from the camera, but computed from the image
/// itself). The function:
///
/// 1. Seeds CCT from [`estimate_cct_from_neutral`].
/// 2. Refines with ≤ 8 deterministic bisection steps comparing the
///    R/B ratio of `wb_gains(cct, 0)` against the target neutral's R/B ratio.
/// 3. Reads the residual green channel deviation as tint — matching the CAT16
///    sign convention: positive tint = magenta (source appears greener,
///    image pushed toward magenta).
///
/// Re-uses the existing `cct_to_xy` / `wb_gains` functions — no new color
/// matrices. The bisection is deterministic (fixed ≤ 8 iterations, no RNG).
///
/// # Example
/// ```
/// use raw_core::stages::white_balance::neutral_to_temp_tint;
/// let (t, tint) = neutral_to_temp_tint([1.0, 1.0, 1.0]);
/// // A perfectly neutral [1,1,1] → gain R/B = 1 at D65 → ~6500K.
/// assert!((t - 6500.0).abs() < 1000.0);
/// assert!(tint.abs() < 10.0);
/// ```
pub fn neutral_to_temp_tint(neutral: [f32; 3]) -> (f32, f32) {
    // Find the (cct, tint) whose correction gain `wb_gains` neutralises the
    // measured G-normalised scene neutral [r, 1, b]:
    //   - CCT sets the gain's R/B ratio — match `gain.R / gain.B = b/r`.
    //   - tint sets the common green/magenta level.
    //
    // With the corrected perpendicular-to-Planckian-locus tint axis (ticket
    // #1725), tint also shifts the R/B ratio, so CCT and tint are coupled.
    // A simple alternating iteration can diverge; we use a two-step approach:
    //
    //  1. Outer bisection over CCT (16 steps, ~0.4 K resolution at 6500 K):
    //     For each candidate CCT, solve for the tint that brings the R level to
    //     1 (`solve_tint_for_level`), then compute the resulting R/B.  We bisect
    //     CCT until that R/B matches target_rb.  The outer function is monotone
    //     in CCT because at higher CCTs the source is bluer: lower R gain →
    //     lower R/B, so the residual is strictly decreasing.
    //  2. Final tint solve at the converged CCT.
    //
    // `solve_tint_for_level` can rail to ±100 when the neutral is far from the
    // achievable locus; the guard in step 1 clamps to the nearer rail in that
    // case (same as the original logic).  Reuses `wb_gains` only — no new color
    // math (#1371).
    let target_r = neutral[0].max(1e-4);
    let target_b = neutral[2].max(1e-4);
    let target_gain_rb = target_b / target_r; // desired wb_gains.R / wb_gains.B

    // Evaluate the R/B at a given CCT after optimally solving tint.
    // Falls back to tint=0 if the tint solve produces unphysical gains (which
    // can happen at extreme CCTs when the target neutral lies far from the
    // achievable locus and `solve_tint_for_level` rails).
    let rb_at_cct = |c: f32| -> f32 {
        let t = solve_tint_for_level(c, target_r);
        let g = wb_gains(c, t);
        // Guard: gains must be positive and finite for a valid source chromaticity.
        if g[0] > 0.0 && g[2] > 0.0 && g[0].is_finite() && g[2].is_finite() {
            g[0] / g[2]
        } else {
            // Tint railed into an unphysical region; use zero tint as a safe
            // fallback — the CCT bisection still converges on the gross shape.
            let g0 = wb_gains(c, 0.0);
            g0[0] / g0[2].max(1e-6)
        }
    };

    // Outer CCT bisection: rb_at_cct is monotone INCREASING in CCT
    // (low CCT = warm source → high R gain relative to B? No — warm source
    // has excess R, so gain[R] = D65/source is LOW and gain[B] is HIGH;
    // thus R/B is LOW at low CCT and HIGH at high CCT).
    // Direction: lo=2000 → lowest R/B; hi=25000 → highest R/B.
    let mut lo = 2000.0_f32;
    let mut hi = 25000.0_f32;
    let rb_lo = rb_at_cct(lo);
    let rb_hi = rb_at_cct(hi);
    let cct = if target_gain_rb <= rb_lo {
        lo // target is at or below the 2000 K floor
    } else if target_gain_rb >= rb_hi {
        hi // target is at or above the 25000 K ceiling
    } else {
        // Sign-based bisection: rb_lo < target < rb_hi → search for crossing.
        for _ in 0..20 {
            let mid = (lo + hi) * 0.5;
            if rb_at_cct(mid) < target_gain_rb {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (lo + hi) * 0.5
    };

    let tint = solve_tint_for_level(cct, target_r);
    (cct.clamp(2000.0, 25000.0), tint.clamp(-100.0, 100.0))
}

/// Bisect CCT in `[2000, 25000]` K so that `wb_gains(cct, tint).R / .B`
/// equals `target_rb`. `wb_gains` R/B is monotone increasing in CCT; targets
/// outside the boundary range clamp to the nearer rail.
fn bisect_cct_for_rb(target_rb: f32, tint: f32) -> f32 {
    let rb = |t: f32| {
        let g = wb_gains(t, tint);
        g[0] / g[2].max(1e-6)
    };
    let mut lo = 2000.0_f32;
    let mut hi = 25000.0_f32;
    if target_rb <= rb(lo) {
        return lo;
    }
    if target_rb >= rb(hi) {
        return hi;
    }
    for _ in 0..16 {
        let mid = (lo + hi) * 0.5;
        if rb(mid) < target_rb {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) * 0.5
}

/// Solve tint in `[-100, 100]` so the corrected R level
/// `wb_gains(cct, tint).R * target_r` equals 1 (no residual green/magenta
/// cast). `wb_gains` can become unphysical (non-positive R gain) at extreme
/// tint for low CCTs, so the search bounds are first shrunk inward to the
/// range where it stays valid; a root outside that range clamps to the nearer
/// rail. Orientation is read from the (valid) boundary values.
fn solve_tint_for_level(cct: f32, target_r: f32) -> f32 {
    let resid = |t: f32| -> Option<f32> {
        let g = wb_gains(cct, t);
        if g[0].is_finite() && g[0] > 0.0 {
            Some(g[0] * target_r - 1.0)
        } else {
            None
        }
    };
    // Shrink the [-100, 100] window to the sub-range where `wb_gains` is valid.
    let mut lo = -100.0_f32;
    while lo < 100.0 && resid(lo).is_none() {
        lo += 2.0;
    }
    let mut hi = 100.0_f32;
    while hi > lo && resid(hi).is_none() {
        hi -= 2.0;
    }
    let f_lo = match resid(lo) {
        Some(v) => v,
        None => return 0.0,
    };
    let f_hi = match resid(hi) {
        Some(v) => v,
        None => return 0.0,
    };
    if f_lo == 0.0 {
        return lo;
    }
    if f_hi == 0.0 {
        return hi;
    }
    // No sign change → green cast exceeds the slider; clamp to nearer rail.
    if f_lo.signum() == f_hi.signum() {
        return if f_lo.abs() < f_hi.abs() { lo } else { hi };
    }
    let increasing = f_hi > f_lo;
    for _ in 0..20 {
        let mid = (lo + hi) * 0.5;
        let f = match resid(mid) {
            Some(v) => v,
            None => break,
        };
        let lower_half = if increasing { f < 0.0 } else { f > 0.0 };
        if lower_half {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- estimate_cct_from_neutral tests (moved from raw-wasm) ----

    #[test]
    fn estimate_cct_neutral_at_d65_is_near_5500() {
        // [r=1, g=1, b=1] → log2(1) = 0 → 5500 K (D65 proxy).
        let cct = estimate_cct_from_neutral([1.0, 1.0, 1.0]);
        assert!((cct - 5500.0).abs() < 50.0, "got {}", cct);
    }

    #[test]
    fn estimate_cct_b_gt_r_neutral_is_higher_kelvin() {
        // B > R in neutral → source was COOL → higher CCT (slider calibration).
        // log2(B/R) > 0 → 5500 + positive offset → higher CCT. ✓
        let cct_b_gt_r = estimate_cct_from_neutral([0.5, 1.0, 0.8]); // B > R
        let cct_neutral = estimate_cct_from_neutral([1.0, 1.0, 1.0]);
        assert!(
            cct_b_gt_r > cct_neutral,
            "neutral with B>R should give higher CCT: got {} vs {}",
            cct_b_gt_r,
            cct_neutral
        );
    }

    #[test]
    fn estimate_cct_r_gt_b_neutral_is_lower_kelvin() {
        // R > B in neutral → source was WARM → lower CCT (slider calibration).
        // log2(B/R) < 0 → 5500 + negative offset → lower CCT. ✓
        let cct_r_gt_b = estimate_cct_from_neutral([0.8, 1.0, 0.5]); // R > B
        let cct_neutral = estimate_cct_from_neutral([1.0, 1.0, 1.0]);
        assert!(
            cct_r_gt_b < cct_neutral,
            "neutral with R>B should give lower CCT: got {} vs {}",
            cct_r_gt_b,
            cct_neutral
        );
    }

    #[test]
    fn estimate_cct_result_in_valid_range() {
        for n in [[0.4_f32, 1.0, 0.9], [0.9, 1.0, 0.5], [0.5, 1.0, 0.5]] {
            let cct = estimate_cct_from_neutral(n);
            assert!(
                cct >= 2000.0 && cct <= 12000.0,
                "neutral {:?}: CCT {} out of range",
                n,
                cct
            );
        }
    }

    #[test]
    fn estimate_cct_is_monotone_in_b_over_r() {
        // Increasing B/R → cooler source → higher CCT slider → monotone ↑.
        let ratios = [0.3_f32, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0];
        let mut prev = 0.0f32;
        for &ratio in &ratios {
            let cct = estimate_cct_from_neutral([1.0, 1.0, ratio]);
            assert!(
                cct > prev || prev == 0.0,
                "CCT not monotone at B/R={}: prev={}, got={}",
                ratio,
                prev,
                cct
            );
            prev = cct;
        }
    }

    // ---- neutral_to_temp_tint tests ----

    #[test]
    fn neutral_to_temp_tint_neutral_rgb_gives_near_d65() {
        // A perfectly neutral [1,1,1] means gain R/B = 1 → source ≈ D65 ≈ 6500K.
        let (t, tint) = neutral_to_temp_tint([1.0, 1.0, 1.0]);
        assert!(
            (t - 6500.0).abs() < 1000.0,
            "neutral [1,1,1] should give near-D65 (~6500K), got {} K",
            t
        );
        assert!(
            tint.abs() < 1.0,
            "perfectly neutral [1,1,1] should solve to ~0 tint, got {}",
            tint
        );
    }

    #[test]
    fn neutral_to_temp_tint_cool_neutral_higher_cct() {
        // B > R in neutral → COOL source illuminant → need WARM correction → higher CCT slider.
        // R > B in neutral → WARM source illuminant → need COOL correction → lower CCT slider.
        let (t_b_gt_r, _) = neutral_to_temp_tint([0.5, 1.0, 0.8]); // B > R: cool source
        let (t_r_gt_b, _) = neutral_to_temp_tint([0.8, 1.0, 0.5]); // R > B: warm source
        assert!(
            t_b_gt_r > t_r_gt_b,
            "B>R neutral should give higher CCT (cool source) than R>B: {} vs {}",
            t_b_gt_r,
            t_r_gt_b
        );
    }

    #[test]
    fn neutral_to_temp_tint_monotone_in_b_r_ratio() {
        // Higher B/R neutral → COOLER illuminant → HIGHER CCT slider (cool correction).
        // The target_gain_rb = B/R increases → bisection finds higher CCT. Monotone ↑.
        let b_values = [0.4_f32, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5];
        let mut prev = 0.0_f32;
        for &b in &b_values {
            let (cct, _) = neutral_to_temp_tint([0.7, 1.0, b]);
            assert!(
                cct > prev || prev == 0.0,
                "neutral_to_temp_tint not monotone at B={}: prev={}, got={}",
                b,
                prev,
                cct
            );
            prev = cct;
        }
    }

    #[test]
    fn neutral_to_temp_tint_result_in_valid_range() {
        let neutrals = [
            [0.4_f32, 1.0, 0.9],
            [0.9, 1.0, 0.5],
            [0.5, 1.0, 0.7],
            [1.0, 1.0, 1.0],
        ];
        for n in &neutrals {
            let (cct, tint) = neutral_to_temp_tint(*n);
            assert!(
                cct >= 2000.0 && cct <= 25000.0,
                "neutral {:?}: CCT {} out of range",
                n,
                cct
            );
            assert!(
                tint.abs() <= 100.0,
                "neutral {:?}: tint {} out of range",
                n,
                tint
            );
        }
    }

    #[test]
    fn neutral_to_temp_tint_round_trips_cct_and_tint() {
        // Inverse round-trip: a source at a known (cct, tint) produces the
        // neutral [1/g.R, 1, 1/g.B]; recovering it must return ≈ the original
        // pair. Validates BOTH the CCT and the new tint solve objectively.
        for &(cct, tint) in &[
            (6500.0_f32, 0.0_f32),
            (4000.0, 0.0),
            (8500.0, 0.0),
            (5200.0, 18.0),
            (5200.0, -18.0),
            (3600.0, 10.0),
            (9000.0, -12.0),
        ] {
            let g = wb_gains(cct, tint);
            let neutral = [1.0 / g[0], 1.0, 1.0 / g[2]];
            let (rc, rt) = neutral_to_temp_tint(neutral);
            assert!(
                (rc - cct).abs() < 500.0,
                "cct {} tint {} → recovered cct {}",
                cct,
                tint,
                rc
            );
            assert!(
                (rt - tint).abs() < 6.0,
                "cct {} tint {} → recovered tint {}",
                cct,
                tint,
                rt
            );
        }
    }
}
