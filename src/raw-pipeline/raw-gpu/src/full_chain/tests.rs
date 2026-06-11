//! End-to-end parity for the FULL assembled GPU chain (epic #925, P4a).
//!
//! Split out of `full_chain.rs` to keep that module under the 600-LOC budget.
//! Included via `#[path = "full_chain/tests.rs"] mod tests;`, so it reaches the
//! parent's items through `super::*`.
//!
//! ## What this gates
//!
//! The composed GPU chain (all 19 GPU-ported [`Pass`]es, in develop order) vs
//! the SAME stages composed on the CPU in the same order by calling the REAL
//! `raw-core` stage functions sequentially (the test-only `raw-core` dev-dep) —
//! not a hand-copied oracle. This is the capstone validation that the per-stage
//! parity (each ≤ 3e-6 vs its Rust stage) survives composition: float error can
//! only accumulate across the 19 stages, and this bounds the accumulated total.
//!
//! Two representative adjustment sets, both with every per-pixel stage engaged
//! PAST its raw-core no-op threshold so the CPU `apply` fns do NOT short-circuit
//! and compute the same function the always-running GPU Passes do (see
//! `mild_case` for why a truly-neutral all-identity case would diverge by
//! design — short-circuiting is the *caller's* job, not this layer's):
//!
//! - **mild** — small but past-threshold settings on every stage; the lighter
//!   composition (the accumulated error floor).
//! - **aggressive** — every stage pushed hard (non-default WB, tone, color, all
//!   three spatial filters, NR, AgX contrast, a non-identity Auto Profile curve +
//!   residual LUT), so the accumulated error is measured under load.
//!
//! The all-identity *plumbing* (ping-pong threading + the view-tail color-space
//! hand-off with every slider omitted) is covered by the structural pass-count /
//! prefix+suffix tests, NOT a numeric parity case.
//!
//! ## The full f32 view tail (P4a — gamma now GPU-resident)
//!
//! With `SrgbGammaPass` ported (P4a), the assembled chain's view tail is
//! `agx → display_encode (rec2020_to_srgb) → srgb_gamma → auto_profile_curve →
//! residual_lut` — the complete f32 view tail, matching raw-core's `render`
//! ordering (`rec2020_to_srgb → srgb_gamma_encode → apply_curve → ColorLut`)
//! exactly. The CPU oracle mirrors it stage-for-stage (it also runs
//! `srgb_gamma_encode` in that position), so the comparison is GPU-vs-CPU of the
//! *same* composed stages — and the gamma step makes the curve + LUT operate on
//! the gamma-encoded domain they were *fit in*, so this is now the production
//! view tail (sans the final f32 → u8 `dither_and_quantize`, the display-OUTPUT
//! step of P4b). `srgb_gamma`'s clamp lands values in `[0, 1]`, keeping the curve
//! + LUT in-domain and non-degenerate.
//!
//! ## Dehaze airlight via a genuine mid-chain readback
//!
//! `DehazePass` needs an airlight measured from its `src` (the post-texture
//! buffer). We obtain it the honest headless way: run the pre-dehaze prefix
//! through one [`ChainRunner`] (one readback), `compute_airlight` on the
//! read-back buffer, then run `dehaze` + the suffix seeded from that buffer
//! through a SECOND runner. Concatenated the two runs are exactly
//! [`build_full_chain_passes`]'s single Vec; the split only exists to source the
//! airlight on-device-then-back. The LIVE path can't pay a per-tick readback —
//! it needs an on-GPU reduction (documented in `full_chain.rs`).

use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::dehaze::compute_airlight;
use crate::full_chain::oracle::{
    cpu_oracle, max_abs_diff, moved, nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case,
};
use crate::image::GpuImage;
use crate::PROFILE_CURVE_FLAT_LEN;

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::xmp::AdjustmentModel;

// The CPU oracle, `Case` builder, scene-linear fixture, and the non-identity
// curve/LUT fixtures now live in `crate::full_chain::oracle` (shared with the
// P4b `live_chain/tests.rs` gate). `CaptureSharpeningParams` is still needed
// here for the aggressive case's capture-sharpening engagement.
use crate::capture_sharpening::CaptureSharpeningParams;

