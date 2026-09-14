//! `whites` parameter tests for `view::agx::neutral_curve` — split out of
//! `agx.rs` to stay within the file's 570-line budget (Task 2,
//! `2026-09-11-whites-view-transform-remap`, ticket #3601).
//!
//! Declared as a sibling test module (`view/mod.rs`) rather than a `mod
//! tests` child of `agx.rs`, so it reaches `agx`'s items the same way any
//! other crate consumer would: through `crate::view::agx`'s public /
//! `pub(crate)` surface (`neutral_curve`, `lut`, `AGX_LUT_SIZE`,
//! `AGX_MAX_EV`, `AGX_MID_GRAY`, `AGX_MIN_EV`, `MID_NORM`) — no access to
//! `agx.rs`'s private `log_encode` / `sample_lut` helpers.

use crate::view::agx::{
    neutral_curve, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_GRAY, AGX_MIN_EV, MID_NORM,
};

/// Test-local copy of the OLD two-argument `neutral_curve` body
/// (`log_encode` → slope pivot → `sample_lut`), predating the `whites`
/// remap. `whites = 0` must match this bit-for-bit. Reimplements the two
/// private helpers inline (rather than reusing `agx::neutral_curve` itself)
/// so the test is an independent check, not a tautology.
fn neutral_curve_reference(y_scene: f32) -> f32 {
    // log_encode, inlined.
    let floor = AGX_MID_GRAY * AGX_MIN_EV.exp2();
    let clamped = y_scene.max(floor);
    let log_v = (clamped / AGX_MID_GRAY)
        .log2()
        .clamp(AGX_MIN_EV, AGX_MAX_EV);
    let norm = (log_v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    let modulated = MID_NORM + (norm - MID_NORM) * 1.0;
    // sample_lut, inlined.
    let l = crate::view::agx::lut();
    let x = modulated.clamp(0.0, 1.0);
    let idx = x * ((AGX_LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(AGX_LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    l[i0] * (1.0 - f) + l[i1] * f
}

#[test]
fn whites_zero_matches_the_two_argument_baseline_bit_for_bit() {
    for y in [0.001f32, 0.04, 0.18, 0.5, 1.0, 4.0] {
        assert_eq!(neutral_curve(y, 1.0, 0.0), neutral_curve_reference(y));
    }
}

#[test]
fn whites_plus_100_lifts_mid_grey_by_at_least_twenty_lstar() {
    let lstar = |d: f32| {
        if d > 0.008856 {
            116.0 * d.cbrt() - 16.0
        } else {
            903.3 * d
        }
    };
    let base = lstar(neutral_curve(0.18, 1.0, 0.0));
    let lifted = lstar(neutral_curve(0.18, 1.0, 100.0));
    assert!(lifted - base >= 20.0, "mid-grey moved {} L*", lifted - base);
}

#[test]
fn whites_minus_100_leaves_deep_shadow_untouched_but_moves_mid_grey_slightly() {
    // Deep shadow / near-black is still identity: `WHITES_NEG_LO` (0.505 in
    // normalised-log space) sits well above black, so these tones fall
    // outside the negative branch's ramp entirely. Fragile margin: y=0.05
    // encodes to log_encode(0.05) ~= 0.494, only ~0.011 below
    // WHITES_NEG_LO=0.505 -- a future retune of WHITES_NEG_LO downward past
    // ~0.494 would silently break this identity assertion for y=0.05.
    for y in [0.01f32, 0.05] {
        assert_eq!(
            neutral_curve(y, 1.0, -100.0),
            neutral_curve(y, 1.0, 0.0),
            "y={y}"
        );
    }
    // Mid-grey is NOT untouched under the bump-form design: unlike the old
    // form (which pivoted the negative branch exactly at MID_NORM),
    // `WHITES_NEG_LO` sits below `MID_NORM`, so whites=-100 does move
    // mid-grey a little — this matches the real ACR data, which showed a
    // smooth, monotonically-growing compression with no flat identity
    // plateau below the top (see `agx_whites.rs`'s module doc).
    let lstar = |d: f32| {
        if d > 0.008856 {
            116.0 * d.cbrt() - 16.0
        } else {
            903.3 * d
        }
    };
    let base = lstar(neutral_curve(0.18, 1.0, 0.0));
    let shifted = lstar(neutral_curve(0.18, 1.0, -100.0));
    let delta = shifted - base;
    assert!(
        (delta - (-2.9897)).abs() < 0.1,
        "expected mid-grey to shift by about -2.99 L* at whites=-100, got {delta}"
    );
    assert!(neutral_curve(2.0, 1.0, -100.0) < neutral_curve(2.0, 1.0, 0.0));
}

#[test]
fn whites_and_contrast_compose_monotonically() {
    for (slope, w) in [
        (1.5f32, 100.0f32),
        (0.5, 100.0),
        (1.5, -100.0),
        (0.5, -100.0),
    ] {
        let mut prev = neutral_curve(0.0005, slope, w);
        for i in 1..400 {
            let y = 0.0005 * 1.03f32.powi(i);
            let v = neutral_curve(y, slope, w);
            assert!(
                v >= prev - 1e-7,
                "slope={slope} w={w} non-monotone at y={y}"
            );
            prev = v;
        }
    }
}
