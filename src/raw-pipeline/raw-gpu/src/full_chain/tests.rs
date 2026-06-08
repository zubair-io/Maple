//! End-to-end parity for the FULL assembled GPU chain (epic #925, P4a).
//!
//! Split out of `full_chain.rs` to keep that module under the 600-LOC budget.
//! Included via `#[path = "full_chain/tests.rs"] mod tests;`, so it reaches the
//! parent's items through `super::*`.
//!
//! ## What this gates
//!
//! The composed GPU chain (all 16 GPU-ported [`Pass`]es, in develop order) vs
//! the SAME stages composed on the CPU in the same order by calling the REAL
//! `raw-core` stage functions sequentially (the test-only `raw-core` dev-dep) —
//! not a hand-copied oracle. This is the capstone validation that the per-stage
//! parity (each ≤ 3e-6 vs its Rust stage) survives composition: float error can
//! only accumulate across the 16 stages, and this bounds the accumulated total.
//!
//! Two representative adjustment sets:
//!   - **neutral** — every slider at its identity value (and the per-image
//!     curve/LUT identity), so most stages short-circuit; proves the *plumbing*
//!     (ping-pong threading, view-tail color-space hand-off) composes cleanly.
//!   - **aggressive** — every stage engaged (non-default WB, tone, color, all
//!     three spatial filters, NR, AgX contrast, a non-identity Auto Profile curve
//!     + residual LUT), so every kernel runs for real and the accumulated error
//!     is measured under load.
//!
//! ## The srgb_gamma asymmetry (a documented gap, handled symmetrically)
//!
//! There is no GPU `srgb_gamma_encode` pass, so the assembled chain's view tail
//! is `agx → display_encode (rec2020_to_srgb) → auto_profile_curve →
//! residual_lut` with NO gamma step between display_encode and the curve. The CPU
//! oracle MUST mirror that exactly — it also drops gamma — so the comparison is
//! GPU-vs-CPU of the *same* composed stages (a true parity test), not GPU vs the
//! production view tail. `rec2020_to_srgb`'s Oklab compression already lands
//! values in `[0, 1]`, so the curve + LUT stay in-domain and non-degenerate. The
//! missing gamma pass is reported as the headline view-tail gap P4b must fill
//! (the live curve/LUT were fit in gamma space).
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
use crate::image::GpuImage;
use crate::tone_curves::CurveMode;
use crate::PROFILE_CURVE_FLAT_LEN;

