//! Whites as a white-point remap inside the AgX view transform (plan:
//! `docs/superpowers/plans/2026-09-11-whites-view-transform-remap.md`;
//! ticket #3601).
//!
//! `crs:Whites2012` in Adobe's renderer behaves like moving the white point of
//! the tone curve. Measured 2026-09-13 directly from the committed ACR
//! reference renders (`test-fixtures/references/test_NNNN/down/whites_{max,min}.png`
//! vs `baseline.png`), binned by input L* in 5-point steps across all 18
//! fixtures with references: `whites=+100` is a BUMP — near-zero at L*5,
//! rising to a broad +26 to +27 plateau around L*50-65, decaying back to
//! +5.7 at L*95. `whites=-100` is a smooth, monotonically-growing
//! compression — -0.06 at L*5 growing to -9.9 near L*90, with tight
//! cross-fixture agreement. A uniform log-domain stretch (the form this
//! module used before 2026-09-13) cannot reproduce the bump: ACR lifts
//! midtones roughly 2x harder than the top-5% band on 18/18 fixtures
//! (ratio 1.6-11x, median ~2.1), while a uniform stretch lifts both almost
//! equally (ratio 0.9-1.6x) — a shape mismatch no choice of stretch
//! constant closes.
//!
//! This module works on AgX's normalised log coordinate `n ∈ [0, 1]`
//! (`agx::log_encode`), between the log encode and the contrast slope:
//!
//! * `whites > 0`: a BUMP-weighted displacement,
//!   `bump(n) = smoothstep(LO_P, MID_P, n) · (1 − smoothstep(MID_P, HI_P, n))`,
//!   `n' = n + WHITES_POS_AMP · (whites/100) · bump(n)`. `bump` is exactly 0
//!   outside `(LO_P, HI_P)`, so both deep shadow and the very top are
//!   untouched; it peaks exactly at `MID_P` (value 1.0), where the rising
//!   half (`smoothstep(LO_P, MID_P, n)`) has just saturated to 1 and the
//!   falling half (`smoothstep(MID_P, HI_P, n)`) has not yet engaged.
//!   Monotonicity: on `(MID_P, HI_P)` the rising half is pinned at 1, so
//!   `bump = 1 − smoothstep(MID_P, HI_P, n)` there, and a cubic-Hermite
//!   smoothstep's slope is `6·t·(1−t)/(e1−e0)` (`t` the normalised
//!   position), maximised at `t=0.5` to `1.5/(e1−e0)` — so `d(bump)/dn`'s
//!   minimum is the closed form `−1.5/(HI_P−MID_P) = −1.5/0.34 = −4.411765`,
//!   occurring at `n = MID_P + (HI_P−MID_P)/2 = 0.90`. Requiring
//!   `1 + WHITES_POS_AMP·d(bump)/dn > 0` gives `WHITES_POS_AMP <
//!   1/4.411765 ≈ 0.226667`; 0.20 keeps a ~11.8% margin.
//! * `whites < 0`: a single-rising-smoothstep-weighted compression,
//!   `ramp(n) = smoothstep(LO_N, HI_N, n)`,
//!   `n' = n − WHITES_NEG_AMT · (−whites/100) · ramp(n)`. Monotonicity:
//!   `d(ramp)/dn` has a maximum of ≈ 2.246, so `1 − WHITES_NEG_AMT·d(ramp)/dn
//!   > 0` requires `WHITES_NEG_AMT < 1/2.246 ≈ 0.445`; 0.159 keeps a ~64%
//!   margin.
//!
//! Both weights are cubic-Hermite smoothsteps, so neither branch has a
//! closed-form inverse; `remap_norm(·, whites)` is strictly monotonic for
//! any fixed `whites` (proven by the bounds above and confirmed by a dense
//! sweep of `whites ∈ [-100,100]` × `n ∈ [-0.05,1.15]`), so `unremap_norm`
//! inverts by bisection. This is never on the per-pixel render path — only
//! `agx_inverse`'s callers (auto-tone anchor solving, inpaint roundtrip,
//! `display_u8_to_scene_linear`) use it — so the iteration cost is free.
//!
//! Mirrored verbatim in `raw-gpu/src/agx.wgsl` (`agx_whites_remap`) and the
//! CPU oracle in `raw-gpu/src/agx.rs`.

