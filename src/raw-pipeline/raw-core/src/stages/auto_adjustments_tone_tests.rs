//! Synthetic-tier tests for the AUTO tone calibration (#1376).
//!
//! These pin the solver's algebra — that each inversion lands its target, that
//! the four bounds behave, that the histogram is log-binned, that the answer
//! scales with the deviation. The tier that actually gates the calibration is
//! the fixture tier in `auto_adjustments_tone_fixture_tests.rs`, which runs the
//! whole recommendation on the reference RAWs.
//!
//! Split into a sibling file under the 600-LOC file budget, same `#[path]`
//! pattern as `auto_adjustments_tests.rs`.

use super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A buffer whose luma percentiles are controllable: `lo` for the darkest
/// tenth, `hi` for the brightest tenth, `mid` everywhere between.
fn three_tone_image(lo: f32, mid: f32, hi: f32) -> Image {
    let mut img = Image::new(200, 200, ColorSpace::SceneLinearRec2020);
    let n = img.pixels.len();
    for (i, px) in img.pixels.iter_mut().enumerate() {
        let v = if i < n / 10 {
            lo
        } else if i >= n - n / 10 {
            hi
        } else {
            mid
        };
        *px = [v, v, v];
    }
    img
}

fn flat_image(v: f32) -> Image {
    three_tone_image(v, v, v)
}

/// Percentile vector standing in for a well-behaved daylight scene: p0.5 six
/// stops under mid-gray, p99.5 a bit over two stops above it.
fn typical_anchors() -> Anchors {
    Anchors {
        p005: 0.0028,
        p10: 0.030,
        p25: 0.070,
        p75: 0.40,
        p95: 0.75,
        p995: 0.95,
    }
}

// ---------------------------------------------------------------------------
// Log histogram — the M0 censoring bug
// ---------------------------------------------------------------------------

/// The linear `[0, 1]` histogram M0 used reports ≈ 1.0 for any percentile
/// landing above scene 1.0, so a frame with real specular highlights read back
/// as if it had none. The log histogram must recover the true value.
#[test]
fn log_histogram_resolves_percentiles_above_scene_one() {
    let img = three_tone_image(0.01, 0.2, 6.0);
    let h = LogLumaHistogram::build(&img);
    let p995 = h.percentile(0.995).expect("non-empty");
    assert!(
        (p995 - 6.0).abs() / 6.0 < 0.02,
        "p99.5 must resolve the 6.0 highlight, got {p995}"
    );
}

#[test]
fn log_histogram_percentiles_bracket_a_flat_field() {
    let h = LogLumaHistogram::build(&flat_image(0.18));
    for q in [0.005_f32, 0.5, 0.995] {
        let v = h.percentile(q).expect("non-empty");
        assert!(
            (v - 0.18).abs() / 0.18 < 0.02,
            "q={q} on a flat 0.18 field gave {v}"
        );
    }
}

#[test]
fn log_histogram_handles_non_positive_luma() {
    // Scene-referred buffers legitimately carry negatives out of upstream
    // stages; they must bin, not panic or poison the total.
    let img = three_tone_image(-0.05, 0.18, 0.5);
    let h = LogLumaHistogram::build(&img);
    let p005 = h.percentile(0.005).expect("non-empty");
    assert!(p005.is_finite() && p005 > 0.0, "got {p005}");
}

#[test]
fn empty_buffer_recommends_no_tone_change() {
    let img = Image::new(0, 0, ColorSpace::SceneLinearRec2020);
    assert_eq!(
        compute_auto_tone_sliders(&img, 0.0),
        AutoToneSliders::default()
    );
}

// ---------------------------------------------------------------------------
// Anchor transport
// ---------------------------------------------------------------------------

