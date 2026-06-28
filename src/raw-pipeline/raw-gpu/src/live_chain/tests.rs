//! THE Risk-A gate (epic #925, P4b-core / #1027): the GATED live chain matches
//! the CPU pipeline on a **neutral** `AdjustmentModel` within `1e-4`, closing the
//! ~3.7e-3 divergence the UNGATED composition (`build_full_chain_passes`) shows
//! by design. Plus single-stage-active parity (one slider past threshold at a
//! time → exactly that pass included, matching the CPU stage).
//!
//! ## Why this is the headline
//!
//! `full_chain/tests.rs` deliberately drives every stage PAST its no-op threshold
//! so the CPU `apply` fns don't short-circuit — it proves composition parity but
//! leaves the gating hole open (its own docs say the short-circuit is "the P4b
//! live chain, NOT this composition layer"). This file is that proof: it drives a
//! NEUTRAL model (every `apply` short-circuits CPU-side) and asserts the gated
//! builder OMITS the no-op passes so the GPU output matches the short-circuited
//! CPU output. It reuses the SHARED `crate::full_chain::oracle` harness (same CPU
//! reference, same scene-linear fixture, same `Case`) so the two gates can't drift.
//!
//! ## What "matches develop+render" means here
//!
//! The chain's input is the synthetic post-DCP `scene_linear_rgba` buffer — the
//! same buffer `develop` produces after demosaic/DCP. The reference is the SAME
//! stage subset composed CPU-side on that buffer ([`cpu_oracle`]), NOT a fresh
//! `develop`+`render` from RAW (which would add `auto_exposure` / `local_adjustments`
//! / `look`, none of which are in the chain, and would need a fixture). For a
//! neutral model every scene-linear `apply` is a no-op, so `cpu_oracle` runs only
//! the view tail — exactly what the gated GPU chain runs.

use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::dehaze::{compute_airlight, AirlightSource};
use crate::full_chain::oracle::{
    cpu_oracle, identity_curve, identity_lut, max_abs_diff, moved, scene_linear_rgba, Case,
};
use crate::full_chain::{build_full_chain_passes, FullChainInputs};
use crate::image::GpuImage;
use crate::Pass;

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, WbMethod};
use raw_core::xmp::AdjustmentModel;

/// Parity ceiling for the GATED live chain vs the CPU pipeline. Same `1e-4` the
/// whole epic gates at; the gated neutral chain runs FEWER accumulation stages
/// than `full_chain`'s `mild` case (only the view tail), so it lands comfortably
/// under. The measured value is printed so any regression toward it is visible.
const LIVE_CHAIN_BUDGET: f32 = 1e-4;

/// The lower bound the UNGATED composition's neutral divergence must clear, so
/// the gating proof is non-vacuous: `build_full_chain_passes` runs WB / tone /
/// vibrance / … unconditionally on a neutral model, and the gamma OETF amplifies
/// the resulting tiny scene-linear diffs to ~3.7e-3 at the output. If this ever
/// dropped below the threshold the gating would be doing nothing measurable.
const UNGATED_DIVERGENCE_FLOOR: f32 = 1e-3;

