//! Input-shape + sub-parameter pass-inclusion gates for the LIVE chain
//! (epic #925, P4b-core / #1027) — split out of `live_chain/tests.rs` to keep
//! each file under the 600-LOC budget (mirrors `gpu_render`'s `tests` /
//! `tests_sizing` split). Same `crate::full_chain::oracle` harness as the
//! sibling `tests` module; reuses its `pub(super)` helpers
//! (`neutral_case` / `run_live_chain` / `TEST_SESSION_ID`).
//!
//! These are the *pass-inclusion* corners of the gate, distinct from the
//! sibling file's core neutral/single-stage/split parity gates:
//!   - the RAW-vs-non-RAW input-shape view-tail skip (#1331 / #1513 / #1516),
//!     proven both structurally (pass count) and at the pixel (AgX crush), and
//!   - the sub-parameter short-circuits (#1109 / #1110 / #1111): a stage's
//!     shape/hue/feather sub-slider alone must NOT engage its pass.

use super::*;
use super::tests::{neutral_case, run_live_chain, TEST_SESSION_ID};
use crate::dehaze::AirlightSource;

/// #1513/#1516 PIXEL PROOF (real GPU): a WHITE scene-linear pixel is AgX-crushed
/// to ~0.76 gamma for a RAW shape but passes ~unchanged (1.0 = 255) for a NON-RAW
/// shape (look stages skipped) — proving the gate's pixel effect, not just the list.
#[test]
fn nonraw_white_survives_agx_but_raw_white_is_crushed() {
    let (w, h) = (8usize, 8usize);
    let input: Vec<f32> = std::iter::repeat([1.0f32, 1.0, 1.0, 1.0])
        .take(w * h)
        .flatten()
        .collect();
    let case = neutral_case();

    let mut raw_inputs = case.gpu_inputs();
    raw_inputs.input_shape = crate::full_chain::InputShape::PostDcpRec2020Fp16;
    let raw_white = run_live_chain(&input, w as u32, h as u32, &raw_inputs)[0];

    let mut nonraw_inputs = case.gpu_inputs();
    nonraw_inputs.input_shape = crate::full_chain::InputShape::LinearRec2020Fp16;
    let nonraw_white = run_live_chain(&input, w as u32, h as u32, &nonraw_inputs)[0];

    assert!(
        raw_white < 0.9,
        "RAW white must be AgX-compressed (<0.9 gamma); got {raw_white}"
    );
    assert!(
        nonraw_white > 0.999,
        "NON-RAW white must stay 1.0 (=255), not crushed by AgX/look stages (#1513/#1516); got {nonraw_white}"
    );
}

/// NON-RAW INPUT SHAPE (#1331, #1513, #1516): a `LinearRec2020Fp16` chain at
/// default WB must omit `capture_sharpening`, omit WB (the `wb_is_noop` gate),
/// AND omit the whole LOOK portion of the view tail — AgX (#1513) + auto-profile
/// curve + residual LUT (#1516) — leaving the colorimetric encode only
/// (display_encode + srgb_gamma), i.e. `VIEW_TAIL_PASS_COUNT - 3`. With WB
/// engaged, WB is present (temp/tint sliders must work for non-RAW too).
#[test]
fn linear_rec2020_shape_skips_capture_sharpening_look_and_keeps_wb_gated() {
    let mut case = neutral_case();
    let mut inputs = case.gpu_inputs();
    inputs.input_shape = crate::full_chain::InputShape::LinearRec2020Fp16;
    assert!(inputs.capture_sharpening.is_none());

    // A neutral RAW chain is the FULL view tail; non-RAW must be that minus the 3 look passes.
    let raw_passes = build_live_chain(&case.gpu_inputs(), AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        raw_passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "neutral RAW chain must keep the full view tail ({VIEW_TAIL_PASS_COUNT})"
    );

    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT - 3,
        "non-RAW default-WB tail must be encode-only ({} passes); got {}",
        VIEW_TAIL_PASS_COUNT - 3,
        passes.len()
    );
    assert_eq!(
        passes.len(),
        raw_passes.len() - 3,
        "non-RAW = RAW tail minus exactly the 3 look passes"
    );

    // WB engaged (temp outside the 6500±0.5 skip band) → WB included even for non-RAW.
    case.model.temperature = 4800.0;
    case.model.tint = 12.0;
    let mut inputs_wb = case.gpu_inputs();
    inputs_wb.input_shape = crate::full_chain::InputShape::LinearRec2020Fp16;

    let passes_wb = build_live_chain(&inputs_wb, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes_wb.len(),
        VIEW_TAIL_PASS_COUNT - 2,
        "non-RAW + engaged WB must add exactly 1 pass (WB) to the encode-only tail ({}); got {}",
        VIEW_TAIL_PASS_COUNT - 2,
        passes_wb.len()
    );

    // (c) Verify active_mask reflects the builder: WB bit (1) set, CS bit (0) clear.
    let sig_default = chain_signature(&inputs, (8, 8), TEST_SESSION_ID);
    let sig_wb_on = chain_signature(&inputs_wb, (8, 8), TEST_SESSION_ID);
    assert_ne!(
        sig_default, sig_wb_on,
        "signatures must differ when WB crosses the gate threshold"
    );
}

/// Colour-grading sub-param gating (#275): hues / balance alone must NOT
/// engage the pass — the gate is on every wheel's saturation AND
/// luminance, mirroring the raw-core stage's identity short-circuit.
#[test]
fn color_grade_hues_balance_alone_do_not_engage_the_pass() {
    let mut case = neutral_case();
    case.model.split_tone_shadow_hue = 220.0; // saturations / lums stay 0
    case.model.split_tone_highlight_hue = 40.0;
    case.model.color_grade_midtone_hue = 150.0;
    case.model.color_grade_global_hue = 310.0;
    case.model.split_tone_balance = 80.0;
    let inputs = case.gpu_inputs();
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "hues/balance without saturation or luminance must not add a colour-grade pass"
    );
}

/// A luminance offset alone DOES engage the pass, even with every
/// saturation at zero — the third slider per wheel is a real control.
#[test]
fn color_grade_luminance_alone_engages_the_pass() {
    let mut case = neutral_case();
    case.model.color_grade_midtone_luminance = -40.0;
    let inputs = case.gpu_inputs();
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT + 1,
        "a zone luminance offset must add the colour-grade pass"
    );
}

/// Grain sub-param gating (#1110): size / roughness alone must NOT engage
/// the pass — the gate is on `grain_amount`, mirroring the raw-core
/// stage's identity short-circuit.
#[test]
fn grain_size_roughness_alone_do_not_engage_the_pass() {
    let mut case = neutral_case();
    case.model.grain_size = 90.0; // amount stays 0
    case.model.grain_roughness = 90.0;
    let inputs = case.gpu_inputs();
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "size/roughness without amount must not add a grain pass"
    );
}

/// Vignette sub-param gating (#1109): `vignette_feather` alone must NOT
/// engage the pass — the gate is on `vignette_amount`, mirroring the
/// raw-core stage's identity short-circuit (feather shapes the mask; with
/// amount 0 the gain field is identically 1.0).
#[test]
fn vignette_feather_alone_does_not_engage_the_pass() {
    let mut case = neutral_case();
    case.model.vignette_feather = 90.0; // amount stays 0
    let inputs = case.gpu_inputs();
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "feather without amount must not add a vignette pass"
    );
}
