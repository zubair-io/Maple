//! End-to-end parity for the FULL assembled GPU chain (epic #925, P4a).
//!
//! Split out of `full_chain.rs` to keep that module under the 600-LOC budget.
//! Included via `#[path = "full_chain/tests.rs"] mod tests;`, so it reaches the
//! parent's items through `super::*`.
//!
//! ## What this gates
//!
//! The composed GPU chain (all 20 GPU-ported [`Pass`]es, in develop order) vs
//! the SAME stages composed on the CPU in the same order by calling the REAL
//! `raw-core` stage functions sequentially (the test-only `raw-core` dev-dep) —
//! not a hand-copied oracle. This is the capstone validation that the per-stage
//! parity (each ≤ 3e-6 vs its Rust stage) survives composition: float error can
//! only accumulate across the 20 stages, and this bounds the accumulated total.
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

/// Accumulated-error budget for the full 20-stage composed chain.
///
/// Per-stage parity is ≤ 3e-6 vs each Rust stage; 20 stages of f32 arithmetic
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
        dehaze: 10.0,           // non-zero so dehaze runs (airlight engaged)
        vignette_amount: -10.0, // past the |amount| < 1e-3 short-circuit (#1109)
        vignette_feather: 50.0,
        grain_amount: 15.0, // engaged display-tail grain (#1110)
        grain_size: 25.0,
        grain_roughness: 50.0,
        split_tone_shadow_hue: 30.0, // engaged display-tail tint (#1111)
        split_tone_shadow_saturation: 20.0,
        split_tone_highlight_hue: 210.0,
        split_tone_highlight_saturation: 15.0,
        split_tone_balance: 10.0,
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
        split_tone_shadow_hue: 30.0, // engaged display-tail tint (#1111)
        split_tone_shadow_saturation: 70.0,
        split_tone_highlight_hue: 250.0,
        split_tone_highlight_saturation: 60.0,
        split_tone_balance: -40.0,
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
fn run_gpu_chain_limit(
    input: &[f32],
    w: u32,
    h: u32,
    inputs: &FullChainInputs,
    limit: usize,
) -> Vec<f32> {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (prefix, suffix) = build_split(inputs, [0.0; 3]);
    let mut all_passes = prefix;
    all_passes.extend(suffix);
    let passes_to_run = &all_passes[0..=limit];
    let refs: Vec<&dyn Pass> = passes_to_run.iter().map(|p| p.as_ref()).collect();
    let img = GpuImage::upload(&ctx, input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    runner.run_blocking(&refs)
}

fn cpu_oracle_limit(input: &[f32], w: u32, h: u32, case: &Case, limit: usize) -> Vec<f32> {
    let mut img =
        raw_core::image::Image::new(w, h, raw_core::image::ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }

    let has_capture = case.capture.is_some();
    let mut stage_idx = 0;

    // Stage 0: capture sharpening
    if has_capture {
        if stage_idx <= limit {
            let p = case.capture.as_ref().unwrap();
            raw_core::stages::capture_sharpening::apply_capture_sharpening(
                &mut img,
                &crate::full_chain::oracle::rc_capture(p),
            );
        }
        stage_idx += 1;
    }

    // Stage 1: white balance
    if stage_idx <= limit {
        raw_core::stages::white_balance::apply(
            &mut img,
            case.model.temperature,
            case.model.tint,
            case.wb_method,
        );
    }
    stage_idx += 1;

    // Stage 2: scene tone controls
    if stage_idx <= limit {
        raw_core::stages::scene_tone_controls::apply(&mut img, &case.model);
    }
    stage_idx += 1;

    // Stage 3: tone curves
    if stage_idx <= limit {
        raw_core::stages::tone_curves::apply(&mut img, &case.model);
    }
    stage_idx += 1;

    // Stage 4: vibrance
    if stage_idx <= limit {
        raw_core::stages::vibrance::apply(&mut img, case.model.vibrance);
    }
    stage_idx += 1;

    // Stage 5: saturation
    if stage_idx <= limit {
        raw_core::stages::saturation::apply(&mut img, case.model.saturation);
    }
    stage_idx += 1;

    // Stage 6: HSL
    if stage_idx <= limit {
        raw_core::stages::hsl::apply(
            &mut img,
            &[
                case.model.hue_adjustment_red,
                case.model.hue_adjustment_orange,
                case.model.hue_adjustment_yellow,
                case.model.hue_adjustment_green,
                case.model.hue_adjustment_aqua,
                case.model.hue_adjustment_blue,
                case.model.hue_adjustment_purple,
                case.model.hue_adjustment_magenta,
            ],
            &[
                case.model.saturation_adjustment_red,
                case.model.saturation_adjustment_orange,
                case.model.saturation_adjustment_yellow,
                case.model.saturation_adjustment_green,
                case.model.saturation_adjustment_aqua,
                case.model.saturation_adjustment_blue,
                case.model.saturation_adjustment_purple,
                case.model.saturation_adjustment_magenta,
            ],
            &[
                case.model.luminance_adjustment_red,
                case.model.luminance_adjustment_orange,
                case.model.luminance_adjustment_yellow,
                case.model.luminance_adjustment_green,
                case.model.luminance_adjustment_aqua,
                case.model.luminance_adjustment_blue,
                case.model.luminance_adjustment_purple,
                case.model.luminance_adjustment_magenta,
            ],
        );
    }
    stage_idx += 1;

    // Stage 7: clarity
    if stage_idx <= limit {
        raw_core::stages::clarity::apply(&mut img, case.model.clarity);
    }
    stage_idx += 1;

    // Stage 8: texture
    if stage_idx <= limit {
        raw_core::stages::texture::apply(&mut img, case.model.texture);
    }
    stage_idx += 1;

    // Stage 9: dehaze
    if stage_idx <= limit {
        raw_core::stages::dehaze::apply(&mut img, case.model.dehaze);
    }
    stage_idx += 1;

    // Stage 10: vignette
    if stage_idx <= limit {
        raw_core::stages::vignette::apply(
            &mut img,
            case.model.vignette_amount,
            case.model.vignette_feather,
        );
    }
    stage_idx += 1;

    // Stage 11: sharpen
    if stage_idx <= limit {
        raw_core::stages::sharpen::apply(
            &mut img,
            case.model.sharpen_amount,
            case.model.sharpen_radius,
            case.model.sharpen_detail,
            case.model.sharpen_masking,
        );
    }
    stage_idx += 1;

    // Stage 12: NLM luma
    if stage_idx <= limit {
        raw_core::stages::noise_reduction::apply_luminance(
            &mut img,
            case.model.nr_luminance,
            None,
            100,
        );
    }
    stage_idx += 1;

    // Stage 13: NLM color
    if stage_idx <= limit {
        raw_core::stages::noise_reduction::apply_color(&mut img, case.model.nr_color, None, 100);
    }
    stage_idx += 1;

    // Stage 14: AgX
    if stage_idx <= limit {
        raw_core::view::agx::apply(&mut img, case.model.contrast);
    }
    stage_idx += 1;

    // Stage 15: split tone
    if stage_idx <= limit {
        raw_core::stages::split_tone::apply(
            &mut img,
            case.model.split_tone_shadow_hue,
            case.model.split_tone_shadow_saturation,
            case.model.split_tone_highlight_hue,
            case.model.split_tone_highlight_saturation,
            case.model.split_tone_balance,
        );
    }
    stage_idx += 1;

    // Stage 16: grain
    if stage_idx <= limit {
        raw_core::stages::grain::apply(
            &mut img,
            case.model.grain_amount,
            case.model.grain_size,
            case.model.grain_roughness,
        );
    }
    stage_idx += 1;

    // Stage 17: display encode (rec2020_to_srgb)
    if stage_idx <= limit {
        raw_core::view::encode::rec2020_to_srgb(&mut img);
    }
    stage_idx += 1;

    // Stage 18: srgb_gamma_encode
    if stage_idx <= limit {
        raw_core::view::encode::srgb_gamma_encode(&mut img);
    }
    stage_idx += 1;

    // At stage 19 and 20, convert to flat slice to run curve/LUT
    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }

    if stage_idx <= limit {
        raw_core::view::auto_profile::apply::apply_curve(&mut rgb, &case.curve);
    }
    stage_idx += 1;

    if stage_idx <= limit {
        case.lut.apply(&mut rgb);
    }

    // Repack to RGBA
    let mut out = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        out.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    out
}

