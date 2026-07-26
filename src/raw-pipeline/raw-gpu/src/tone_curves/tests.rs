//! Parity tests for the tone-curves WGSL kernel (epic #925 / #990).
//!
//! Split out of `tone_curves.rs` for the 600-LOC budget. Included via
//! `#[path = "tone_curves/tests.rs"] mod tests;` so it reaches the parent's
//! private items through `super::*`.
//!
//! The headless GPU kernel is gated DIRECTLY against the real
//! `raw_core::stages::tone_curves::apply` (the ticket's parity oracle), via the
//! test-only `raw-core` dev-dep, at `< 1e-4` per channel. A MATRIX of cases is
//! gated — no single config is a false green for an untested branch (the trap
//! auto_profile_curve's tests.rs warns about):
//!   - all-default                 -> full no-op (every flag off)
//!   - per-channel PerChannel      -> per-lane hue shift
//!   - same curves RatioPreserving -> the required hue-preserving mode
//!   - parametric-only             -> the parametric luma-coupled branch
//!   - luma-only                   -> the tone_curve_luma luma-coupled branch
//!   - combined (all four)         -> proves the sequencing parametric->luma->per
//!
//! The non-default cases use channel values > 1 and <= 0 so the REF_MAX clamp and
//! the per-sub-step skip branches fire.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::image::{ColorSpace, Image};
use raw_core::types::adjustment::ToneCurve;
use raw_core::{AdjustmentModel, ToneCurveMode};

/// An RGBA test buffer spanning the stage's domain + skip branches:
///   - shadow/mid/highlight greys (the curve interpolant across authoring x),
///   - off-diagonal colors (so per-channel curves can't agree by symmetry),
///   - HDR-headroom values > REF_MAX (the eval_curve_scene_linear x-clamp),
///   - a zero pixel + a slightly-negative-luma-ish pixel (the Y<=0 / v<=0 skips).
fn tc_rgba() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.05, 0.08, 0.03, 1.0, // deep shadow
        0.20, 0.35, 0.15, 0.8, // shadow-mid, off-diagonal
        0.45, 0.50, 0.55, 1.0, // midtone, off-diagonal
        0.72, 0.65, 0.80, 0.6, // highlight-mid, off-diagonal
        1.20, 0.90, 1.10, 1.0, // > diffuse-white, < REF_MAX
        5.00, 4.50, 6.00, 1.0, // > REF_MAX (x-clamp to 1.0)
        0.95, 0.10, 0.30, 1.0, // saturated, off-diagonal
        0.00, 0.00, 0.00, 1.0, // pure black -> Y<=0 / v<=0 skips
        0.40, 0.00, 0.10, 0.5, // mixed: G lane skips (v<=0) in PerChannel
        -0.08, 0.50, 0.20, 0.9, // strictly-negative R -> v<=0 / Y still > 0
        0.30, 0.60, 0.45, 0.9, // generic mid
    ]
}

/// Build the model-equivalent [`ToneCurveInputs`] AND the matching raw-core
/// `AdjustmentModel` from the same source fields, so both sides see identical
/// curves (the parity gate compares the GPU run of the inputs against raw-core's
/// run of the model).
struct Case {
    parametric: [f32; 4], // shadows, darks, lights, highlights
    luma: Vec<(f32, f32)>,
    red: Vec<(f32, f32)>,
    green: Vec<(f32, f32)>,
    blue: Vec<(f32, f32)>,
    ratio_preserving: bool,
}

impl Case {
    fn inputs(&self) -> ToneCurveInputs {
        ToneCurveInputs {
            parametric: self.parametric,
            luma: self.luma.clone(),
            red: self.red.clone(),
            green: self.green.clone(),
            blue: self.blue.clone(),
            mode: if self.ratio_preserving {
                CurveMode::RatioPreserving
            } else {
                CurveMode::PerChannel
            },
        }
    }

    fn model(&self) -> AdjustmentModel {
        AdjustmentModel {
            parametric_shadows: self.parametric[0],
            parametric_darks: self.parametric[1],
            parametric_lights: self.parametric[2],
            parametric_highlights: self.parametric[3],
            tone_curve_luma: ToneCurve::new(self.luma.clone()),
            tone_curve_red: ToneCurve::new(self.red.clone()),
            tone_curve_green: ToneCurve::new(self.green.clone()),
            tone_curve_blue: ToneCurve::new(self.blue.clone()),
            tone_curve_mode: if self.ratio_preserving {
                ToneCurveMode::RatioPreserving
            } else {
                ToneCurveMode::PerChannel
            },
            ..Default::default()
        }
    }
}