/// `scene_target` and `display_code` must be mutual inverses at slope 1 — if
/// they drift, every anchor is being solved against the wrong tone.
#[test]
fn scene_target_round_trips_through_display_code() {
    for code in [ANCHOR_P005, ANCHOR_P10, ANCHOR_P95, ANCHOR_P995] {
        let scene = scene_target(code, 1.0);
        let back = display_code(scene, 1.0);
        assert!(
            (back - code).abs() < 0.01,
            "code {code} → scene {scene} → code {back}"
        );
    }
}

/// The anchors must come back in a sane scene-linear order and straddle
/// mid-gray, or a sign error in the transport would silently invert the whole
/// calibration.
#[test]
fn anchors_are_ordered_and_straddle_mid_gray() {
    let s005 = scene_target(ANCHOR_P005, 1.0);
    let s10 = scene_target(ANCHOR_P10, 1.0);
    let s95 = scene_target(ANCHOR_P95, 1.0);
    let s995 = scene_target(ANCHOR_P995, 1.0);
    assert!(
        s005 < s10 && s10 < MID_GRAY && MID_GRAY < s95 && s95 < s995,
        "{s005} {s10} {MID_GRAY} {s95} {s995}"
    );
}

// ---------------------------------------------------------------------------
// Per-slider inversions land their anchor (undamped)
// ---------------------------------------------------------------------------

/// Each solve must land a target that lies INSIDE the slider's authority, to
/// the precision `SOLVE_ITERS` promises. Targets are expressed as a modest
/// multiple of the input luma so the test pins the INVERSION and stays
/// independent of whatever the anchor constants happen to be.
#[test]
fn every_solve_lands_a_reachable_target() {
    let cases: &[(&str, f32, f32, fn(f32, f32) -> f32)] = &[
        ("highlights", 1.4, 0.80, highlights_at),
        ("shadows", 0.012, 1.70, shadows_at),
        ("whites", 1.6, 1.20, whites_at),
        ("blacks", 0.010, 0.72, blacks_at),
    ];
    for (label, y, ratio, transfer) in cases {
        let target = y * ratio;
        let v = bisect(-100.0, 100.0, target, |s| transfer(*y, s));
        let out = transfer(*y, v);
        assert!(
            (out - target).abs() / target < 0.01,
            "{label}: slider {v} took {y} to {out}, wanted {target}"
        );
    }
}

/// The AUTHORITY CLAMP: when a slider cannot reach its anchor at the measured
/// luma, `solve_toward` must still return an INTERIOR value rather than run to
/// its endpoint. Endpoint saturation is what made every affected frame settle
/// on the same number — railing with a smaller value on it.
#[test]
fn solve_stays_interior_when_the_anchor_is_out_of_reach() {
    // Whites gains at most 1.5× and is EXACTLY the identity below luma 0.5, so
    // at y = 0.30 it has no authority at all. The solve must say "no opinion",
    // not run to an endpoint.
    assert_eq!(
        solve_toward(0.30, 0.99, whites_at),
        0.0,
        "a slider with no authority at this luma must return 0"
    );

    // Whites at luma 1.6 DOES have authority, but nowhere near enough to reach
    // display code 0.99. The solve must still land strictly inside its range.
    let v = solve_toward(1.6, 0.99, whites_at);
    assert!(
        v.abs() < 95.0,
        "solve must stay interior even for an unreachable anchor, got {v}"
    );
    assert!(
        v > 0.0,
        "and must still move in the right direction, got {v}"
    );
    assert!(settle(v).abs() < SOFT_LIMIT);
    assert!(SOFT_LIMIT < 50.0, "the soft limit must be far from railing");
}

