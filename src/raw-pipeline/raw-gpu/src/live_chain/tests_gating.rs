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

use super::tests::{neutral_case, run_live_chain, TEST_SESSION_ID};
use super::*;
use crate::dehaze::AirlightSource;

#[test]
fn manual_geometry_is_the_final_live_pass_and_reuses_pool_shape() {
    use raw_core::{
        image::{ColorSpace, Image},
        stages::geometry::{self, Geometry},
    };
    let mut inputs = neutral_case().gpu_inputs();
    let identity_signature = chain_signature(&inputs, (16, 12), TEST_SESSION_ID);
    let input: Vec<f32> = (0..192)
        .flat_map(|i| [i as f32 / 192.0, 0.2, 0.4, 1.0])
        .collect();
    let base = run_live_chain(&input, 16, 12, &inputs);
    let mut reference = Image::new(16, 12, ColorSpace::DisplayEncodedSrgb);
    for (pixel, p) in reference.pixels.iter_mut().zip(base.chunks_exact(4)) {
        *pixel = [p[0], p[1], p[2]];
    }
    let inverse = Geometry {
        rotation: 8.0,
        perspective_v: 0.1,
        ..Geometry::default()
    }
    .forward(16, 12)
    .unwrap()
    .inverse()
    .unwrap();
    geometry::apply(&mut reference, inverse, &mut vec![]);
    inputs.geometry_inverse = Some(inverse.0);
    let geometry_signature = chain_signature(&inputs, (16, 12), TEST_SESSION_ID);
    assert_ne!(identity_signature, geometry_signature);
    let output = run_live_chain(&input, 16, 12, &inputs);
    let error = reference
        .pixels
        .iter()
        .zip(output.chunks_exact(4))
        .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
        .fold(0.0_f32, f32::max);
    assert!(
        error < 1e-4,
        "live geometry differed from encoded CPU tail: {error}"
    );
    inputs.geometry_inverse = Some(
        Geometry {
            rotation: 12.0,
            ..Geometry::default()
        }
        .forward(16, 12)
        .unwrap()
        .inverse()
        .unwrap()
        .0,
    );
    assert_eq!(
        geometry_signature,
        chain_signature(&inputs, (16, 12), TEST_SESSION_ID)
    );
}

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
    let raw_inputs = case.gpu_inputs();
    let raw_passes = build_live_chain(&raw_inputs, AirlightSource::Cpu([0.0; 3]));
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

/// Film-look gating (epic #2683, Task 7): a neutral case's default
/// `FullChainInputs` carries NO film LUT (`film_lut_size == 0`,
/// `film_strength == 0.0`) — the pass-count floor must stay unchanged from
/// every other neutral-case gate. Loading a LUT AND engaging strength adds
/// EXACTLY one pass; the active-mask bit (17) flips with it, so a strength
/// crossing the gate threshold lands in a fresh pool bucket.
#[test]
fn film_look_default_off_loaded_and_engaged_adds_one_pass() {
    let case = neutral_case();

    // Default inputs: no LUT loaded, strength 0 — pass count must be the
    // bare neutral view tail, same as every other still-off gate in this
    // file.
    let default_inputs = case.gpu_inputs();
    assert_eq!(default_inputs.film_lut_size, 0);
    assert_eq!(default_inputs.film_strength, 0.0);
    let default_passes = build_live_chain(&default_inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        default_passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "default (unloaded) film LUT must not add a pass"
    );

    // A loaded LUT (size > 0) but strength 0 must STILL be omitted — the
    // strength gate, not just the presence gate, decides inclusion.
    let mut loaded_but_zero = case.gpu_inputs();
    loaded_but_zero.film_lut_size = 5;
    loaded_but_zero.film_lut_data = vec![0.0f32; 5 * 5 * 5 * 3].into();
    let passes_zero = build_live_chain(&loaded_but_zero, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes_zero.len(),
        VIEW_TAIL_PASS_COUNT,
        "a loaded LUT at strength 0 must not add a pass"
    );

    // Loaded AND engaged: exactly one pass added.
    let mut engaged = case.gpu_inputs();
    engaged.film_lut_size = 5;
    engaged.film_lut_key = 42;
    engaged.film_lut_data = vec![0.0f32; 5 * 5 * 5 * 3].into();
    engaged.film_strength = 65.0;
    let passes_on = build_live_chain(&engaged, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes_on.len(),
        VIEW_TAIL_PASS_COUNT + 1,
        "a loaded + engaged film LUT must add exactly one pass"
    );

    // active_mask / chain_signature: engaging film look must change the
    // signature vs the default (bit 17 flips), and a DIFFERENT film_lut_key
    // at the same strength/size must ALSO change it (content-identity fold).
    let sig_default = chain_signature(&default_inputs, (8, 8), TEST_SESSION_ID);
    let sig_engaged = chain_signature(&engaged, (8, 8), TEST_SESSION_ID);
    assert_ne!(
        sig_default, sig_engaged,
        "signature must differ once film look crosses the gate threshold"
    );

    drop(passes_on);
    let mut engaged_other_look = engaged;
    engaged_other_look.film_lut_key = 7;
    let sig_other_look = chain_signature(&engaged_other_look, (8, 8), TEST_SESSION_ID);
    assert_ne!(
        sig_engaged, sig_other_look,
        "a different film_lut_key at the same mask/size must land in a fresh bucket"
    );
}
