#![cfg(test)]
//! Sibling of `tests_live_parity.rs` (#1732 leg (c)), split out for the
//! file-size budget. Two tests that are not part of the parameterised
//! model sweep:
//!
//! 1. the IDENTITY half of the contract — at the decode anchor both paths
//!    must reproduce the decode buffer itself, which is the exact shape of
//!    the 2026-07-02 WB band bug this ticket exists because of;
//! 2. the one stage class that does NOT satisfy the contract, pinned as a
//!    known-gap ceiling rather than hidden by loosening the sweep's budgets.

use super::tests_live_parity::{agreement, Harness, MIN_CASE_EFFECT};
use crate::xmp::AdjustmentModel;

/// With the slider parked AT the decode anchor, both paths must reproduce
/// the decode buffer. Before #1725 the tile path applied `resolve_wb` + an
/// ABSOLUTE `apply` here, so an unedited open of a non-D65 body rendered the
/// tile shifted away from the live frame — a visible horizontal band where
/// refined tiles met the live canvas.
///
/// A strictly stronger claim than the sweep's: agreement with a THIRD buffer,
/// not just with each other. Two paths that had both drifted the same way
/// would satisfy the sweep and fail here.
#[test]
fn live_and_tile_are_both_identity_at_the_decode_anchor() {
    let h = Harness::new();
    let model = super::tests_live_parity::decode_model(h.anchor);

    let live = h.live(&model);
    let tile = h.tile(&model);

    let live_vs_decoded = agreement(&live, &h.decoded_tile, &h.decoded_tile);
    let tile_vs_decoded = agreement(&tile, &h.decoded_tile, &h.decoded_tile);
    eprintln!(
        "at-anchor identity: live max_abs {:.3e}, tile max_abs {:.3e}",
        live_vs_decoded.max_abs, tile_vs_decoded.max_abs
    );
    // The live chain's WB step short-circuits to exact identity when target
    // == anchor and every other stage in `model` is neutral, so this side is
    // bit-exact, not merely close.
    assert_eq!(
        live_vs_decoded.max_abs, 0.0,
        "the live chain must be a bit-exact no-op at the decode anchor"
    );
    // The tile side re-derives the pixels from the mosaic through its own
    // demosaic + DCP retarget, so it lands within float agreement rather
    // than bit-exactly. The ceiling is ~8x its measured value and three
    // orders of magnitude below the pre-#1725 absolute-WB shift it guards.
    assert!(
        tile_vs_decoded.max_abs <= 1.0e-3,
        "the tile path must reproduce the decode buffer at the decode anchor \
         (this is the 2026-07-02 WB band): max abs diff {:.4e}",
        tile_vs_decoded.max_abs
    );
}

/// **KNOWN GAP — #2476.** `highlights` / `shadows` run as masked passes whose
/// detail-mask blur radius is `sh_mask_blur_radius(long_edge)` of *the buffer
/// the stage was handed*, not of the full image. The live chain is handed a
/// viewport; the tile chain is handed a crop padded by `TILE_OVERLAP_PX`. So
/// the two compute different mask radii and render differently — across the
/// whole tile interior, not just at its seam.
///
/// This is a STAGE defect (a full-frame anchor that was never threaded, the
/// same class as `vignette`, which the tile entry refuses outright per #11),
/// not a defect in the live-vs-tile chain contract the sweep gates. It is
/// pinned here instead of folded into that sweep because the ceiling it needs
/// is ~100x looser than every other case's — one shared budget that
/// accommodated it would stop gating the rest.
///
/// The assertion is an upper bound only, so #2476's fix (which drives the
/// divergence toward the sweep's numbers) passes this test rather than
/// breaking it. What it catches is the gap getting WORSE.
#[test]
fn masked_highlights_shadows_diverge_on_the_buffer_anchored_mask() {
    let h = Harness::new();
    let model = AdjustmentModel {
        temperature: h.anchor.0,
        tint: h.anchor.1,
        highlights: -40.0,
        shadows: 35.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: crate::xmp::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };

    let a = agreement(&h.live(&model), &h.tile(&model), &h.decoded_tile);
    eprintln!(
        "[known gap #2476] masked highlights/shadows live-vs-tile: max_abs \
         {:.3e}, max_ratio_dev {:.3e} (case moved the image by {:.3e})",
        a.max_abs, a.max_ratio_dev, a.moved
    );

    assert!(
        a.moved > MIN_CASE_EFFECT,
        "case moved the image by only {:.3e} (< {:.3e}) — the ceiling below \
         would mean nothing",
        a.moved,
        MIN_CASE_EFFECT
    );
    assert!(
        a.max_abs <= 5.0e-2,
        "the #2476 highlights/shadows mask gap has WIDENED: max abs diff \
         {:.4e} > 5.0e-2",
        a.max_abs
    );
    assert!(
        a.max_ratio_dev <= 2.0e-1,
        "the #2476 highlights/shadows mask gap has WIDENED: max channel-ratio \
         deviation {:.4e} > 2.0e-1",
        a.max_ratio_dev
    );
}