/// Run the composed GPU chain with a genuine mid-chain airlight readback:
/// prefix → readback → `compute_airlight` → suffix (seeded from the prefix
/// output). Returns the final RGBA buffer. Each phase asserts exactly one
/// readback (`ChainRunner`'s single end-of-run readback per `run_blocking`).
fn run_gpu_chain(input: &[f32], w: u32, h: u32, inputs: &FullChainInputs) -> Vec<f32> {
    let ctx = GpuContext::new_blocking().expect("gpu context");

    // Phase 1: the pre-dehaze prefix. airlight is unknown yet, so build the
    // split with a placeholder — only the prefix is used here.
    let (prefix, _) = build_split(inputs, [0.0; 3]);
    let prefix_refs: Vec<&dyn Pass> = prefix.iter().map(|p| p.as_ref()).collect();
    let img0 = GpuImage::upload(&ctx, input, w, h);
    let runner0 = ChainRunner::new(&ctx, &img0);
    let pre_dehaze = runner0.run_blocking(&prefix_refs);
    assert_eq!(
        runner0.last_readback_count(),
        1,
        "prefix run must read back exactly once"
    );

    // Mid-chain airlight from the EXACT buffer dehaze's src will be — the honest
    // headless affordance (the LIVE path needs an on-GPU reduction instead).
    let airlight = compute_airlight(&pre_dehaze, w as usize, h as usize);

    // Phase 2: dehaze + the suffix, seeded from the prefix output. Built with the
    // real airlight so the DehazePass at the suffix head is exact.
    let (_, suffix) = build_split(inputs, airlight);
    let suffix_refs: Vec<&dyn Pass> = suffix.iter().map(|p| p.as_ref()).collect();
    let img1 = GpuImage::upload(&ctx, &pre_dehaze, w, h);
    let runner1 = ChainRunner::new(&ctx, &img1);
    let out = runner1.run_blocking(&suffix_refs);
    assert_eq!(
        runner1.last_readback_count(),
        1,
        "suffix run must read back exactly once"
    );
    out
}

/// Accumulated-error budget for the full 19-stage composed chain.
///
/// Per-stage parity is ≤ 3e-6 vs each Rust stage; 19 stages of f32 arithmetic
/// (including the iterative capture-sharpening RL loop FIRST, whose error then
/// feeds every downstream stage, plus three spatial DAGs and two NLM passes)
/// accumulate well under the per-stage `1e-4` ceiling the whole epic gates at.
///
/// The P4a `srgb_gamma` stage is a per-channel AMPLIFIER of the accumulated
/// scene/view diff, by design: the OETF slope just above the 0.0031308 knee is
/// ~13×, so a few-ULP upstream diff on a deep-shadow pixel grows by an order of
/// magnitude through gamma; additionally a pixel that straddles the knee can take
/// the linear branch on one side and the power branch on the other (the sRGB
/// curve's ~2.4e-5 join discontinuity). Both mechanisms are inherent — they lift
/// the measured full-chain max above the pre-gamma 8.4e-6, but it stays well
/// under `1e-4`. We keep the same `1e-4` ceiling the per-stage tests use; the
/// measured value is printed so any regression toward it is visible.
const FULL_CHAIN_BUDGET: f32 = 1e-4;

