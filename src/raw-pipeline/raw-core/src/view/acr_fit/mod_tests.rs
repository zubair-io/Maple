//! Unit tests for [`super::compute_overlap_rms_rel`] using synthetic
//! [`NeutralSample`] vectors — bypasses the render/patch pipeline entirely so
//! the seam-selection logic is tested in isolation.
use super::*;

/// Build a run of `NeutralSample`s covering `x_lo..=x_hi` where the display
/// value follows the linear rule `y = slope * x`, so `fit_tonescale` recovers
/// an (almost) exact reproduction of `slope` and any offset between two
/// sample sets shows up directly as `overlap_rms_rel`.
fn linear_run(x_lo: f32, x_hi: f32, slope: f32, n: usize) -> Vec<NeutralSample> {
    (0..n)
        .map(|i| {
            let t = i as f32 / (n - 1) as f32;
            let x = x_lo + t * (x_hi - x_lo);
            NeutralSample {
                scene_lum: x,
                display_lum: slope * x,
            }
        })
        .collect()
}

/// Two renders (2-render case, unchanged behaviour): matching slopes in the
/// overlap ⇒ near-zero rms; a slope mismatch ⇒ rms clearly above 5%.
#[test]
fn two_renders_detects_seam_mismatch() {
    let ts = model::Tonescale {
        knots_log2: vec![],
        values: vec![],
    };

    // Both renders span the FULL knot range (0.001..4.0) so every knot is
    // populated with real (not flat-extrapolated) data on both sides of the
    // overlap — isolating the seam-mismatch signal from binning/extrapolation
    // artifacts of a narrow sample range.
    let clean = vec![
        linear_run(0.001, 4.0, 1.0, 64),
        linear_run(0.001, 4.0, 1.0, 64),
    ];
    let rms_clean = compute_overlap_rms_rel(&clean, &ts).expect("overlap exists");
    assert!(
        rms_clean < 0.01,
        "matching slopes across the seam should be ~0, got {rms_clean}"
    );

    let mismatched = vec![
        linear_run(0.001, 4.0, 1.0, 64),
        linear_run(0.001, 4.0, 1.20, 64), // +20% slope in the second render
    ];
    let rms_mismatched = compute_overlap_rms_rel(&mismatched, &ts).expect("overlap exists");
    assert!(
        rms_mismatched > 0.05,
        "a 20% slope mismatch across the seam should exceed the 5% warning \
         threshold, got {rms_mismatched}"
    );
}

/// Regression test for a bug where `compute_overlap_rms_rel` took
/// `non_empty[0]` and `non_empty[1]` — the first two non-empty renders in
/// ORIGINAL ARRAY ORDER — as "the" pair, instead of considering every
/// adjacent pair after sorting all renders by median x.
///
/// Renders A and C are built from the identical full-range (0.001..4.0)
/// sample set — they agree exactly, by construction, wherever they're
/// compared. Render B covers the same range but with a +30% slope, so it
/// disagrees with both A and C. Insertion order is (A, C, B) — deliberately
/// NOT sorted by median x. The buggy code reads `non_empty[0]=A` and
/// `non_empty[1]=C` straight off the input array, compares two IDENTICAL
/// sample sets, and reports exactly `0.0` — completely missing B. The fix
/// evaluates every adjacent pair in the (median-x-sorted) array and keeps
/// the maximum, so B's disagreement with its neighbour surfaces regardless
/// of where it sits in the input array.
#[test]
fn three_renders_surfaces_a_deep_seam_mismatch_even_when_the_shallow_seam_matches() {
    let ts = model::Tonescale {
        knots_log2: vec![],
        values: vec![],
    };

    let render_a = linear_run(0.001, 4.0, 1.0, 64);
    let render_c = linear_run(0.001, 4.0, 1.0, 64);
    let render_b = linear_run(0.001, 4.0, 1.30, 64); // uniform → middle median x, +30% slope vs A/C

    // Insertion order is (A, C, B) — deliberately NOT sorted by median x.
    // The buggy code would compare `non_empty[0]=A` against `non_empty[1]=C`
    // (the two agreeing renders) and never look at B at all.
    let per_render = vec![render_a, render_c, render_b];

    let rms = compute_overlap_rms_rel(&per_render, &ts).expect("some pair overlaps");
    assert!(
        rms > 0.05,
        "B disagrees with its neighbours by 30%; the max-over-all-adjacent-\
         pairs-after-sorting-by-median-x metric must exceed the 5% warning \
         threshold even though the first two array elements (A, C) agree \
         exactly, got {rms}"
    );
}

/// A single non-empty render (or all renders too short to fit a tonescale)
/// yields `None`, not a spurious pair comparison.
#[test]
fn fewer_than_two_usable_renders_returns_none() {
    let ts = model::Tonescale {
        knots_log2: vec![],
        values: vec![],
    };
    let only_one = vec![linear_run(0.1, 1.0, 1.0, 24)];
    assert!(compute_overlap_rms_rel(&only_one, &ts).is_none());

    let one_empty = vec![linear_run(0.1, 1.0, 1.0, 24), vec![]];
    assert!(compute_overlap_rms_rel(&one_empty, &ts).is_none());
}
