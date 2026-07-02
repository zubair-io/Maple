//! Unit tests for [`super`] (the minimax monotone solver). Split out of
//! `solve.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;

/// Evaluate a band's mean output `Σ_a M[b][a]·curve(a_input)` for a fitted
/// curve, mirroring the design-matrix contract.
fn band_mean(design_row: &[f32; ANCHORS], curve: &ChannelCurve) -> f32 {
    // The design row weights anchor OUTPUTS directly; `curve.anchors[a].1`
    // is `out[a]`. Re-derive the output vector from the curve.
    (0..ANCHORS)
        .map(|a| design_row[a] * curve.anchors[a].1)
        .sum()
}

fn counts(all: usize) -> [usize; LUMA_BANDS.len()] {
    [all; LUMA_BANDS.len()]
}

/// A feasible, clearly monotone target set: each band's design row puts all
/// weight on a single distinct anchor, with strictly increasing targets.
/// The solver must hit every target near-exactly and stay monotone.
#[test]
fn hits_feasible_isolated_anchor_targets() {
    let anchors_used = [2usize, 9, 15, 22, 29];
    let targets = [0.10f32, 0.30, 0.50, 0.70, 0.90];
    let mut design = [[0.0f32; ANCHORS]; LUMA_BANDS.len()];
    for b in 0..LUMA_BANDS.len() {
        design[b][anchors_used[b]] = 1.0; // band mean == out[anchor]
    }
    let curve = solve_minimax_monotone(&design, &targets, &counts(1000));
    for b in 0..LUMA_BANDS.len() {
        let got = band_mean(&design[b], &curve);
        assert!(
            (got - targets[b]).abs() < 0.02,
            "band {b}: got {got}, want {}",
            targets[b]
        );
    }
    // Monotone non-decreasing anchors.
    for a in 1..ANCHORS {
        assert!(curve.anchors[a].1 >= curve.anchors[a - 1].1 - 1e-6);
    }
}

/// An infeasible target set: two bands share the SAME single anchor but
/// demand outputs 0.2 apart. No monotone curve can satisfy both; the
/// minimax solver must split the error to ~0.1 each (the LP optimum) rather
/// than letting one band absorb all of it.
#[test]
fn splits_error_on_shared_anchor_conflict() {
    let mut design = [[0.0f32; ANCHORS]; LUMA_BANDS.len()];
    // Only bands 0 and 1 have targets; both read anchor 10.
    design[0][10] = 1.0;
    design[1][10] = 1.0;
    let mut targets = [f32::NAN; LUMA_BANDS.len()];
    targets[0] = 0.40;
    targets[1] = 0.60;
    let mut c = counts(0);
    c[0] = 1000;
    c[1] = 1000;
    let curve = solve_minimax_monotone(&design, &targets, &c);
    let e0 = (band_mean(&design[0], &curve) - 0.40).abs();
    let e1 = (band_mean(&design[1], &curve) - 0.60).abs();
    let worst = e0.max(e1);
    assert!(
        (0.08..=0.12).contains(&worst),
        "expected ~0.1 minimax split, got e0={e0} e1={e1}"
    );
}

/// `footprint_sizes` returns 1 for an upscale (out larger than crop) — the
/// nearest-neighbour span that matches Pillow BOX on upscale — and the
/// integer area for a clean integer downscale.
#[test]
fn footprint_handles_up_and_downscale() {
    // Upscale 2×2 crop → 4×4 out: every footprint is 1.
    let up = footprint_sizes(2, 2, 4, 4);
    assert!(up.iter().all(|&f| f == 1), "upscale footprints must be 1");
    // Downscale 4×4 crop → 2×2 out: every footprint is 2×2 = 4.
    let down = footprint_sizes(4, 4, 2, 2);
    assert!(
        down.iter().all(|&f| f == 4),
        "downscale footprints must be 4"
    );
}

/// `band_index` replicates the gate's edge handling: half-open earlier
/// bands, closed final band (pure white stays in highlights).
#[test]
fn band_index_edges_match_gate() {
    assert_eq!(band_index(0.0), Some(0));
    assert_eq!(band_index(0.10), Some(1)); // boundary belongs to upper band
    assert_eq!(band_index(0.75), Some(4));
    assert_eq!(band_index(1.0), Some(4)); // last band closed
}