/// The mild case: every per-pixel stage engaged just PAST its raw-core no-op
/// threshold, so the CPU `apply` fn does NOT short-circuit and computes the same
/// function the always-running GPU Pass does. (A truly-neutral all-identity case
/// would diverge by design: raw-core's `apply` fns return early at default
/// values while the GPU Passes run their arithmetic unconditionally — their
/// short-circuit is delegated to the *caller*, i.e. develop's `if` guards / the
/// P4b live chain, NOT to this composition layer. The all-identity *plumbing* is
/// covered by the structural prefix+suffix / pass-count tests below.)
///
/// `capture_sharpening` stays `None` here — that is the ONE legitimate builder
/// gate (symmetric: the CPU oracle also `if let Some`), validated by the pass-
/// count test. Mild magnitudes keep the per-image curve + LUT non-identity so the
/// view-tail matrix/Oklab/trilinear paths also run for real on both sides.
fn mild_case() -> Case {
    let model = AdjustmentModel {
        temperature: 6000.0, // past the (6500±0.5) WB short-circuit
        tint: 3.0,
        exposure: 0.1,
        contrast: 8.0,
        highlights: -5.0, // past the |h| < 1e-3 scene-tone short-circuit
        shadows: 5.0,
        whites: 4.0,
        blacks: -4.0,
        parametric_lights: 6.0, // engage tone_curves (past PARAMETRIC_EPSILON)
        parametric_shadows: 5.0,
        vibrance: 6.0,   // past the |vibrance| < 1e-3 Oklab short-circuit
        saturation: 5.0, // past the |saturation| < 1e-3 short-circuit
        clarity: 8.0,    // self-copy-through at 0, but engaged so it's tested
        texture: 6.0,
        dehaze: 10.0, // non-zero so dehaze runs (airlight engaged)
        vignette_amount: -10.0, // past the |amount| < 1e-3 short-circuit (#1109)
        vignette_feather: 50.0,
        grain_amount: 15.0, // engaged display-tail grain (#1110)
        grain_size: 25.0,
        grain_roughness: 50.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 10.0,
        nr_color: 15.0,
        // auto_exposure is not a GPU stage; pin Off so the model is unambiguous
        // (the develop chain runs AE CPU-side — out of scope here).
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None, // the one legitimate builder gate (pass-count test)
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// The aggressive case: every stage engaged so every kernel runs for real.
fn aggressive_case() -> Case {
    let model = AdjustmentModel {
        temperature: 4800.0, // non-default WB (dodges the (6500,0) identity)
        tint: 18.0,
        exposure: 0.4,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 20.0,
        parametric_darks: -10.0,
        parametric_lights: 15.0,
        parametric_highlights: -20.0,
        // A non-identity per-channel point curve (luma), exercising tone_curves'
        // luma-coupled path. Knots in [0,1]^2.
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.18), (0.75, 0.82), (1.0, 1.0)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0, // non-zero so the dehaze path actually runs (airlight matters)
        vignette_amount: -65.0, // engaged radial gain (#1109)
        vignette_feather: 30.0,
        grain_amount: 60.0, // engaged display-tail grain (#1110)
        grain_size: 70.0,
        grain_roughness: 80.0,
        sharpen_amount: 80.0,
        sharpen_radius: 1.5,
        sharpen_detail: 30.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: Some(CaptureSharpeningParams {
            sigma: 0.8,
            iterations: 2,
            highlight_threshold: 0.9,
            strength: 1.0,
        }),
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// THE CAPSTONE GATE: the composed GPU chain matches the same stages composed on
/// the CPU (real raw-core fns, same order) within [`FULL_CHAIN_BUDGET`], for both
/// the neutral and aggressive adjustment sets. Prints the measured accumulated
/// max-diff and the move-from-input floor so the gate is provably non-vacuous.
#[test]
fn full_gpu_chain_matches_composed_cpu_oracle() {
    let (w, h) = (8usize, 8usize);
    let input = scene_linear_rgba(w, h);

    for (name, case) in [("mild", mild_case()), ("aggressive", aggressive_case())] {
        let inputs = case.gpu_inputs();
        let gpu = run_gpu_chain(&input, w as u32, h as u32, &inputs);
        let cpu = cpu_oracle(&input, w as u32, h as u32, &case);

        let diff = max_abs_diff(&gpu, &cpu);
        let cpu_moved = moved(&input, &cpu);
        eprintln!(
            "FULL-CHAIN PARITY [{name}]: max abs diff = {diff:e} \
             (chain moved the image by {cpu_moved:e} vs input)"
        );
        assert!(
            diff < FULL_CHAIN_BUDGET,
            "[{name}] composed GPU vs CPU max abs diff {diff} exceeds {FULL_CHAIN_BUDGET}"
        );
    }
}

/// The aggressive case must NOT be a near-no-op: if the chain barely moved the
/// image, a tight parity number would be a false green. Assert every engaged
/// stage class measurably changed the pixels. (Separate from the parity gate so a
/// vacuous-input regression is a distinct, legible failure.)
#[test]
fn aggressive_case_is_non_vacuous() {
    let (w, h) = (8usize, 8usize);
    let input = scene_linear_rgba(w, h);
    let case = aggressive_case();
    let cpu = cpu_oracle(&input, w as u32, h as u32, &case);
    let m = moved(&input, &cpu);
    // The view transform alone (AgX + display-encode + srgb_gamma + the
    // gamma-space curve) moves every pixel substantially; an engaged slider chain
    // moves it more. A floor of 0.1 is comfortably below the real delta and well
    // above float noise.
    assert!(
        m > 0.1,
        "aggressive chain moved the image by only {m:e} — gate would be vacuous"
    );
}

/// `build_full_chain_passes` (the single-Vec assembly artifact) is exactly the
/// concatenation of the prefix + suffix the readback split runs — so the
/// canonical Vec and the test's two-phase orchestration can't drift in length or
/// ordering. (We can't compare `dyn Pass` for equality, but length + the fact
/// that both come from the same builder pins the composition.)
#[test]
fn single_vec_equals_prefix_plus_suffix() {
    let case = aggressive_case();
    let inputs = case.gpu_inputs();
    let full = build_full_chain_passes(&inputs, [0.1, 0.1, 0.1]);
    let (prefix, suffix) = build_split(&inputs, [0.1, 0.1, 0.1]);
    assert_eq!(
        full.len(),
        prefix.len() + suffix.len(),
        "single-Vec assembly must equal prefix + suffix length"
    );
    // The aggressive case engages every stage incl. capture_sharpening → all 19
    // GPU-ported passes are present (18 scene/view stages + srgb_gamma).
    assert_eq!(
        full.len(),
        19,
        "aggressive full chain must have all 19 passes"
    );
}

/// A case with `capture: None` omits capture_sharpening (params None ⇒ stage
/// absent, exactly as develop omits it), so the assembled chain has 16 passes —
/// proving the builder mirrors develop's capture-sharpening gating (the one
/// legitimate builder gate) rather than always including it.
#[test]
fn neutral_chain_omits_capture_sharpening() {
    let case = mild_case();
    let inputs = case.gpu_inputs();
    let full = build_full_chain_passes(&inputs, [0.0; 3]);
    assert_eq!(
        full.len(),
        18,
        "neutral chain (no capture-sharpening) must have 18 passes"
    );
    // Sanity: PROFILE_CURVE_FLAT_LEN is the curve flat length the Pass asserts —
    // the neutral identity curve must match it (else the Pass panics at encode).
    assert_eq!(inputs.profile_curve_flat.len(), PROFILE_CURVE_FLAT_LEN);
}