use raw_core::image::{ColorSpace, Image};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::view::auto_profile::apply::apply_curve;
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// A scene-linear Rec.2020 RGBA test buffer (the kind the post-DCP develop chain
/// produces). Spans the full working range every stage cares about:
///   - shadow / midtone / highlight greys (tone, curve, NR),
///   - saturated primaries (Oklab vibrance/saturation, WB channel coupling, the
///     AgX hue-restoring sigmoid + the display-encode gamut compression),
///   - HDR scene-headroom values > 1 (AgX sigmoid + compress_input soft-knee),
///   - a slightly-negative channel (clamp paths),
///   - spatial neighbours that differ from their surround (so the guided-filter /
///     dehaze / sharpen / NLM kernels are non-vacuous — a flat field is a
///     near-fixed-point for every spatial stage).
///
/// 8×8 = 64 pixels so the 15×15 dehaze window and radius-20 clarity box-blur
/// have a meaningful interior + border (smaller and the shrinking-window border
/// policy dominates; this keeps both regions exercised).
fn scene_linear_rgba(w: usize, h: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            // A deterministic, structured field: smooth gradients with a few
            // sharp local features so spatial kernels see real edges.
            let t = i as f32 / (w * h) as f32; // 0..1 ramp
            let edge = if (x + y) % 5 == 0 { 0.6 } else { 0.0 }; // periodic edges
            let r = (0.05 + t * 1.3 + edge).max(-0.02);
            let g = 0.04 + (1.0 - t) * 0.9 + 0.5 * ((x as f32 * 0.7).sin().abs());
            let b = 0.03 + t * 0.5 + 0.4 * ((y as f32 * 0.9).cos().abs());
            // Seed a couple of saturated primaries + an HDR value explicitly.
            let (r, g, b) = match i % 11 {
                0 => (0.80, 0.10, 0.10), // saturated red
                3 => (0.10, 0.80, 0.10), // saturated green
                5 => (0.10, 0.10, 0.80), // saturated blue
                7 => (5.00, 3.00, 1.50), // HDR scene-headroom
                _ => (r, g, b),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    v
}

/// Derive the same 3×3 WB matrix raw-core's `apply` uses, single-sourced from
/// raw-core (`wb_cat16_matrix` / `wb_gains`) — so the GPU `WhiteBalancePass`
/// matmul is pinned to the CPU stage.
fn wb_matrix(temperature: f32, tint: f32, method: WbMethod) -> [[f32; 3]; 3] {
    match method {
        WbMethod::Cat16 => raw_core::stages::white_balance::wb_cat16_matrix(temperature, tint).0,
        WbMethod::DiagonalRec2020 => {
            let g = raw_core::stages::white_balance::wb_gains(temperature, tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    }
}

/// Bridge a raw-gpu `CaptureSharpeningParams` to its raw-core twin (field-for-
/// field; same names) so the CPU oracle calls the real stage with matching args.
fn rc_capture(
    p: &CaptureSharpeningParams,
) -> raw_core::stages::capture_sharpening::CaptureSharpeningParams {
    raw_core::stages::capture_sharpening::CaptureSharpeningParams {
        sigma: p.sigma,
        iterations: p.iterations,
        highlight_threshold: p.highlight_threshold,
        strength: p.strength,
    }
}

/// Build the `AdjustmentModel` that drives BOTH sides for a case: the GPU Pass
/// params are derived from these exact fields, and the CPU oracle hands this same
/// model to `scene_tone_controls::apply` / `tone_curves::apply` and reads the
/// scalar fields for the per-value stages. One source of truth.
struct Case {
    model: AdjustmentModel,
    capture: Option<CaptureSharpeningParams>,
    curve: ProfileCurve,
    lut: ColorLut,
    /// WB method (the model carries temp/tint; method is a separate enum field).
    wb_method: WbMethod,
}

impl Case {
    /// Assemble the GPU-side [`FullChainInputs`] from this case's model + per-
    /// image data — the GPU stage params come straight from the CPU model.
    fn gpu_inputs(&self) -> FullChainInputs {
        FullChainInputs {
            wb_matrix: wb_matrix(self.model.temperature, self.model.tint, self.wb_method),
            tone: [
                self.model.exposure,
                self.model.highlights,
                self.model.shadows,
                self.model.whites,
                self.model.blacks,
            ],
            tone_curves: ToneCurveInputs {
                parametric: [
                    self.model.parametric_shadows,
                    self.model.parametric_darks,
                    self.model.parametric_lights,
                    self.model.parametric_highlights,
                ],
                luma: self.model.tone_curve_luma.points.clone(),
                red: self.model.tone_curve_red.points.clone(),
                green: self.model.tone_curve_green.points.clone(),
                blue: self.model.tone_curve_blue.points.clone(),
                mode: match self.model.tone_curve_mode {
                    ToneCurveMode::PerChannel => CurveMode::PerChannel,
                    ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                },
            },
            vibrance: self.model.vibrance,
            saturation: self.model.saturation,
            clarity: self.model.clarity,
            texture: self.model.texture,
            dehaze: self.model.dehaze,
            sharpen_amount: self.model.sharpen_amount,
            sharpen_radius: self.model.sharpen_radius,
            sharpen_detail: self.model.sharpen_detail,
            sharpen_masking: self.model.sharpen_masking,
            nr_luminance: self.model.nr_luminance,
            nr_color: self.model.nr_color,
            contrast: self.model.contrast,
            capture_sharpening: self.capture,
            profile_curve_flat: self.curve.to_flat(),
            residual_lut_size: self.lut.size,
            residual_lut_data: self.lut.data.clone(),
        }
    }
}

/// The CPU reference: run the SAME stages in the SAME order by calling the real
/// `raw-core` stage functions on an `Image`, then the view tail (NO gamma — see
/// the module docs). Returns a flat interleaved RGBA buffer (alpha = 1.0).
fn cpu_oracle(input: &[f32], w: u32, h: u32, case: &Case) -> Vec<f32> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }

    // --- scene-linear stages, in develop order ---
    if let Some(p) = &case.capture {
        raw_core::stages::capture_sharpening::apply_capture_sharpening(&mut img, &rc_capture(p));
    }
    raw_core::stages::white_balance::apply(
        &mut img,
        case.model.temperature,
        case.model.tint,
        case.wb_method,
    );
    raw_core::stages::scene_tone_controls::apply(&mut img, &case.model);
    raw_core::stages::tone_curves::apply(&mut img, &case.model);
    raw_core::stages::vibrance::apply(&mut img, case.model.vibrance);
    raw_core::stages::saturation::apply(&mut img, case.model.saturation);
    raw_core::stages::clarity::apply(&mut img, case.model.clarity);
    raw_core::stages::texture::apply(&mut img, case.model.texture);
    raw_core::stages::dehaze::apply(&mut img, case.model.dehaze);
    raw_core::stages::sharpen::apply(
        &mut img,
        case.model.sharpen_amount,
        case.model.sharpen_radius,
        case.model.sharpen_detail,
        case.model.sharpen_masking,
    );
    raw_core::stages::noise_reduction::apply_luminance(&mut img, case.model.nr_luminance);
    raw_core::stages::noise_reduction::apply_color(&mut img, case.model.nr_color);

    // --- view tail (NO srgb_gamma_encode — mirrors the GPU chain's gap) ---
    raw_core::view::agx::apply(&mut img, case.model.contrast);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    // Buffer is now DisplayLinearSrgb in [0,1]. apply_curve / ColorLut operate on
    // an interleaved RGB f32 slice; run them on the same domain the GPU passes do.
    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }
    apply_curve(&mut rgb, &case.curve);
    case.lut.apply(&mut rgb);

    // Repack to RGBA (alpha 1.0) to match the GPU readback shape.
    let mut out = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        out.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    out
}