/// The soft limit is an ASYMPTOTE, not a clamp: arbitrarily large input must
/// stay strictly inside it, and must not pile up on the boundary the way a
/// clamp does. This is the property that makes railing impossible rather than
/// merely capped.
#[test]
fn soft_limit_compresses_outliers_without_ever_exceeding_itself() {
    // Strictly INSIDE the limit across the whole range a solve can produce —
    // the solver's own bracket is ±100.
    for raw in [40.0_f32, 60.0, 100.0] {
        let v = settle(raw);
        assert!(v < SOFT_LIMIT, "settle({raw}) = {v} reached the limit");
    }
    // Monotone, and never exceeding the limit even for absurd input. `f32::tanh`
    // saturates to exactly 1.0 far out, so beyond the solver's range this is ≤.
    let mut previous = 0.0_f32;
    for raw in [50.0_f32, 200.0, 1_000.0, 1e6] {
        let v = settle(raw);
        assert!(v <= SOFT_LIMIT, "settle({raw}) = {v} exceeded the limit");
        assert!(
            v >= previous,
            "settle must be non-decreasing: {v} vs {previous}"
        );
        previous = v;
    }
    // …and small values pass through essentially unchanged (identity-like).
    assert!(
        (settle(6.0) - 6.0).abs() < 0.1,
        "a gentle recommendation must not be squashed: {}",
        settle(6.0)
    );
}

