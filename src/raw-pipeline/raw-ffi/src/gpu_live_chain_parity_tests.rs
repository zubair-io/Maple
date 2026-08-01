//! **#1732 legs (a) vs (b), beyond WB.** The gpu-live chain against the CPU
//! chain the editor actually falls back to — `raw_core::pipeline::
//! apply_scene_linear_chain_f32` — over a parameterised `AdjustmentModel`
//! set, plus the non-RAW input shape.
//!
//! ## Why this is not already covered
//!
//! Two existing gates sit either side of this one and neither closes it:
//!
//! * `raw-gpu`'s `full_chain::tests::full_gpu_chain_matches_composed_cpu_oracle`
//!   compares the GPU chain against a CPU oracle that `raw-gpu`'s own test
//!   file COMPOSES stage by stage. That oracle is a re-implementation of the
//!   chain order, not the chain — it can agree with the GPU perfectly while
//!   both disagree with `apply_scene_linear_chain_f32`, which is what a host
//!   with no GPU adapter renders with.
//! * The sibling `gpu_live_wb_frame_tests.rs` (#1781) DOES hold the GPU to a
//!   shared raw-core function, but only for white balance, with a hand-rolled
//!   `WB + AgX + encode` tail.
//!
//! This file drives the real `apply_scene_linear_chain_f32` — every stage, in
//! the chain's own order — and holds the GPU surface to it.
//!
//! ## The non-RAW half (`skip_agx` ⟷ `input_shape`)
//!
//! The ticket calls out that `ChainOptions::skip_agx` and the FFI
//! `input_shape` tag are the two sides of the non-RAW path and nothing gates
//! them against each other. They are still INDEPENDENT fields at the ABI:
//! `MapleAdjustmentParams` carries `skip_agx` and `input_shape` separately
//! (`scene_linear_chain.rs`), `MapleGpuLiveParams` carries only
//! `input_shape`, and the GPU chain derives the view-tail skip from the
//! shape alone (`raw_gpu::live_chain::build_live_split`'s `is_raw_shape`).
//! So a host that tags a JPEG session `input_shape = 2` but leaves
//! `skip_agx = 0` gets AgX on the refine path and no AgX live. This file
//! pins the matched pair — GPU `input_shape = 2` must equal CPU
//! `skip_agx = true` — and proves the coupling is load-bearing by showing
//! the mismatched pair diverges grossly.
//!
//! ## The WB contradiction the ticket opened with is CLOSED
//!
//! The ticket body documents a non-RAW live-vs-refine WB divergence
//! ("`scene_linear_chain` collapses WB to identity for non-RAW while
//! gpu-live applies a delta") and asks for it as the family's first RED
//! test. That contradiction was fixed by #1734; the gate for it is the
//! sibling `gpu_live_nonraw_wb_tests.rs`, which drives both FFI entries with
//! the same non-RAW `(live, decoded)` pair and passes. The non-RAW case here
//! is the beyond-WB half of the same shape: same tag, tone/colour stages
//! instead of temperature/tint.
//!
//! ## Where this runs
//!
//! Real GPU adapter required (`--features gpu`), like every sibling in this
//! family. #1973 put `cargo test -p raw-gpu` and `cargo test -p raw-wasm
//! --features gpu` on a lavapipe runner, but NOT `cargo test -p raw-ffi
//! --features gpu` — CI's raw-ffi steps are `cargo build -p raw-ffi
//! --features gpu` (compile only) plus `cargo test -p raw-ffi --lib` with
//! the feature OFF. So this gate is LOCAL-ONLY today, on Metal.

use super::gpu_live_tests::{make_params, owned_arrays, scene_linear_rgba};
use super::gpu_live_wb_frame_tests::gpu_render;
use raw_core::pipeline::{apply_scene_linear_chain_f32, encode_display_srgb_f32, ChainOptions};
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// The decode anchor both paths are told the buffer was developed at. D65
/// neutral keeps WB an exact identity for every case here, so what the
/// comparison measures is the rest of the chain — WB itself is the sibling
/// `gpu_live_wb_frame_tests.rs`' subject.
const ANCHOR: (f32, f32) = (6500.0, 0.0);