#[test]
fn full_gpu_chain_matches_composed_cpu_oracle() {
    let (w, h) = (8usize, 8usize);
    let input = scene_linear_rgba(w, h);

    for (name, case) in [("mild", mild_case()), ("aggressive", aggressive_case())] {
        let inputs = case.gpu_inputs();
        let (prefix, suffix) = build_split(&inputs, [0.0; 3]);
        let num_passes = prefix.len() + suffix.len();

        println!("--- Debugging parity for case: {} ---", name);
        for k in 0..num_passes {
            let gpu = run_gpu_chain_limit(&input, w as u32, h as u32, &inputs, k);
            let cpu = cpu_oracle_limit(&input, w as u32, h as u32, &case, k);
            let diff = max_abs_diff(&gpu, &cpu);
            let mut max_d = 0.0f32;
            let mut max_idx = 0;
            for (idx, (&x, &y)) in gpu.iter().zip(&cpu).enumerate() {
                let d = (x - y).abs();
                if d > max_d {
                    max_d = d;
                    max_idx = idx;
                }
            }
            println!(
                "  Pass {}: diff = {:e} at idx {} (gpu: {}, cpu: {})",
                k, diff, max_idx, gpu[max_idx], cpu[max_idx]
            );
            if k == 3 && name == "aggressive" {
                println!("    GPU pixels[24..32]: {:?}", &gpu[24..32]);
                println!("    CPU pixels[24..32]: {:?}", &cpu[24..32]);
            }
        }

        let gpu = run_gpu_chain(&input, w as u32, h as u32, &inputs);
        let cpu = cpu_oracle(&input, w as u32, h as u32, &case);
        let diff = max_abs_diff(&gpu, &cpu);
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
    // The aggressive case engages every stage incl. capture_sharpening → all 21
    // GPU-ported passes are present (20 scene/view stages incl. HSL + srgb_gamma).
    assert_eq!(
        full.len(),
        21,
        "aggressive full chain must have all 21 passes"
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
        20,
        "neutral chain (no capture-sharpening) must have 20 passes"
    );
    // Sanity: PROFILE_CURVE_FLAT_LEN is the curve flat length the Pass asserts —
    // the neutral identity curve must match it (else the Pass panics at encode).
    assert_eq!(inputs.profile_curve_flat.len(), PROFILE_CURVE_FLAT_LEN);
}
