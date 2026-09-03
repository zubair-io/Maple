#![cfg(test)]
//! Sibling of `tests_live_parity.rs` (#1732 leg (c)), split out for the
//! file-size budget: the IDENTITY half of the contract — at the decode
//! anchor both paths must reproduce the decode buffer itself, which is the
//! exact shape of the 2026-07-02 WB band bug this ticket exists because of.
//!
//! This file also used to pin the one stage class that did NOT satisfy the
//! contract — the buffer-anchored highlights/shadows detail mask — as a
//! known-gap ceiling. #2476 anchored that mask to the full frame, and the
//! case now lives in the sweep proper at the same ceilings as every other
//! stage class.

use super::tests_live_parity::{agreement, Harness};

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