/// Contrast is the one slider whose target is a SPREAD rather than a point. It
/// must close exactly [`DAMP`] of the gap to the anchor — not the whole gap.
#[test]
fn contrast_solve_closes_half_the_midtone_spread_gap() {
    let a = typical_anchors();
    let spread_at = |c: f32| {
        let slope = 1.0 + (c / 100.0) * 0.5;
        display_code(a.p75, slope) - display_code(a.p25, slope)
    };
    let before = spread_at(0.0);
    let v = solve_contrast(a);
    let after = spread_at(v);
    let want =
        before + (DAMP * (ANCHOR_MID_SPREAD - before)).clamp(-MAX_ANCHOR_MOVE, MAX_ANCHOR_MOVE);
    assert!(
        (after - want).abs() < 0.01,
        "contrast {v} moved the spread {before} → {after}, wanted {want}"
    );
    assert!(
        (after - ANCHOR_MID_SPREAD).abs() > 0.01,
        "and must NOT close the whole gap: landed on {after} vs anchor {ANCHOR_MID_SPREAD}"
    );
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

/// A flat, low-contrast frame must get POSITIVE contrast; a punchy one
/// negative. This is the property M0's threshold made unreachable.
#[test]
fn contrast_engages_in_both_directions() {
    let flat = Anchors {
        p25: 0.15,
        p75: 0.22,
        ..typical_anchors()
    };
    let punchy = Anchors {
        p25: 0.02,
        p75: 1.6,
        ..typical_anchors()
    };
    let (c_flat, c_punchy) = (solve(flat).contrast, solve(punchy).contrast);
    assert!(
        c_flat > 0.0,
        "flat scene should gain contrast, got {c_flat}"
    );
    assert!(
        c_punchy < 0.0,
        "punchy scene should lose contrast, got {c_punchy}"
    );
}

/// A blown frame (highlights far above the anchor) must pull highlights and
/// whites DOWN; a murky one must push them up.
#[test]
fn endpoint_sliders_follow_the_scene() {
    let blown = Anchors {
        p95: 3.0,
        p995: 5.0,
        ..typical_anchors()
    };
    let murky = Anchors {
        p95: 0.30,
        p995: 0.34,
        ..typical_anchors()
    };
    assert!(solve(blown).highlights > 0.0, "blown frame must recover");
    assert!(solve(murky).highlights < 0.0, "murky frame must gain");
}

/// A frame whose shadows sit well above the anchor gets them crushed; a
/// frame with buried shadows gets them lifted.
#[test]
fn shadow_sliders_follow_the_scene() {
    let milky = Anchors {
        p005: 0.05,
        p10: 0.09,
        ..typical_anchors()
    };
    let buried = Anchors {
        p005: 0.0002,
        p10: 0.004,
        ..typical_anchors()
    };
    assert!(solve(milky).shadows < 0.0, "milky shadows must come down");
    assert!(solve(buried).shadows > 0.0, "buried shadows must come up");
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

#[test]
fn settle_deadbands_and_soft_limits() {
    assert_eq!(settle(1.5), 0.0, "1.5 is inside the deadband");
    assert!(
        (settle(6.0) - 6.0).abs() < 0.1,
        "a gentle solve must pass through, got {}",
        settle(6.0)
    );
    assert!(settle(400.0).abs() <= SOFT_LIMIT);
    assert!((settle(400.0) + settle(-400.0)).abs() < 1e-6, "must be odd");
    assert_eq!(settle(f32::NAN), 0.0);
    assert_eq!(settle(f32::INFINITY), 0.0);
}

/// The damped target is what keeps the answer SCENE-PROPORTIONAL. Frames whose
/// measured anchor sits at different distances from the population must get
/// different slider values — the failure mode of aiming at the full anchor was
/// that they all saturated and collapsed onto one number.
#[test]
fn slider_magnitude_scales_with_the_measured_deviation() {
    let near = Anchors {
        p10: 0.045,
        ..typical_anchors()
    };
    let far = Anchors {
        p10: 0.090,
        ..typical_anchors()
    };
    let farther = Anchors {
        p10: 0.150,
        ..typical_anchors()
    };
    let (a, b, c) = (
        solve(near).shadows,
        solve(far).shadows,
        solve(farther).shadows,
    );
    assert!(
        a > b && b > c,
        "shadows must decrease monotonically as p10 rises: {a}, {b}, {c}"
    );
    assert!(
        (a - b).abs() > 1.0 && (b - c).abs() > 1.0,
        "and the steps must be resolvable, not collapsed: {a}, {b}, {c}"
    );
}

/// Degenerate inputs are exactly where M0 railed. Nothing may leave the clamp,
/// and nothing may be non-finite.
#[test]
fn degenerate_scenes_stay_bounded_and_finite() {
    let cases: &[(&str, Anchors)] = &[
        (
            "all black",
            Anchors {
                p005: 0.0,
                p10: 0.0,
                p25: 0.0,
                p75: 0.0,
                p95: 0.0,
                p995: 0.0,
            },
        ),
        (
            "all clipped",
            Anchors {
                p005: 40.0,
                p10: 40.0,
                p25: 40.0,
                p75: 40.0,
                p95: 40.0,
                p995: 40.0,
            },
        ),
        (
            "single tone",
            Anchors {
                p005: 0.18,
                p10: 0.18,
                p25: 0.18,
                p75: 0.18,
                p95: 0.18,
                p995: 0.18,
            },
        ),
    ];
    for (name, a) in cases {
        let t = solve(*a);
        for (label, v) in [
            ("contrast", t.contrast),
            ("highlights", t.highlights),
            ("shadows", t.shadows),
            ("whites", t.whites),
            ("blacks", t.blacks),
        ] {
            assert!(v.is_finite(), "{name}/{label} = {v}");
            assert!(
                v.abs() < SOFT_LIMIT,
                "{name}/{label} = {v} reached the soft limit"
            );
        }
    }
}

/// Determinism — the recommendation is a pure function of the buffer.
#[test]
fn recommendation_is_deterministic() {
    let img = three_tone_image(0.004, 0.2, 2.0);
    assert_eq!(
        compute_auto_tone_sliders(&img, 0.3),
        compute_auto_tone_sliders(&img, 0.3)
    );
}

/// The exposure gain must reach the tone solve. Two calls differing ONLY in
/// the exposure recommendation must not produce the same tone sliders — the
/// tone bands are keyed on absolute scene luma, so a stop of exposure moves
/// every anchor through them.
#[test]
fn exposure_recommendation_feeds_the_tone_solve() {
    let img = three_tone_image(0.004, 0.2, 2.0);
    let at_zero = compute_auto_tone_sliders(&img, 0.0);
    let at_plus_two = compute_auto_tone_sliders(&img, 2.0);
    assert_ne!(
        at_zero, at_plus_two,
        "tone must be solved against the post-exposure histogram"
    );
}

#[cfg(test)]
#[path = "auto_adjustments_tone_fixture_tests.rs"]
mod fixtures;
