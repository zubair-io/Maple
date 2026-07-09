//! Auto white-balance estimators: grey-world / white-patch CCT+tint solve.
//!
//! Extracted from `white_balance.rs` to keep that file within the 600-LOC
//! file-budget gate (#1468). Pure code move — no logic change.
//!
//! Re-exported from `white_balance` so existing call sites at
//! `crate::stages::white_balance::*` continue to compile unchanged.

use super::white_balance::{tint_perpendicular_axis, wb_gains, xy_to_uv, TINT_UV_SCALE};
use crate::math::Vec3;

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
    //  1. Outer bisection over CCT (20 steps, ~0.03 K resolution over the
    //     [2000, 25000] K range): For each candidate CCT, solve for the tint
    //     that brings the R level to 1 (`solve_tint_for_level`), then compute
    //     the resulting R/B.  We bisect CCT until that R/B matches
    //     target_rb.  The outer function is monotone INCREASING in CCT:
    //     a warmer (lower-CCT) source has excess R, so the correction
    //     gain[R] = D65/source is LOW and gain[B] is HIGH there, making R/B
    //     low at low CCT; a cooler (higher-CCT) source inverts that, making
    //     R/B high at high CCT. The residual `rb_at_cct(mid) - target_gain_rb`
    //     is therefore strictly increasing in CCT, which is what the
    //     bisection direction below assumes.
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

    // Outer CCT bisection: rb_at_cct is monotone INCREASING in CCT (see the
    // derivation in this function's doc-comment above).
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