/// Positive-branch bump weight: identity at and below this normalised-log
/// position.
pub const WHITES_POS_LO: f32 = 0.46;
/// Positive-branch bump weight: the smoothstep pivot between the rising and
/// falling half.
pub const WHITES_POS_MID: f32 = 0.73;
/// Positive-branch bump weight: identity at and above this normalised-log
/// position.
pub const WHITES_POS_HI: f32 = 1.07;
/// Positive-branch displacement amplitude at `whites = +100`. MUST stay
/// below the monotonicity ceiling documented in the module doc (~0.226667
/// for the LO/MID/HI above).
pub const WHITES_POS_AMP: f32 = 0.20;

/// Negative-branch ramp weight: identity at and below this normalised-log
/// position.
pub const WHITES_NEG_LO: f32 = 0.505;
/// Negative-branch ramp weight: fully engaged at and above this
/// normalised-log position (may exceed 1.0 — the ramp then just never fully
/// saturates within the valid `n ∈ [0,1]` domain, matching the real data's
/// lack of a plateau).
pub const WHITES_NEG_HI: f32 = 1.173;
/// Negative-branch displacement amplitude at `whites = -100`. MUST stay
/// below the monotonicity ceiling documented in the module doc (~0.445 for
/// the LO/HI above).
pub const WHITES_NEG_AMT: f32 = 0.159;

/// Cubic-Hermite smoothstep, matching `stages::scene_tone_controls::smoothstep`'s
/// definition (duplicated here so this module has no dependency on `stages::*`).
#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Forward remap of a normalised-log value for slider `whites ∈ [−100, 100]`.
#[inline]
pub fn remap_norm(norm: f32, whites: f32) -> f32 {
    if whites.abs() < 1e-3 {
        return norm;
    }
    if whites > 0.0 {
        let amp = WHITES_POS_AMP * (whites / 100.0);
        let bump = smoothstep(WHITES_POS_LO, WHITES_POS_MID, norm)
            * (1.0 - smoothstep(WHITES_POS_MID, WHITES_POS_HI, norm));
        norm + amp * bump
    } else {
        let mag = -whites / 100.0;
        let ramp = smoothstep(WHITES_NEG_LO, WHITES_NEG_HI, norm);
        norm - WHITES_NEG_AMT * mag * ramp
    }
}