/// Run the REAL `raw_core::stages::tone_curves::apply` on the RGB lanes of `rgba`
/// (built into a `SceneLinearRec2020` Image), returning a full RGBA buffer (alpha
/// carried through). THE reference — the actual Rust stage, not a reimplementation.
fn raw_core_apply(rgba: &[f32], model: &AdjustmentModel) -> Vec<f32> {
    let count = rgba.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in rgba.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::tone_curves::apply(&mut img, model);
    let mut out = Vec::with_capacity(rgba.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], rgba[i * 4 + 3]]);
    }
    out
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// A smooth non-identity S-ish contrast curve (anchors authored by hand so the
/// Fritsch-Carlson interpolant runs across real, non-linear knots).
fn s_curve() -> Vec<(f32, f32)> {
    vec![
        (0.0, 0.0),
        (0.25, 0.18),
        (0.5, 0.5),
        (0.75, 0.82),
        (1.0, 1.0),
    ]
}
/// A brightening lift curve (distinct from `s_curve` so per-channel curves
/// differ across lanes).
fn lift_curve() -> Vec<(f32, f32)> {
    vec![(0.0, 0.05), (0.5, 0.62), (1.0, 1.0)]
}
/// A darkening curve.
fn pull_curve() -> Vec<(f32, f32)> {
    vec![(0.0, 0.0), (0.5, 0.40), (1.0, 0.95)]
}