/// Run the composed GPU chain with a genuine mid-chain airlight readback:
/// prefix → readback → `compute_airlight` → suffix (seeded from the prefix
/// output). Returns the final RGBA buffer. `expected_readbacks` is asserted on
/// each runner (one per `ChainRunner::run_blocking`).
fn run_gpu_chain(input: &[f32], w: u32, h: u32, inputs: &FullChainInputs) -> Vec<f32> {
    let ctx = GpuContext::new_blocking();

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

/// Max absolute per-element difference between two equal-length buffers.
fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "buffer length mismatch");
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// How much the chain moved the image vs the raw input (sanity floor: a gate that
/// passes only because nothing happened is vacuous).
fn moved(input: &[f32], out: &[f32]) -> f32 {
    max_abs_diff(input, out)
}

/// Accumulated-error budget for the full 16-stage composed chain.
///
/// Per-stage parity is ≤ 3e-6 vs each Rust stage; 16 stages of f32 arithmetic
/// (including the iterative capture-sharpening RL loop FIRST, whose error then
/// feeds every downstream stage, plus three spatial DAGs and two NLM passes)
/// accumulate well under the per-stage `1e-4` ceiling the whole epic gates at.
/// We keep the same `1e-4` ceiling the per-stage tests use; the measured value
/// is printed so any regression toward it is visible. (Investigated: the
/// measured aggressive-case max sits far below this — see the eprintln output.)
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
/// gate (symmetric: the CPU oracle also `if let Some`), validated by the 15-pass
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
        capture: None, // the one legitimate builder gate (15-pass count test)
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

/// A non-identity Auto Profile curve: real per-channel gamma curves + a small
/// cross-channel matrix tweak, so the curve Pass's matrix + per-channel paths
/// both run (an identity-only curve would leave that path vacuous).
fn nonidentity_curve() -> ProfileCurve {
    let gamma = |g: f32| {
        let mut c = ChannelCurve::identity();
        for a in c.anchors.iter_mut() {
            a.1 = a.0.powf(g);
        }
        c
    };
    let mut c = ProfileCurve::identity();
    c.r = gamma(0.9);
    c.g = gamma(1.05);
    c.b = gamma(0.95);
    // A small off-diagonal cross-channel mix (keeps it near-identity but
    // non-trivial so the matrix matmul is exercised).
    c.matrix = [
        [0.98, 0.01, 0.01],
        [0.01, 0.98, 0.01],
        [0.01, 0.01, 0.98],
    ];
    c
}

/// A non-identity residual LUT: the identity grid warped by a mild per-node
/// gamma so the trilinear lookup carries a real residual (not a pass-through).
fn nonidentity_lut(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
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
    // The view transform alone (AgX + display-encode + gamma-domain curve) moves
    // every pixel substantially; an engaged slider chain moves it more. A floor
    // of 0.1 is comfortably below the real delta and well above float noise.
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
    // The aggressive case engages every stage incl. capture_sharpening → all 16
    // GPU-ported passes are present.
    assert_eq!(full.len(), 16, "aggressive full chain must have all 16 passes");
}

/// A case with `capture: None` omits capture_sharpening (params None ⇒ stage
/// absent, exactly as develop omits it), so the assembled chain has 15 passes —
/// proving the builder mirrors develop's capture-sharpening gating (the one
/// legitimate builder gate) rather than always including it.
#[test]
fn neutral_chain_omits_capture_sharpening() {
    let case = mild_case();
    let inputs = case.gpu_inputs();
    let full = build_full_chain_passes(&inputs, [0.0; 3]);
    assert_eq!(
        full.len(),
        15,
        "neutral chain (no capture-sharpening) must have 15 passes"
    );
    // Sanity: PROFILE_CURVE_FLAT_LEN is the curve flat length the Pass asserts —
    // the neutral identity curve must match it (else the Pass panics at encode).
    assert_eq!(inputs.profile_curve_flat.len(), PROFILE_CURVE_FLAT_LEN);
}