/// Fixture size. Larger than the 8x8 the sibling gates use, because this one
/// measures an 8-BIT surface: a stage that drifts by a fraction of a code
/// value only becomes visible where the drift happens to straddle a
/// quantisation boundary, and 64 pixels give it too few chances. Measured on
/// a deliberately mis-scaled `VibrancePass`, 8x8 needed a ~50% slider drift
/// before any byte moved; 32x32 catches a few percent.
const DIMS: (u32, u32) = (32, 32);

/// **The CPU leg (b).** `apply_scene_linear_chain_f32` — the real per-tick
/// chain, not a re-composition of it — followed by the same view tail the
/// GPU appends after its scene-linear passes:
///
/// * `encode_display_srgb_f32` mirrors `DisplayEncodePass` + `SrgbGammaPass`.
///   At `skip_agx = false` the chain really does hand back display-linear
///   Rec.2020 and this is the encode its callers owe it. At `skip_agx = true`
///   the buffer is still SCENE-linear — the encode helper re-tags it
///   `DisplayLinearRec2020` on the way in and encodes anyway. That is not a
///   fudge for the test's benefit: it is exactly what the GPU does, since
///   `DisplayEncodePass` + `SrgbGammaPass` run for non-RAW shapes too and
///   the WGSL has no colour-space tag to consult. Both sides encode an
///   already-display-referred JPEG buffer as if it were display-linear,
///   which is what makes them comparable;
/// * the identity Auto-Profile curve + residual LUT mirror
///   `AutoProfileCurvePass` + `ResidualLutPass`, which the GPU appends for
///   RAW shapes ONLY — so this reference appends them only when `skip_agx`
///   is false, matching `build_live_split`'s `is_raw_shape` gate (#1516);
/// * `dither_and_quantize` is the shared terminal pass, called here through
///   raw-gpu's own export so there is no second implementation to drift.
fn cpu_reference(input: &[f32], model: &AdjustmentModel, skip_agx: bool) -> Vec<u8> {
    let (w, h) = DIMS;
    let chained = apply_scene_linear_chain_f32(
        input,
        w,
        h,
        model,
        &ChainOptions {
            decoded_temp: ANCHOR.0,
            decoded_tint: ANCHOR.1,
            skip_agx,
            ..ChainOptions::default()
        },
    )
    .expect("cpu scene-linear chain");
    let encoded = encode_display_srgb_f32(&chained, w, h).expect("display encode");
    let rgba = if skip_agx {
        encoded
    } else {
        let mut rgb: Vec<f32> = encoded
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        raw_core::view::auto_profile::apply::apply_curve(&mut rgb, &ProfileCurve::identity());
        ColorLut::identity(2).apply(&mut rgb);
        rgb.chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 1.0])
            .collect()
    };
    raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
}

/// Render `model` through the gpu-live FFI at `input_shape`, wiring the same
/// identity Auto-Profile artifacts [`cpu_reference`] assumes.
fn gpu_surface(input: &[f32], model: &AdjustmentModel, input_shape: u32) -> Vec<u8> {
    let (w, h) = DIMS;
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let arr = owned_arrays(model, &curve, &lut);
    let mut p = make_params(model, WbMethod::Cat16, 2, &arr);
    p.decoded_temperature = ANCHOR.0;
    p.decoded_tint = ANCHOR.1;
    p.input_shape = input_shape;
    gpu_render(input, w, h, &p)
}