/// The full case matrix. Each (label, Case) is gated independently.
fn cases() -> Vec<(&'static str, Case)> {
    vec![
        (
            "all-default-noop",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: vec![],
                red: vec![],
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
        (
            "per-channel-perchannel",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: vec![],
                red: s_curve(),
                green: lift_curve(),
                blue: pull_curve(),
                ratio_preserving: false,
            },
        ),
        (
            "per-channel-ratio-preserving",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: vec![],
                red: s_curve(),
                green: lift_curve(),
                blue: pull_curve(),
                ratio_preserving: true,
            },
        ),
        (
            "parametric-only",
            Case {
                parametric: [60.0, -20.0, 30.0, -50.0],
                luma: vec![],
                red: vec![],
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
        (
            "luma-only",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: s_curve(),
                red: vec![],
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
        (
            "combined-all",
            Case {
                parametric: [40.0, 10.0, -15.0, 25.0],
                luma: lift_curve(),
                red: s_curve(),
                green: pull_curve(),
                blue: lift_curve(),
                ratio_preserving: false,
            },
        ),
        // per_channel_active == true but G/B lanes are IDENTITY (empty). Exercises
        // the `eval_curve_scene_linear` len-0 -> v pass-through INSIDE an active
        // per-channel block — for PerChannel this matches raw-core's per-lane
        // `is_identity` early-return (the empty slot is a no-op on G/B).
        (
            "mixed-identity-perchannel",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: vec![],
                red: s_curve(),
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
        // Same, RatioPreserving: the identity G/B lanes must run as empty-knot
        // pass-through (g_prime = b_prime = y_in) so their unchanged luma rides the
        // Y_out sum — the load-bearing "identity lane carries unchanged luma" path.
        (
            "mixed-identity-ratio",
            Case {
                parametric: [0.0, 0.0, 0.0, 0.0],
                luma: vec![],
                red: s_curve(),
                green: vec![],
                blue: vec![],
                ratio_preserving: true,
            },
        ),
        // #2318: the region model gives each slider its own window, so the
        // opposing pairs a user actually sets have to survive the CPU->GPU
        // transcription of the new analytic tangents. The first is the
        // committed `test_0000/xmp/parametric_mixed.xmp` setting; the second
        // is the worst case for the monotonicity bound (adjacent regions at
        // full opposing deflection).
        (
            "parametric-mixed-fixture",
            Case {
                parametric: [-75.0, 50.0, -50.0, 75.0],
                luma: vec![],
                red: vec![],
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
        (
            "parametric-opposing-extremes",
            Case {
                parametric: [100.0, -100.0, 100.0, -100.0],
                luma: vec![],
                red: vec![],
                green: vec![],
                blue: vec![],
                ratio_preserving: false,
            },
        ),
    ]
}

/// THE PARITY GATE (the ticket's contract): the WGSL tone-curves kernel matches
/// the REAL `stages::tone_curves::apply` within 1e-4 across the whole case matrix
/// — covering the no-op, PerChannel, RatioPreserving, parametric-only, luma-only,
/// and combined-sequencing branches. Any single case alone would be a false green
/// for the branches it doesn't touch.
#[test]
fn wgsl_tone_curves_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;

    for (label, case) in cases() {
        let model = case.model();
        let reference = raw_core_apply(&input, &model);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ToneCurvesPass {
            inputs: case.inputs(),
        }]);

        let max_diff = max_abs_diff(&reference, &gpu);
        eprintln!("PARITY vs raw-core tone_curves::apply [{label}]: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs raw-core tone_curves::apply max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_tone_curves`) to the real stage too, so the
/// convenience oracle this crate exports can't silently drift. Covers the whole
/// matrix. (The GPU gate above doesn't depend on the local oracle.)
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let input = tc_rgba();
    for (label, case) in cases() {
        let model = case.model();
        let reference = raw_core_apply(&input, &model);
        let mut local = input.clone();
        apply_tone_curves(&mut local, &case.inputs());
        let max_diff = max_abs_diff(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "[{label}]: local oracle vs raw-core tone_curves::apply diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU oracle
/// within 1e-4 (no raw-core dep needed to run). Fast, dependency-free signal
/// alongside the raw-core gate; mirrors the vibrance / auto_profile_curve precedent.
#[test]
fn wgsl_tone_curves_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;

    for (label, case) in cases() {
        let inputs = case.inputs();
        let mut cpu = input.clone();
        apply_tone_curves(&mut cpu, &inputs);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ToneCurvesPass { inputs }]);

        let max_diff = max_abs_diff(&cpu, &gpu);
        eprintln!("PARITY [{label}]: GPU vs CPU oracle max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// The all-default case is a TRUE no-op on the GPU (bit-identical to the input
/// within [0, 1]): every flag is off, so the kernel writes the pixel through. This
/// is the load-bearing "baseline pipeline is unperturbed" invariant — an empty
/// curve must land in the len-0 -> pass-through path, not the len-1 constant path.
#[test]
fn all_default_is_exact_passthrough_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;
    let inputs = ToneCurveInputs {
        parametric: [0.0, 0.0, 0.0, 0.0],
        luma: vec![],
        red: vec![],
        green: vec![],
        blue: vec![],
        mode: CurveMode::PerChannel,
    };
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ToneCurvesPass { inputs }]);
    let max_diff = max_abs_diff(&input, &gpu);
    assert!(
        max_diff < 1e-6,
        "all-default tone curves must be exact passthrough; max diff {max_diff}"
    );
}

/// Alpha is carried through untouched by the GPU kernel (the stage touches only
/// RGB). Mirrors the per-stage alpha-passthrough contract.
#[test]
fn gpu_alpha_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;
    let inputs = Case {
        parametric: [40.0, 10.0, -15.0, 25.0],
        luma: lift_curve(),
        red: s_curve(),
        green: pull_curve(),
        blue: lift_curve(),
        ratio_preserving: false,
    }
    .inputs();
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ToneCurvesPass { inputs }]);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        assert_eq!(
            gpu[i * 4 + 3],
            chunk[3],
            "alpha changed at pixel {i}: {} -> {}",
            chunk[3],
            gpu[i * 4 + 3]
        );
    }
}

/// PerChannel and RatioPreserving produce DIFFERENT output on the same per-channel
/// curves (proves the mode dispatch is real, not a contrast-0-style false green).
/// PerChannel shifts hue (per-lane); RatioPreserving preserves R:G:B ratios.
#[test]
fn per_channel_and_ratio_preserving_differ() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;
    let per = Case {
        parametric: [0.0; 4],
        luma: vec![],
        red: s_curve(),
        green: lift_curve(),
        blue: pull_curve(),
        ratio_preserving: false,
    }
    .inputs();
    let ratio = Case {
        parametric: [0.0; 4],
        luma: vec![],
        red: s_curve(),
        green: lift_curve(),
        blue: pull_curve(),
        ratio_preserving: true,
    }
    .inputs();

    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let a = runner.run_blocking(&[&ToneCurvesPass { inputs: per }]);
    let b = runner.run_blocking(&[&ToneCurvesPass { inputs: ratio }]);
    let diff = max_abs_diff(&a, &b);
    assert!(
        diff > 1e-2,
        "PerChannel and RatioPreserving outputs are ~identical (max diff {diff}); mode dispatch dead?"
    );
}