/// Exact inverse of [`remap_norm`] by bisection — `remap_norm(·, whites)` is
/// strictly monotonic for any fixed `whites` (see the module doc's
/// monotonicity bounds), so this converges to a unique root. Not on the
/// per-pixel render path; 50 iterations over a padded bracket is cheap and
/// gives far more precision than callers need.
#[inline]
pub fn unremap_norm(remapped: f32, whites: f32) -> f32 {
    if whites.abs() < 1e-3 {
        return remapped;
    }
    let mut lo = -1.0f32;
    let mut hi = 2.0f32;
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if remap_norm(mid, whites) < remapped {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_bit_identity() {
        for i in 0..=512 {
            let n = i as f32 / 512.0;
            assert_eq!(remap_norm(n, 0.0), n, "n={n}");
        }
    }

    #[test]
    fn positive_identity_at_and_below_lo() {
        for i in 0..=512 {
            let n = (i as f32 / 512.0) * WHITES_POS_LO;
            assert_eq!(remap_norm(n, 100.0), n, "n={n}");
        }
        // Exact boundary too.
        assert_eq!(remap_norm(WHITES_POS_LO, 100.0), WHITES_POS_LO);
        // A range of magnitudes, not just the +100 rail.
        for &w in &[10.0f32, 50.0, 100.0] {
            assert_eq!(
                remap_norm(WHITES_POS_LO * 0.5, w),
                WHITES_POS_LO * 0.5,
                "w={w}"
            );
        }
    }

    #[test]
    fn negative_identity_at_and_below_lo() {
        for i in 0..=512 {
            let n = (i as f32 / 512.0) * WHITES_NEG_LO;
            assert_eq!(remap_norm(n, -100.0), n, "n={n}");
        }
        // Exact boundary too.
        assert_eq!(remap_norm(WHITES_NEG_LO, -100.0), WHITES_NEG_LO);
        // A range of magnitudes, not just the -100 rail.
        for &w in &[-10.0f32, -50.0, -100.0] {
            assert_eq!(
                remap_norm(WHITES_NEG_LO * 0.5, w),
                WHITES_NEG_LO * 0.5,
                "w={w}"
            );
        }
    }

    #[test]
    fn positive_bump_peaks_exactly_at_mid() {
        // Derived from `remap_norm` itself (not a re-declared copy of the
        // smoothstep formula): at whites=100, remap_norm(n,100) - n =
        // WHITES_POS_AMP * bump(n), so a real transcription error in
        // `remap_norm` would fail this test.
        let bump = |n: f32| (remap_norm(n, 100.0) - n) / WHITES_POS_AMP;
        let samples = 4000;
        let lo_scan = WHITES_POS_LO - 0.1;
        let hi_scan = WHITES_POS_HI + 0.1;
        let mut peak_n = lo_scan;
        let mut peak_v = f32::MIN;
        for i in 0..=samples {
            let n = lo_scan + (hi_scan - lo_scan) * i as f32 / samples as f32;
            let v = bump(n);
            assert!(v >= -1e-6, "bump negative at n={n}: {v}");
            if n <= WHITES_POS_LO || n >= WHITES_POS_HI {
                assert!(v.abs() < 1e-5, "bump not ~0 outside (LO,HI) at n={n}: {v}");
            }
            if v > peak_v {
                peak_v = v;
                peak_n = n;
            }
        }
        // The bump peaks exactly at MID_P (value 1.0): the rising half
        // (smoothstep(LO_P,MID_P,n)) saturates to 1 there, and the falling
        // half (smoothstep(MID_P,HI_P,n)) has not yet engaged -- see the
        // module doc's monotonicity derivation.
        let grid_step = (hi_scan - lo_scan) / samples as f32;
        assert!(
            (peak_n - WHITES_POS_MID).abs() < 2.0 * grid_step,
            "bump peak at n={peak_n} (value {peak_v}) is not close to MID_P={}",
            WHITES_POS_MID
        );
        assert!(
            (peak_v - 1.0).abs() < 1e-3,
            "bump peak value {peak_v} is not close to 1.0"
        );
    }

    #[test]
    fn strictly_monotone_across_the_whole_slider_range() {
        // The remap's displacement is linear in `whites` (both `amp` and
        // `mag` are simple linear scalings of a fixed bump/ramp shape), so
        // the worst-case slope for any `whites` value is bounded by the two
        // rails (+-100); the intermediate magnitudes here are a sanity check
        // on that linearity, not additional worst-case coverage.
        let whites_values = [-100.0f32, -75.0, -50.0, -25.0, 25.0, 50.0, 75.0, 100.0];
        let samples = 5000;
        let lo = -0.05f32;
        let hi = 1.15f32;
        for &w in &whites_values {
            let mut prev = remap_norm(lo, w);
            for i in 1..=samples {
                let n = lo + (hi - lo) * i as f32 / samples as f32;
                let v = remap_norm(n, w);
                assert!(
                    v > prev,
                    "w={w} not strictly increasing at n={n}: {prev} -> {v}"
                );
                prev = v;
            }
        }
    }

    #[test]
    fn inverse_round_trips_to_1e_5() {
        let whites_values = [-100.0f32, -40.0, 30.0, 100.0];
        for &w in &whites_values {
            for i in 0..=512 {
                let n = i as f32 / 512.0;
                let r = remap_norm(n, w);
                let back = unremap_norm(r, w);
                assert!((back - n).abs() < 1e-5, "w={w} n={n} r={r} back={back}");
            }
        }
    }

    #[test]
    fn positive_amp_respects_the_monotonicity_bound() {
        // Derived from `remap_norm` (not a re-declared copy of the
        // smoothstep formula) via a dense finite-difference sweep of
        // d(bump)/dn, so a real transcription error in `remap_norm` would
        // fail this test too. The true minimum is the closed form
        // `-1.5/(WHITES_POS_HI-WHITES_POS_MID)` (see the module doc); this
        // sweep independently confirms it without hard-coding that literal.
        let bump = |n: f32| (remap_norm(n, 100.0) - n) / WHITES_POS_AMP;
        let h = 1e-4f32;
        let samples = 50_000;
        let lo_scan = WHITES_POS_LO - 0.1;
        let hi_scan = WHITES_POS_HI + 0.1;
        let mut min_slope = f32::MAX;
        for i in 0..=samples {
            let n = lo_scan + (hi_scan - lo_scan) * i as f32 / samples as f32;
            let d = (bump(n + h) - bump(n - h)) / (2.0 * h);
            if d < min_slope {
                min_slope = d;
            }
        }
        assert!(
            min_slope < 0.0,
            "expected a negative minimum slope for the bump, got {min_slope}"
        );
        let ceiling = 1.0 / (-min_slope);
        assert!(
            (0.20..0.24).contains(&ceiling),
            "computed ceiling {ceiling} drifted far from the closed-form ~0.226667 (-1.5/(HI_P-MID_P))"
        );
        // Not just bare feasibility (`AMP < ceiling`): require at least a
        // 10% safety margin below the ceiling, matching the documented
        // ~11.8% margin `WHITES_POS_AMP` actually keeps.
        assert!(
            WHITES_POS_AMP < 0.9 * ceiling,
            "WHITES_POS_AMP={WHITES_POS_AMP} must stay at least 10% below the computed monotonicity ceiling {ceiling} (min slope {min_slope})"
        );
    }

    #[test]
    fn negative_amt_respects_the_monotonicity_bound() {
        // Same idea as above, for the negative branch's ramp weight: its
        // slope is single-signed (a rising smoothstep), so the maximum
        // slope sets the ceiling (1 - WHITES_NEG_AMT * max_slope > 0).
        // Derived from `remap_norm` itself, same reasoning as the positive
        // branch's test above.
        let ramp = |n: f32| (n - remap_norm(n, -100.0)) / WHITES_NEG_AMT;
        let h = 1e-4f32;
        let samples = 50_000;
        let lo_scan = WHITES_NEG_LO - 0.1;
        let hi_scan = WHITES_NEG_HI + 0.1;
        let mut max_slope = f32::MIN;
        for i in 0..=samples {
            let n = lo_scan + (hi_scan - lo_scan) * i as f32 / samples as f32;
            let d = (ramp(n + h) - ramp(n - h)) / (2.0 * h);
            if d > max_slope {
                max_slope = d;
            }
        }
        assert!(
            max_slope > 0.0,
            "expected a positive maximum slope for the ramp, got {max_slope}"
        );
        let ceiling = 1.0 / max_slope;
        assert!(
            (0.35..0.55).contains(&ceiling),
            "computed ceiling {ceiling} drifted far from the design note's ~0.445"
        );
        // Not just bare feasibility: require at least a 10% safety margin
        // below the ceiling, matching the documented ~64% margin
        // `WHITES_NEG_AMT` actually keeps.
        assert!(
            WHITES_NEG_AMT < 0.9 * ceiling,
            "WHITES_NEG_AMT={WHITES_NEG_AMT} must stay at least 10% below the computed monotonicity ceiling {ceiling} (max slope {max_slope})"
        );
    }
}
