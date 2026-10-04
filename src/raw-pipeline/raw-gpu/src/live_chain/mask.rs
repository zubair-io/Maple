//! The live pool's active-stage bitmask (`active_mask`), split out of
//! `live_chain.rs` to keep that module inside the file-size budget (same split
//! shape as `noop` / `signature`). Single-sourced with the builder: every bit
//! uses the exact same predicate the corresponding `if` in `build_live_split`
//! uses, so the mask can't disagree with which passes actually get pushed.

use super::noop::{scene_tone_is_noop, tone_curves_is_noop, wb_is_noop, SLIDER_EPS};
use crate::auto_profile_curve::profile_curve_is_active;
use crate::color_grade::color_grade_is_identity;
use crate::display_tone_curve::display_tone_curve_is_identity;
use crate::full_chain::{hsl_pass_for, FullChainInputs, InputShape};
use crate::local_adjustments::local_adjustments_are_active;
use crate::residual_lut::residual_lut_is_active;

// Compile-time guard: `active_mask` packs `input_shape` into the top 2 bits
// of a u32 (shift left by 30). That encoding supports at most 4 variants
// (discriminants 0–3). If a 5th variant (discriminant 4) is ever added, the
// shift would produce a value with bit 32 set, which is out-of-range for u32
// in debug (overflow panic) or silently truncated in release. The assert below
// turns that scenario into a compile error with a clear message instead.
// There is no `const fn` way to iterate an enum's discriminants in stable Rust,
// so we assert on the known highest discriminant value directly.
const _: () = assert!(
    InputShape::SrgbGammaEncoded8 as u32 <= 3,
    "InputShape has a variant with discriminant > 3; active_mask's 2-bit \
     `input_shape` pack in the top 2 bits of u32 (shift 30) would overflow. \
     Widen the encoding or increase the shift before adding a 5th variant."
);

/// The active-stage bitmask — which gated passes [`build_live_split`](super::build_live_split) includes
/// for `inputs`, one bit per gated stage (the ungated view-tail core — `agx`,
/// `display_encode`, `srgb_gamma` — always runs, so it isn't represented).
/// SINGLE-SOURCED with the builder: every bit uses the exact same predicate
/// the corresponding `if` in `build_live_split` uses, so the mask can't
/// disagree with which passes actually get pushed. Used by
/// [`chain_signature`](super::chain_signature) to key the live pool's bind-group cache.
pub(super) fn active_mask(inputs: &FullChainInputs) -> u32 {
    let mut m = 0u32;
    let is_raw_shape = inputs.input_shape == InputShape::PostDcpRec2020Fp16;
    // Encode input_shape in the top 2 bits of the mask so a shape change lands
    // in a fresh pool bucket (different passes = different bind-group layouts).
    // The 2-bit mask `& 0b11` is defensive: variant values 0/1/2 are safe, but
    // a future 4th variant (discriminant 3) would still fit; variant 4 (next
    // power of two) would shift into bit 32 and overflow a u32 in debug mode
    // (silent truncation in release). The mask guarantees correctness today and
    // turns any future out-of-range discriminant into a collision (detectable)
    // rather than UB. See also the compile-time assert below.
    m |= ((inputs.input_shape as u32) & 0b11) << 30;
    // Bit 0: capture_sharpening — RAW-only (#1331); always 0 for non-RAW shapes.
    if is_raw_shape && inputs.capture_sharpening.is_some() {
        m |= 1 << 0;
    }
    // Bit 1: WB — engaged for ALL shapes when the slider is outside the skip
    // band (the builder now includes WB unconditionally for non-RAW too).
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        m |= 1 << 1;
    }
    if !scene_tone_is_noop(&inputs.tone) {
        m |= 1 << 2;
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        m |= 1 << 3;
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        m |= 1 << 4;
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        m |= 1 << 5;
    }
    if !hsl_pass_for(inputs).is_noop() {
        m |= 1 << 15;
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        m |= 1 << 6;
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        m |= 1 << 7;
    }
    if inputs.dehaze.abs() >= SLIDER_EPS {
        m |= 1 << 8;
    }
    if local_adjustments_are_active(&inputs.local_adjustments, inputs.scope.layer) {
        m |= 1 << 16;
    }
    // Bit 19: defringe (#3411) — same predicate as the `build_live_split`
    // gate above. Only presence changes the dispatch/bind-group shape (the
    // six sliders ride a fixed-size params uniform), so no content hash is
    // folded in.
    if inputs.defringe.is_engaged() {
        m |= 1 << 19;
    }
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        m |= 1 << 9;
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        m |= 1 << 10;
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        m |= 1 << 11;
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        m |= 1 << 12;
    }
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        m |= 1 << 13;
    }
    if !color_grade_is_identity(&crate::full_chain::color_grade_sliders(inputs)) {
        m |= 1 << 14;
    }
    // Bit 17: film look (epic #2683, Task 7) — same predicate as the
    // `build_live_split` gate (loaded LUT + engaged strength).
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        m |= 1 << 17;
    }
    // Bit 18: display-referred tone curves (#2232) — same predicate as the
    // `build_live_split` gate above. Fixed-stride pooled buffer (NUM_SLOTS ×
    // SLOT_STRIDE, like `tone_curves`'), so no extra content-hash fold is
    // needed below — only presence changes the dispatch/bind-group shape.
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        m |= 1 << 18;
    }
    // Bits 20/21: Auto Profile look — the EXACT `build_live_split` gate
    // predicates (RAW shape + per-artifact presence). A Neutral→Auto fit
    // arriving mid-session changes the dispatch sequence, so it must land in
    // a fresh pool bucket. (The LUT edge is additionally folded into
    // `chain_signature` for its variable pooled-buffer size, #1079.)
    if is_raw_shape && profile_curve_is_active(&inputs.profile_curve_flat) {
        m |= 1 << 20;
    }
    if is_raw_shape && residual_lut_is_active(inputs.residual_lut_size, &inputs.residual_lut_data) {
        m |= 1 << 21;
    }
    m
}
