//! The live pool's active-stage bitmask (`active_mask`), split out of
//! `live_chain.rs` to keep that module inside the file-size budget (same split
//! shape as `noop` / `signature`). Single-sourced with the builder: every bit
//! uses the exact same predicate the corresponding `if` in `build_live_split`
//! uses, so the mask can't disagree with which passes actually get pushed.

use super::noop::{scene_tone_is_noop, tone_curves_is_noop, wb_is_noop, SLIDER_EPS};
use crate::auto_profile_curve::profile_curve_is_active;
use crate::color_curves::color_curves_is_identity;
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

/// One bit per gated pass in [`active_mask`]; bits 30–31 carry the input
/// shape. Every flag must be its own bit: two passes sharing one would let a
/// toggle of either leave `chain_signature` unchanged while the pass list
/// changes, and the frame pool would then replay the wrong bind groups.
pub(super) mod bit {
    pub(super) const CAPTURE_SHARPENING: u32 = 1 << 0;
    pub(super) const WHITE_BALANCE: u32 = 1 << 1;
    pub(super) const SCENE_TONE: u32 = 1 << 2;
    pub(super) const TONE_CURVES: u32 = 1 << 3;
    pub(super) const VIBRANCE: u32 = 1 << 4;
    pub(super) const SATURATION: u32 = 1 << 5;
    pub(super) const CLARITY: u32 = 1 << 6;
    pub(super) const TEXTURE: u32 = 1 << 7;
    pub(super) const DEHAZE: u32 = 1 << 8;
    pub(super) const VIGNETTE: u32 = 1 << 9;
    pub(super) const SHARPEN: u32 = 1 << 10;
    pub(super) const NR_LUMINANCE: u32 = 1 << 11;
    pub(super) const NR_COLOR: u32 = 1 << 12;
    pub(super) const GRAIN: u32 = 1 << 13;
    pub(super) const COLOR_GRADE: u32 = 1 << 14;
    pub(super) const HSL: u32 = 1 << 15;
    pub(super) const LOCAL_ADJUSTMENTS: u32 = 1 << 16;
    pub(super) const FILM_LOOK: u32 = 1 << 17;
    pub(super) const DISPLAY_TONE_CURVE: u32 = 1 << 18;
    pub(super) const DEFRINGE: u32 = 1 << 19;
    pub(super) const PROFILE_CURVE: u32 = 1 << 20;
    pub(super) const RESIDUAL_LUT: u32 = 1 << 21;
    pub(super) const COLOR_CURVES: u32 = 1 << 22;
    pub(super) const WB_HUE_SAT_MAP: u32 = 1 << 23;

    pub(super) const ALL: [u32; 24] = [
        CAPTURE_SHARPENING,
        WHITE_BALANCE,
        SCENE_TONE,
        TONE_CURVES,
        VIBRANCE,
        SATURATION,
        CLARITY,
        TEXTURE,
        DEHAZE,
        VIGNETTE,
        SHARPEN,
        NR_LUMINANCE,
        NR_COLOR,
        GRAIN,
        COLOR_GRADE,
        HSL,
        LOCAL_ADJUSTMENTS,
        FILM_LOOK,
        DISPLAY_TONE_CURVE,
        DEFRINGE,
        PROFILE_CURVE,
        RESIDUAL_LUT,
        COLOR_CURVES,
        WB_HUE_SAT_MAP,
    ];
}

const _: () = {
    let mut seen = 0u32;
    let mut i = 0;
    while i < bit::ALL.len() {
        assert!(bit::ALL[i].count_ones() == 1, "a pass flag must be one bit");
        assert!(
            seen & bit::ALL[i] == 0,
            "two passes share an active_mask bit"
        );
        assert!(bit::ALL[i] < 1 << 30, "bits 30-31 carry the input shape");
        seen |= bit::ALL[i];
        i += 1;
    }
};

/// The active-stage bitmask — which gated passes [`build_live_split`](super::build_live_split) includes
/// for `inputs`, one bit per gated stage (the ungated view-tail core — `agx`,
/// `display_encode`, `srgb_gamma` — always runs, so it isn't represented).
/// SINGLE-SOURCED with the builder: every bit uses the exact same predicate
/// the corresponding `if` in `build_live_split` uses, so the mask can't
/// disagree with which passes actually get pushed. Used by
/// [`chain_signature`](super::chain_signature) to key the live pool's bind-group cache.
pub(crate) fn active_mask(inputs: &FullChainInputs) -> u32 {
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
        m |= bit::CAPTURE_SHARPENING;
    }
    // Bit 1: WB — engaged for ALL shapes when the slider is outside the skip
    // band (the builder now includes WB unconditionally for non-RAW too).
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        m |= bit::WHITE_BALANCE;
        // The HueSatMap variant binds a fourth (table) buffer (#5099).
        if inputs.wb_hsm.is_some() {
            m |= bit::WB_HUE_SAT_MAP;
        }
    }
    if !scene_tone_is_noop(&inputs.tone) {
        m |= bit::SCENE_TONE;
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        m |= bit::TONE_CURVES;
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        m |= bit::VIBRANCE;
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        m |= bit::SATURATION;
    }
    if !hsl_pass_for(inputs).is_noop() {
        m |= bit::HSL;
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        m |= bit::CLARITY;
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        m |= bit::TEXTURE;
    }
    if inputs.dehaze.abs() >= SLIDER_EPS {
        m |= bit::DEHAZE;
    }
    if local_adjustments_are_active(&inputs.local_adjustments, inputs.scope.layer) {
        m |= bit::LOCAL_ADJUSTMENTS;
    }
    // Bit 19: defringe (#3411) — same predicate as the `build_live_split`
    // gate above. Only presence changes the dispatch/bind-group shape (the
    // six sliders ride a fixed-size params uniform), so no content hash is
    // folded in.
    if inputs.defringe.is_engaged() {
        m |= bit::DEFRINGE;
    }
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        m |= bit::VIGNETTE;
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        m |= bit::SHARPEN;
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        m |= bit::NR_LUMINANCE;
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        m |= bit::NR_COLOR;
    }
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        m |= bit::GRAIN;
    }
    if !color_grade_is_identity(&crate::full_chain::color_grade_sliders(inputs)) {
        m |= bit::COLOR_GRADE;
    }
    // Bit 17: film look (epic #2683, Task 7) — same predicate as the
    // `build_live_split` gate (loaded LUT + engaged strength).
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        m |= bit::FILM_LOOK;
    }
    // Bit 18: display-referred tone curves (#2232) — same predicate as the
    // `build_live_split` gate above. Fixed-stride pooled buffer (NUM_SLOTS ×
    // SLOT_STRIDE, like `tone_curves`'), so no extra content-hash fold is
    // needed below — only presence changes the dispatch/bind-group shape.
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        m |= bit::DISPLAY_TONE_CURVE;
    }
    // Bits 20/21: Auto Profile look — the EXACT `build_live_split` gate
    // predicates (RAW shape + per-artifact presence). A Neutral→Auto fit
    // arriving mid-session changes the dispatch sequence, so it must land in
    // a fresh pool bucket. (The LUT edge is additionally folded into
    // `chain_signature` for its variable pooled-buffer size, #1079.)
    if is_raw_shape && profile_curve_is_active(&inputs.profile_curve_flat) {
        m |= bit::PROFILE_CURVE;
    }
    if is_raw_shape && residual_lut_is_active(inputs.residual_lut_size, &inputs.residual_lut_data) {
        m |= bit::RESIDUAL_LUT;
    }
    if !color_curves_is_identity(&inputs.color_curves) {
        m |= bit::COLOR_CURVES;
    }
    m
}