/// Convert a scene illuminant's white point in CIE XYZ (Y-normalized to 1)
/// into `(temperature_k, tint)`, via the camera's OWN color matrix rather
/// than a generic Planckian model — see [`estimate_tint_from_scene_xyz`] for
/// the tint half. This module only provides the tint half; CCT is
/// `dcp::compute_as_shot_cct`'s existing camera-matrix-consistent iteration,
/// reused as-is (see `dcp::estimate_as_shot_cct_tint`, the combined entry
/// point).
///
/// # Why this exists, not `neutral_to_temp_tint` (#1725)
///
/// `neutral_to_temp_tint` solves for the (CCT, tint) whose `wb_gains`
/// correction neutralizes a measured G-normalized neutral — but `wb_gains`
/// is a FIXED, camera-agnostic Planckian-locus + CAT16/diagonal model. Fed a
/// camera-native `AsShotNeutral` (which encodes that SPECIFIC sensor's
/// spectral response, e.g. a Canon body reading `[0.47, 1, 0.65]` under
/// daylight), the achievable gain range of the generic model tops out around
/// `gain.R ≈ 1.38` (at the 25000 K / tint −100 extreme) — nowhere near the
/// `gain.R ≈ 2.13` a `[0.47, 1, 0.65]` neutral demands. The bisection in
/// `solve_tint_for_level` therefore rails to the −100 bound for essentially
/// EVERY realistic camera-native input: it isn't a bug in the bisection, the
/// target is simply outside the model's range.
///
/// # Why CCT is NOT re-derived from `scene_white_xyz` here
///
/// An earlier version of this function re-derived CCT from `scene_white_xyz`
/// via a generic nearest-point-on-Planckian-locus solve. That is WRONG:
/// `scene_white_xyz = normalize(inv(CM_at_converged_cct) · AsShotNeutral)` is
/// evaluated at `dcp::compute_as_shot_cct`'s SELF-CONSISTENT fixed point,
/// where `CM_at_converged_cct` is `interpolate_cm`'s reciprocal-CCT lerp
/// between this specific camera's two calibration illuminants — a
/// camera-specific curve, NOT the generic Hernández-Andrés Planckian locus
/// `cct_to_xy` describes. Measured against real fixtures (test_0000.DNG,
/// Hasselblad L3D-100c) the resulting `scene_white_xyz` can sit far from the
/// generic locus (`x,y ≈ 0.387, 0.260` vs. the generic locus's `y ≥ 0.29` at
/// any CCT in range) even though `compute_as_shot_cct`'s own converged CCT
/// (7472 K) is perfectly plausible daylight — re-deriving CCT via the
/// generic locus against that same XYZ gave 2354 K, wildly wrong. The ticket
/// (#1725) calls this out directly: "dcp.rs compute_as_shot_cct does the CCT
/// half — reuse." Only tint is genuinely absent from the existing DCP
/// machinery, so only tint is added here, using [`tint_perpendicular_axis`]
/// (the same forward-model axis `apply_tint_perpendicular` displaces along)
/// evaluated AT the already-resolved CCT — no second CCT solve, no locus
/// mismatch.
pub fn estimate_tint_from_scene_xyz(xyz: Vec3, cct: f32) -> f32 {
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum < 1e-6 {
        eprintln!(
            "[raw-core] white_balance_auto::estimate_tint_from_scene_xyz: \
             degenerate scene white XYZ {:?} (sum={}) — falling back to \
             tint 0 rather than an unfixable estimate.",
            xyz, sum
        );
        return 0.0;
    }
    let x = xyz[0] / sum;
    let y = xyz[1] / sum;
    let (u0, v0) = xy_to_uv(x, y);

    let (cx, cy) = super::white_balance::cct_to_xy(cct);
    let (cu, cv) = xy_to_uv(cx, cy);
    // The SLIDER convention's axis (`tint_sign_positive_v = false`) — the
    // same axis `wb_camera::target_xyz` and `white_balance::wb_gains`
    // displace along when they turn `model.tint` back into a chromaticity.
    // This estimate's whole purpose is producing values those forward paths
    // consume (the As-Shot slider seed, the tile-refine decoded anchor), so
    // it must project onto THEIR axis: pre-#1870 it projected onto the
    // opposite (`true`) axis, and every calibrated body's seeded As-Shot
    // init rendered with a 2×|tint| spurious cast — a heavy pink on
    // test_0002 (H2D-39), whose as-shot tint also sat past the old rail.
    let (perp_u, perp_v) = tint_perpendicular_axis(cct, false);
    // (u0,v0) - (cu,cv) is the displacement FROM the CCT's locus point TO
    // the measured chromaticity; its scalar projection onto the unit
    // perpendicular axis recovers the signed `tint * TINT_UV_SCALE` the
    // forward path (`apply_tint_perpendicular`, same `false` axis) would
    // apply to land exactly on the measured point when starting from this
    // same CCT.
    let du = u0 - cu;
    let dv = v0 - cv;
    let projected = du * perp_u + dv * perp_v;
    // Clamped to the slider's authored range (±150 — ACR's own crs:Tint
    // span, #1870). Reaching the clamp here is a real answer from the
    // geometry (a scene white very far from this CCT's locus point), not a
    // failure — so, unlike the degenerate-XYZ branch above, it is NOT
    // diagnosed.
    (projected / TINT_UV_SCALE).clamp(-150.0, 150.0)
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

    // ---- estimate_tint_from_scene_xyz tests (#1725) ----

    use super::super::white_balance::{apply_tint_perpendicular, cct_to_xy, xy_to_xyz};

    /// Forward-map a (CCT, tint) pair to a scene-white XYZ through the SAME
    /// model `estimate_tint_from_scene_xyz` inverts: `cct_to_xy` +
    /// `apply_tint_perpendicular` (slider convention — `tint_sign_positive_v
    /// = false`, matching the estimator's projection axis, #1870), then to
    /// XYZ Y-normalized to 1. This is the forward half of the round-trip
    /// property, independent of `wb_gains`/CAT16 matrix math entirely — it
    /// only exercises the chromaticity geometry the estimator itself uses.
    fn forward_scene_white_xyz(cct: f32, tint: f32) -> Vec3 {
        let (x, y) = cct_to_xy(cct);
        let (sx, sy) = apply_tint_perpendicular(x, y, cct, tint, false);
        xy_to_xyz(sx, sy, 1.0)
    }

    #[test]
    fn estimate_tint_round_trips_across_cct_and_tint_grid() {
        // Required property (#1725): a (CCT, tint) grid spanning the
        // documented estimator range forward-mapped to a scene white XYZ
        // (at the SAME cct — mirroring the real caller, which always
        // evaluates tint at the already-resolved `scene_cct`) and estimated
        // back must recover the SAME tint to within tight tolerance. This
        // is the property `neutral_to_temp_tint` fails catastrophically for
        // camera-native neutrals (every realistic input rails to
        // tint=-100) — estimating from `scene_white_xyz` (camera-matrix
        // derived) at a KNOWN cct instead of solving both jointly from a
        // raw neutral means there is no achievable-range mismatch to rail
        // against, and no cross-contamination between the cct and tint
        // solves.
        for &cct in &[2500.0_f32, 4000.0, 5500.0, 6500.0, 8000.0, 10000.0] {
            for &tint in &[-80.0_f32, -40.0, 0.0, 40.0, 80.0] {
                let xyz = forward_scene_white_xyz(cct, tint);
                let rt = estimate_tint_from_scene_xyz(xyz, cct);
                assert!(
                    (rt - tint).abs() <= 2.0,
                    "cct={} tint={}: recovered tint={} (want within 2)",
                    cct,
                    tint,
                    rt
                );
            }
        }
    }

    #[test]
    fn estimate_tint_d65_white_at_6500_is_near_zero() {
        // Anchor (#1725): a D65 scene white evaluated at 6500K should read
        // back |tint| ≈ 0 — the "camera is looking at exactly D65" case.
        let tint = estimate_tint_from_scene_xyz(crate::color::matrices::XYZ_D65, 6500.0);
        assert!(
            tint.abs() < 2.0,
            "D65 white should read back |tint|≈0, got {}",
            tint
        );
    }

    #[test]
    fn estimate_tint_never_pins_to_bound_for_realistic_daylight() {
        // Regression for the exact bug #1725 reports: a realistic
        // G-normalized AsShotNeutral run through the OLD generic-model path
        // (`neutral_to_temp_tint`) pinned tint at -100 for every daylight-ish
        // input because the achievable gain range of that model tops out
        // around gain.R≈1.38, far short of what a real camera's neutral
        // demands. The NEW estimator takes a scene-white XYZ (already
        // camera-matrix-resolved) evaluated at a known cct rather than a raw
        // neutral, so a physically-plausible daylight white point must NOT
        // rail.
        for &(cct, tint) in &[(5300.0_f32, 0.0), (6500.0, 5.0), (4500.0, -10.0)] {
            let xyz = forward_scene_white_xyz(cct, tint);
            let rt = estimate_tint_from_scene_xyz(xyz, cct);
            assert!(
                rt.abs() < 99.0,
                "cct={} tint={}: recovered tint {} looks pinned to a bound",
                cct,
                tint,
                rt
            );
        }
    }

    #[test]
    fn estimate_tint_degenerate_xyz_falls_back_without_panic() {
        // Property 3 (#1725): out-of-model inputs must return the
        // documented fallback, not silently pin at whatever a degenerate
        // divide-by-near-zero happens to produce.
        let tint = estimate_tint_from_scene_xyz([0.0, 0.0, 0.0], 6500.0);
        assert_eq!(tint, 0.0);
    }

    /// Fixture-gated anchor (#1725 requirement 2): test_0000.DNG's REAL
    /// decode-path `AsShotNeutral`, run through the SAME camera-matrix-aware
    /// path the develop chain uses (`dcp::estimate_as_shot_cct_tint` —
    /// the WB slider frame's `scene_cct`, tint from
    /// `estimate_tint_from_scene_xyz` evaluated at that cct against the
    /// frame's `inv(CM) · as_shot_neutral`), must land in a
    /// plausible range — NOT pinned at a bound for a spurious reason like
    /// the old `neutral_to_temp_tint(raw.as_shot_neutral)` path (which
    /// pinned tint=-100 for EVERY realistic camera-native input regardless
    /// of camera or scene, because the achievable gain range of its generic
    /// model is a hard ceiling far below what real sensors demand — see
    /// `estimate_tint_from_scene_xyz`'s module doc).
    ///
    /// Measured (2026-07, this exact fixture): 7472 K through the BUNDLE
    /// profile's frame pre-#1727, 5507.7 K through the DNG's own embedded
    /// dual-CM pair once #1727 re-anchored the slider frame on it (see
    /// `wb_camera::SliderFrame` — the embedded frame is the scale ACR's
    /// own slider reads for this DNG, and 5508 K is ordinary daylight,
    /// squarely inside the ticket's a-priori 4500-6500 K guess). The old
    /// bundle-frame reading also clamped tint at +100 (a real ≈0.0124
    /// uv-distance off-locus for that CM); the embedded frame's tint
    /// residual is what the assertion below bounds.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn estimate_as_shot_cct_tint_test_0000_dng_real_decode_path_is_plausible_daylight() {
        let path = crate::test_support::fixtures::require_raw("test_0000.DNG");
        let bytes = std::fs::read(&path).expect("read test_0000.DNG");
        let raw = crate::decode::decode_bytes(&bytes, "DNG").expect("decode test_0000.DNG");
        let (cct, tint) =
            crate::color::dcp::estimate_as_shot_cct_tint(&raw).expect("estimate as-shot cct/tint");
        assert!(
            (4500.0..=8500.0).contains(&cct),
            "test_0000.DNG as-shot CCT should be plausible daylight-ish (4500-8500K), got {}",
            cct
        );
        assert!(
            tint.abs() <= 100.0,
            "test_0000.DNG as-shot tint should be within the authored slider range, got {}",
            tint
        );
    }
}