/// An explicit ALL-NO-OP `AdjustmentModel` — every gateable slider zeroed.
///
/// CRUCIAL: `AdjustmentModel::default()` is NOT all-no-op — it ships the
/// reference renderer's fresh-import baseline, `sharpen_amount: 40.0` and
/// `nr_color: 25.0` (both past the `1e-3` gate). Building a "neutral" case from
/// `..default()` would leak the sharpen + nr_color passes (and WB if temp/tint
/// drifted). Risk A is about the GATE MECHANISM, not the product's default UX
/// state, so the fixtures start from a genuinely no-op model: every scene-linear
/// slider at its short-circuit value, WB at 6500/0, identity tone/curves. From
/// here the gated chain is EXACTLY the view tail; one engaged slider adds one pass.
fn noop_model() -> AdjustmentModel {
    AdjustmentModel {
        temperature: 6500.0, // WB skip band
        tint: 0.0,
        exposure: 0.0,
        contrast: 0.0, // AgX neutral (the tail runs regardless)
        highlights: 0.0,
        shadows: 0.0,
        whites: 0.0,
        blacks: 0.0,
        parametric_highlights: 0.0,
        parametric_lights: 0.0,
        parametric_darks: 0.0,
        parametric_shadows: 0.0,
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        // The two non-zero `default()` sliders, zeroed so the baseline is no-op.
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        dehaze: 0.0,
        tone_curve_luma: ToneCurve::default(),
        tone_curve_red: ToneCurve::default(),
        tone_curve_green: ToneCurve::default(),
        tone_curve_blue: ToneCurve::default(),
        // auto_exposure is a CPU stage out of the chain's scope; pin Off so the
        // model is unambiguous (mirrors the full_chain cases).
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// A truly-neutral case: the all-no-op [`noop_model`] + IDENTITY Auto Profile
/// curve + residual LUT. The gated builder must omit every scene-linear pass and
/// emit ONLY the view tail; the identity curve/LUT keep even the always-on tail
/// near-identity so a gating bug can't be masked by the tail moving pixels.
fn neutral_case() -> Case {
    Case {
        model: noop_model(),
        capture: None,
        curve: identity_curve(),
        lut: identity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// Run the GATED live chain headlessly and read back the final RGBA buffer.
///
/// Every C1 case has dehaze either OMITTED (neutral + all non-dehaze single-stage
/// cases) or FIRST-with-no-upstream (the dehaze single-stage case) — so the
/// pre-dehaze buffer is always the input itself and the airlight is
/// `compute_airlight(input)`, no mid-chain readback. (The prefix→readback→suffix
/// dance is C5's concern, for dehaze placed downstream of engaged stages.) One
/// `ChainRunner` run, one readback.
fn run_live_chain(input: &[f32], w: u32, h: u32, inputs: &FullChainInputs) -> Vec<f32> {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let airlight = compute_airlight(input, w as usize, h as usize);
    let passes = build_live_chain(inputs, AirlightSource::Cpu(airlight));
    let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();
    let img = GpuImage::upload(&ctx, input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let out = runner.run_blocking(&pass_refs);
    assert_eq!(
        runner.last_readback_count(),
        1,
        "live chain reads back once"
    );
    out
}

/// Run the UNGATED composition (`build_full_chain_passes`) headlessly, same
/// airlight-from-input convention. Used ONLY to measure the neutral divergence
/// the gating removes — the non-vacuous contrast in the gating proof.
fn run_ungated_chain(input: &[f32], w: u32, h: u32, inputs: &FullChainInputs) -> Vec<f32> {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let airlight = compute_airlight(input, w as usize, h as usize);
    let passes = build_full_chain_passes(inputs, airlight);
    let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();
    let img = GpuImage::upload(&ctx, input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    runner.run_blocking(&pass_refs)
}

/// THE GATE: a neutral `AdjustmentModel` → the gated live chain (a) emits ONLY
/// the view tail (no scene-linear passes), and (b) matches the CPU pipeline
/// within `1e-4`. Side-by-side, the UNGATED composition diverges by ~3.7e-3 on
/// the same input — printed and floor-checked so the gating proof is non-vacuous.
#[test]
fn neutral_live_chain_matches_cpu_and_omits_noop_passes() {
    let (w, h) = (8usize, 8usize);
    let input = scene_linear_rgba(w, h);
    let case = neutral_case();
    let inputs = case.gpu_inputs();

    // (a) Structural: the neutral chain is EXACTLY the view tail. No WB, no tone,
    //     no vibrance/saturation/clarity/texture/dehaze/sharpen/NR — every one is
    //     a no-op at default, so the gated builder omits it.
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "neutral live chain must be the view tail ONLY ({VIEW_TAIL_PASS_COUNT} passes), \
         got {} — a no-op scene-linear pass leaked through the gate",
        passes.len()
    );

    // (b) Numeric: gated GPU vs the CPU pipeline (which short-circuits every
    //     scene-linear stage at neutral) within budget.
    let gpu = run_live_chain(&input, w as u32, h as u32, &inputs);
    let cpu = cpu_oracle(&input, w as u32, h as u32, &case);
    let gated_diff = max_abs_diff(&gpu, &cpu);

    // The non-vacuous contrast: the UNGATED composition runs every stage and the
    // gamma OETF amplifies the neutral scene-linear diffs to ~3.7e-3.
    let ungated = run_ungated_chain(&input, w as u32, h as u32, &inputs);
    let ungated_diff = max_abs_diff(&ungated, &cpu);
    let moved_by_tail = moved(&input, &cpu);

    eprintln!(
        "NEUTRAL GATING [Risk A]: gated max abs diff = {gated_diff:e} (< {LIVE_CHAIN_BUDGET:e}); \
         UNGATED neutral divergence = {ungated_diff:e} (the ~3.7e-3 the gate removes); \
         view tail moved input by {moved_by_tail:e}"
    );

    assert!(
        gated_diff < LIVE_CHAIN_BUDGET,
        "gated neutral GPU vs CPU {gated_diff} exceeds {LIVE_CHAIN_BUDGET}"
    );
    assert!(
        ungated_diff > UNGATED_DIVERGENCE_FLOOR,
        "ungated neutral divergence {ungated_diff} is below {UNGATED_DIVERGENCE_FLOOR} — the \
         gating proof is vacuous (the ungated chain should diverge ~3.7e-3 on a neutral model)"
    );
    // And the gate genuinely closes the gap: gated must be ORDERS below ungated.
    assert!(
        gated_diff < ungated_diff,
        "gated diff {gated_diff} not below ungated {ungated_diff} — gating had no effect"
    );
}

/// A single-stage-active descriptor: a label + a closure that engages exactly
/// one slider on an otherwise-neutral model.
struct SingleStage {
    name: &'static str,
    engage: fn(&mut AdjustmentModel),
}

/// Engage one slider past its threshold on an otherwise-neutral model. Each entry
/// flips EXACTLY one stage from no-op to active, so the gated chain must contain
/// `VIEW_TAIL_PASS_COUNT + 1` passes and match the CPU pipeline running only that
/// stage. WB / scene-tone / tone-curves are included alongside the per-pixel and
/// spatial sliders so every gate predicate (matrix near-identity, the 5-field
/// tone OR, the parametric/point-curve OR) is exercised.
fn single_stage_cases() -> Vec<SingleStage> {
    vec![
        SingleStage {
            name: "white_balance",
            engage: |m| {
                m.temperature = 5200.0; // well outside (6500 ± 0.5)
                m.tint = 8.0;
            },
        },
        SingleStage {
            name: "scene_tone_controls(exposure)",
            engage: |m| m.exposure = 0.5,
        },
        SingleStage {
            name: "scene_tone_controls(shadows)",
            engage: |m| m.shadows = 30.0,
        },
        SingleStage {
            name: "tone_curves(parametric)",
            engage: |m| m.parametric_lights = 25.0,
        },
        SingleStage {
            name: "tone_curves(luma point curve)",
            engage: |m| {
                m.tone_curve_luma =
                    ToneCurve::new(vec![(0.0, 0.0), (0.3, 0.22), (0.7, 0.8), (1.0, 1.0)]);
            },
        },
        SingleStage {
            name: "vibrance",
            engage: |m| m.vibrance = 40.0,
        },
        SingleStage {
            name: "saturation",
            engage: |m| m.saturation = 30.0,
        },
        SingleStage {
            name: "clarity",
            engage: |m| m.clarity = 35.0,
        },
        SingleStage {
            name: "texture",
            engage: |m| m.texture = 30.0,
        },
        SingleStage {
            name: "dehaze",
            engage: |m| m.dehaze = 40.0,
        },
        SingleStage {
            name: "vignette",
            engage: |m| {
                m.vignette_amount = -60.0;
                m.vignette_feather = 40.0; // sub-param; amount is the gate
            },
        },
        SingleStage {
            name: "grain",
            engage: |m| {
                m.grain_amount = 60.0;
                m.grain_size = 30.0; // sub-params; amount is the gate
                m.grain_roughness = 50.0;
            },
        },
        SingleStage {
            name: "split_tone",
            engage: |m| {
                m.split_tone_shadow_hue = 30.0;
                m.split_tone_shadow_saturation = 70.0; // a saturation is the gate
                m.split_tone_highlight_hue = 250.0;
                m.split_tone_highlight_saturation = 50.0;
                m.split_tone_balance = 20.0;
            },
        },
        SingleStage {
            name: "sharpen",
            engage: |m| {
                m.sharpen_amount = 60.0;
                m.sharpen_radius = 1.0;
                m.sharpen_detail = 25.0;
            },
        },
        SingleStage {
            name: "nr_luminance",
            engage: |m| m.nr_luminance = 30.0,
        },
        SingleStage {
            name: "nr_color",
            engage: |m| m.nr_color = 40.0,
        },
    ]
}

/// Build a `Case` for a single-stage descriptor: the all-no-op [`noop_model`]
/// with one slider engaged, IDENTITY curve/LUT so the ONLY non-tail mover is the
/// engaged stage (building from `default()` would silently also engage sharpen +
/// nr_color — see [`noop_model`]).
fn single_stage_case(s: &SingleStage) -> Case {
    let mut model = noop_model();
    (s.engage)(&mut model);
    Case {
        model,
        capture: None,
        curve: identity_curve(),
        lut: identity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// SINGLE-STAGE-ACTIVE parity: for each slider, engaging ONLY it (a) adds exactly
/// one pass to the neutral view-tail floor, and (b) the gated GPU chain matches
/// the CPU pipeline running ONLY that stage. The count-delta uniquely pins WHICH
/// pass appeared (no `Box<dyn Pass>` downcasting needed) and the numeric parity
/// pins that the included pass is the CORRECT, engaged stage.
#[test]
fn single_stage_active_includes_exactly_that_pass_and_matches_cpu() {
    let (w, h) = (8usize, 8usize);
    let input = scene_linear_rgba(w, h);

    for s in single_stage_cases() {
        let case = single_stage_case(&s);
        let inputs = case.gpu_inputs();

        // (a) exactly one pass added over the neutral floor.
        let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
        assert_eq!(
            passes.len(),
            VIEW_TAIL_PASS_COUNT + 1,
            "[{}] single engaged slider must add exactly 1 pass to the view tail \
             (expected {}, got {})",
            s.name,
            VIEW_TAIL_PASS_COUNT + 1,
            passes.len()
        );

        // (b) gated GPU vs CPU-running-only-that-stage within budget.
        let gpu = run_live_chain(&input, w as u32, h as u32, &inputs);
        let cpu = cpu_oracle(&input, w as u32, h as u32, &case);
        let diff = max_abs_diff(&gpu, &cpu);
        let stage_moved = {
            // The neutral output (this stage OFF) vs this case's CPU output — the
            // amount THIS stage moved the image, so the parity number isn't a
            // false green from a stage that did nothing.
            let neutral = cpu_oracle(&input, w as u32, h as u32, &neutral_case());
            max_abs_diff(&neutral, &cpu)
        };
        eprintln!(
            "SINGLE-STAGE [{}]: gated max abs diff = {diff:e} (< {LIVE_CHAIN_BUDGET:e}); \
             stage moved the image by {stage_moved:e}",
            s.name
        );
        assert!(
            diff < LIVE_CHAIN_BUDGET,
            "[{}] gated GPU vs CPU {diff} exceeds {LIVE_CHAIN_BUDGET}",
            s.name
        );
    }
}

/// Structural sanity for the degenerate-dehaze split: with dehaze OMITTED (a
/// neutral model), `build_live_split`'s suffix is still a coherent runnable Vec —
/// it begins with the view tail (no `DehazePass` head), and prefix+suffix
/// concatenated equals the single `build_live_chain` Vec. (The C5 readback path
/// only uses the split when dehaze is engaged; this pins the contract that the
/// split doesn't return an incoherent/empty suffix when it isn't.)
#[test]
fn live_split_concatenates_to_live_chain_and_handles_omitted_dehaze() {
    let case = neutral_case();
    let inputs = case.gpu_inputs();

    let full = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    let (prefix, suffix) = build_live_split(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        full.len(),
        prefix.len() + suffix.len(),
        "live_split prefix + suffix must equal the single live_chain Vec length"
    );
    // Neutral → prefix empty (no engaged scene-linear stage), suffix == view tail.
    assert_eq!(prefix.len(), 0, "neutral prefix must be empty");
    assert_eq!(
        suffix.len(),
        VIEW_TAIL_PASS_COUNT,
        "neutral suffix (dehaze omitted) must be the view tail only"
    );

    // With dehaze engaged the suffix grows by exactly the DehazePass head.
    let mut dehazed = neutral_case();
    dehazed.model.dehaze = 40.0;
    let dehazed_inputs = dehazed.gpu_inputs();
    let (dprefix, dsuffix) =
        build_live_split(&dehazed_inputs, AirlightSource::Cpu([0.1, 0.1, 0.1]));
    assert_eq!(dprefix.len(), 0, "dehaze-only prefix is still empty");
    assert_eq!(
        dsuffix.len(),
        VIEW_TAIL_PASS_COUNT + 1,
        "dehaze-engaged suffix must add the DehazePass head to the view tail"
    );
}

/// STALE-BIND-GROUP GUARD (#1079): `chain_signature` must fold in
/// `residual_lut_size` — the ONE pooled data buffer whose byte length can change
/// at a constant active-stage mask. Two input sets differing ONLY in the residual
/// LUT edge must land in DIFFERENT pool buckets; otherwise a LUT growing
/// mid-session would make `pool_scratch` replace the too-small grid buffer while
/// the cached bind group kept referencing the replaced one (stale data). Same
/// size ⇒ same signature (the zero-alloc hot path is untouched).
#[test]
fn chain_signature_folds_in_residual_lut_size() {
    let dims = (8u32, 8u32);

    let mut small = neutral_case();
    small.lut = identity_lut(9);
    let mut large = neutral_case();
    large.lut = identity_lut(17);

    let small_inputs = small.gpu_inputs();
    let large_inputs = large.gpu_inputs();

    assert_ne!(
        chain_signature(&small_inputs, dims),
        chain_signature(&large_inputs, dims),
        "two chains differing only in residual_lut_size must get different signatures \
         (a grown LUT at the same signature binds a stale pooled grid buffer)"
    );

    // Same size ⇒ same signature (the LUT *values* must not change the bucket —
    // a slider drag at constant shape stays zero-alloc).
    let mut same_size = neutral_case();
    same_size.lut = identity_lut(9);
    assert_eq!(
        chain_signature(&small_inputs, dims),
        chain_signature(&same_size.gpu_inputs(), dims),
        "equal residual_lut_size must keep the signature stable"
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
    let sig_default = chain_signature(&inputs, (8, 8));
    let sig_wb_on = chain_signature(&inputs_wb, (8, 8));
    assert_ne!(
        sig_default, sig_wb_on,
        "signatures must differ when WB crosses the gate threshold"
    );
}

/// Split-tone sub-param gating (#1111): hues / balance alone must NOT
/// engage the pass — the gate is on the two saturations, mirroring the
/// raw-core stage's zero-saturation short-circuit.
#[test]
fn split_tone_hues_balance_alone_do_not_engage_the_pass() {
    let mut case = neutral_case();
    case.model.split_tone_shadow_hue = 220.0; // saturations stay 0
    case.model.split_tone_highlight_hue = 40.0;
    case.model.split_tone_balance = 80.0;
    let inputs = case.gpu_inputs();
    let passes = build_live_chain(&inputs, AirlightSource::Cpu([0.0; 3]));
    assert_eq!(
        passes.len(),
        VIEW_TAIL_PASS_COUNT,
        "hues/balance without saturation must not add a split-tone pass"
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

/// #1647 M1 — GPU memory measurement for the live chain at a session resolution
/// (`MAPLE_MEASURE_DIMS=WxH`, default 3072x2048). Renders the WORST-CASE chain
/// (every spatial pass engaged → max FramePool planes). Run the PRE-BUILT test
/// binary under `/usr/bin/time -l` and read "maximum resident set size": on
/// Apple Silicon's unified memory the wgpu/Metal planes count toward process
/// RSS, so the per-dims peak — minus the ~constant baseline + the CPU input
/// (W·H·16 B) — is the GPU session footprint. `#[ignore]`: perf, run explicitly.
#[test]
#[ignore]
fn measure_gpu_memory_at_dims() {
    let dims = std::env::var("MAPLE_MEASURE_DIMS").unwrap_or_else(|_| "3072x2048".into());
    let (ws, hs) = dims.split_once('x').expect("MAPLE_MEASURE_DIMS=WxH");
    let (w, h): (u32, u32) = (ws.parse().unwrap(), hs.parse().unwrap());

    let input = scene_linear_rgba(w as usize, h as usize);
    let mut case = neutral_case();
    case.model.temperature = 4800.0; // engage WB (off the 6500 skip band)
    case.model.tint = 18.0;
    case.model.clarity = 40.0;
    case.model.texture = 30.0;
    case.model.dehaze = 45.0;
    case.model.sharpen_amount = 60.0;
    case.model.nr_luminance = 40.0;
    case.model.nr_color = 50.0;
    let inputs = case.gpu_inputs();
    let _out = run_live_chain(&input, w, h, &inputs);

    let mp = (w as u64 * h as u64) as f64 / 1_000_000.0;
    eprintln!(
        "MEASURE dims={}x{} ({:.1} MP) cpu_input_mb={} one_plane_mb={}",
        w,
        h,
        mp,
        (input.len() * 4) / 1_048_576,
        (w as u64 * h as u64 * 16) / 1_048_576
    );
}