/// Base model for every case: WB parked at the anchor (identity delta), and
/// the stages whose `AdjustmentModel::default()` values are NON-zero
/// (`sharpen_amount` = 40, `nr_color` = 25) zeroed.
///
/// The SLIDER-DRIVEN spatial stages — sharpen, luma/chroma NR, clarity,
/// texture — stay out of every case on purpose. Their GPU kernels are gated
/// per-kernel against their raw-core counterparts by `raw-gpu`'s own suite,
/// and a separable blur or guided filter on a small fixture is largely
/// edge-clamped, contributing boundary-condition noise to a measurement about
/// chain composition. What this file adds that the per-kernel suite cannot is
/// the ORDER and the tail.
///
/// Note that this does NOT make every case a pure point op: `highlights` and
/// `shadows` run through `scene_tone_controls`' masked passes, which blur a
/// luma plane. That is deliberate and safe here — unlike the tile gate in
/// raw-core, both sides of THIS comparison run the mask over the identical
/// buffer at the identical dimensions, so the mask radius matches and the
/// boundary is the same one. (When the buffers differ in size it does not
/// match, which is #2476.)
fn base_model() -> AdjustmentModel {
    AdjustmentModel {
        temperature: ANCHOR.0,
        tint: ANCHOR.1,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        clarity: 0.0,
        texture: 0.0,
        ..AdjustmentModel::default()
    }
}

/// The parameterised set, one case per stage class the chain composes.
fn cases() -> Vec<(&'static str, AdjustmentModel)> {
    vec![
        (
            "scene tone block",
            AdjustmentModel {
                exposure: 0.5,
                brightness: 20.0,
                highlights: -35.0,
                shadows: 30.0,
                whites: 15.0,
                blacks: -20.0,
                ..base_model()
            },
        ),
        (
            "colour block (vibrance/saturation/HSL)",
            AdjustmentModel {
                vibrance: 40.0,
                saturation: -25.0,
                hue_adjustment_orange: 20.0,
                saturation_adjustment_blue: -30.0,
                luminance_adjustment_green: 25.0,
                ..base_model()
            },
        ),
        (
            "display-domain look (contrast/colour grade/grain)",
            AdjustmentModel {
                contrast: 35.0,
                color_grade_midtone_hue: 210.0,
                color_grade_midtone_saturation: 30.0,
                color_grade_highlight_luminance: 15.0,
                split_tone_shadow_hue: 30.0,
                split_tone_shadow_saturation: 25.0,
                ..base_model()
            },
        ),
        (
            "combined",
            AdjustmentModel {
                exposure: -0.3,
                brightness: -15.0,
                shadows: 25.0,
                vibrance: 30.0,
                saturation: 10.0,
                contrast: 20.0,
                color_grade_global_saturation: 20.0,
                color_grade_global_hue: 45.0,
                ..base_model()
            },
        ),
    ]
}

/// Compare two u8 RGB surfaces, returning `(max byte delta, mismatch
/// fraction)`.
fn compare(a: &[u8], b: &[u8]) -> (u16, f64) {
    assert_eq!(a.len(), b.len(), "surface length mismatch");
    let max_delta = a
        .iter()
        .zip(b)
        .map(|(x, y)| (*x as i16 - *y as i16).unsigned_abs())
        .max()
        .unwrap();
    let mismatches = a.iter().zip(b).filter(|(x, y)| x != y).count();
    (max_delta, mismatches as f64 / a.len() as f64)
}

/// How far a case's own output must sit from a neutral render before its
/// agreement number means anything. In u8 bytes — a case that moved the
/// surface by under 8 levels would let a chain that dropped several stages
/// still pass at "≤ 1 LSB".
const MIN_CASE_EFFECT_BYTES: u16 = 8;

/// **THE GATE.** For every case, the gpu-live u8 surface must match the CPU
/// composition of `apply_scene_linear_chain_f32` + the view tail + dither
/// within one byte.
#[test]
fn gpu_live_matches_cpu_scene_linear_chain_across_models() {
    let (w, h) = DIMS;
    let input = scene_linear_rgba(w as usize, h as usize);
    let neutral = cpu_reference(&input, &base_model(), false);

    for (name, model) in cases() {
        let gpu = gpu_surface(&input, &model, 0);
        let cpu = cpu_reference(&input, &model, false);
        let (max_delta, frac) = compare(&gpu, &cpu);
        let (moved, _) = compare(&cpu, &neutral);
        eprintln!(
            "[{name}] gpu-live vs scene_linear_chain: max byte delta {max_delta}, \
             mismatch fraction {frac:.4} (case moved the surface by {moved} bytes)"
        );
        assert!(
            moved >= MIN_CASE_EFFECT_BYTES,
            "[{name}] case moved the surface by only {moved} bytes — too close \
             to the neutral render for a 1-LSB ceiling to gate anything"
        );
        assert!(
            max_delta <= 1,
            "[{name}] gpu-live vs scene_linear_chain max byte delta {max_delta} > 1"
        );
        assert!(
            frac <= 0.05,
            "[{name}] gpu-live vs scene_linear_chain mismatch fraction {frac:.4} > 0.05"
        );
    }
}

/// **THE NON-RAW GATE.** With the FFI's `input_shape = 2`
/// (`SrgbGammaEncoded8` — JPEG / HEIF), the gpu-live chain drops AgX and the
/// Auto-Profile look and keeps only the colorimetric encode. The CPU chain
/// reaches the same tail through a DIFFERENT switch — `ChainOptions::
/// skip_agx` — and the two are not derived from one another anywhere in the
/// codebase. This asserts they land on the same pixels for a model that
/// engages real tone and colour work, not just white balance.
///
/// The second half is what stops this being a tautology: driving the CPU
/// side with `skip_agx = false` (the mismatched pair a host gets by tagging
/// the shape and forgetting the flag) must diverge grossly. If it did not,
/// the first assertion would be passing because the shape tag does nothing.
#[test]
fn nonraw_shape_gpu_live_matches_cpu_chain_with_skip_agx() {
    let (w, h) = DIMS;
    let input = scene_linear_rgba(w as usize, h as usize);
    // Colour-grade / grain are LEFT OUT deliberately: for a non-RAW shape the
    // GPU chain still runs them (they are gated only on their own sliders,
    // not on `is_raw_shape`) while the CPU chain skips them with AgX, because
    // `grain::apply` / `color_grade::apply` assert a DisplayLinearRec2020
    // buffer the skip_agx path never produces. That asymmetry is a stage
    // colour-space contract, not the tail switch this gate is about; #2478.
    let model = AdjustmentModel {
        exposure: 0.4,
        brightness: 15.0,
        shadows: 25.0,
        vibrance: 35.0,
        saturation: -20.0,
        hue_adjustment_orange: 15.0,
        ..base_model()
    };

    let gpu = gpu_surface(&input, &model, 2);
    let cpu_skip = cpu_reference(&input, &model, true);
    let (max_delta, frac) = compare(&gpu, &cpu_skip);
    eprintln!(
        "[non-RAW] gpu-live(input_shape=2) vs scene_linear_chain(skip_agx=true): \
         max byte delta {max_delta}, mismatch fraction {frac:.4}"
    );
    assert!(
        max_delta <= 1,
        "non-RAW gpu-live vs CPU skip_agx max byte delta {max_delta} > 1 — the \
         input_shape tag and ChainOptions::skip_agx have desynchronised"
    );
    assert!(
        frac <= 0.05,
        "non-RAW gpu-live vs CPU skip_agx mismatch fraction {frac:.4} > 0.05"
    );

    let cpu_agx = cpu_reference(&input, &model, false);
    let (mismatch_delta, _) = compare(&cpu_skip, &cpu_agx);
    eprintln!("[non-RAW] skip_agx=true vs skip_agx=false differ by {mismatch_delta} bytes");
    assert!(
        mismatch_delta > 16,
        "skip_agx made almost no difference ({mismatch_delta} bytes), so the \
         assertion above would hold no matter which tail either path picked — \
         this gate has stopped gating"
    );
}
