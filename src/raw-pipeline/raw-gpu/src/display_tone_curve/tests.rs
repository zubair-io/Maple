//! Parity tests for the display-referred tone-curves WGSL kernel (#2232).
//!
//! Split out of `display_tone_curve.rs` for the 600-LOC budget. Included via
//! `#[path = "display_tone_curve/tests.rs"] mod tests;` so it reaches the
//! parent's private items through `super::*`.
//!
//! The headless GPU kernel is gated DIRECTLY against the real
//! `raw_core::stages::display_tone_curve::apply` (the ticket's parity
//! oracle), via the test-only `raw-core` dev-dep, at `< 1e-4` per channel. A
//! MATRIX of cases is gated — no single config is a false green for an
//! untested branch:
//!   - all-default              -> full no-op
//!   - master-only              -> per-channel-independent (NOT luma-coupled)
//!   - per-channel-only         -> R/G/B curves with no master
//!   - combined                 -> master THEN per-channel composition order
//!   - mixed-identity           -> only one of the four curves authored

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::image::{ColorSpace, Image};
use raw_core::types::adjustment::ToneCurve;
use raw_core::AdjustmentModel;

/// An RGBA test buffer spanning the stage's domain (post-AgX, `[0, 1]`) +
/// skip branches: shadow/mid/highlight greys, off-diagonal colors (so
/// per-channel curves can't agree by symmetry), pure black/white endpoints,
/// and values that exercise the clamp (slightly out of `[0, 1]` — should
/// not occur post-AgX in practice, but the evaluator must be total).
fn tc_rgba() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.05, 0.08, 0.03, 1.0, // deep shadow
        0.20, 0.35, 0.15, 0.8, // shadow-mid, off-diagonal
        0.45, 0.50, 0.55, 1.0, // midtone, off-diagonal
        0.72, 0.65, 0.80, 0.6, // highlight-mid, off-diagonal
        0.95, 0.10, 0.30, 1.0, // saturated, off-diagonal
        0.00, 0.00, 0.00, 1.0, // pure black
        1.00, 1.00, 1.00, 1.0, // pure white
        0.40, 0.00, 0.10, 0.5, // mixed, one lane at zero
        -0.05, 0.50, 1.05, 0.9, // slightly out-of-range (clamp exercise)
        0.30, 0.60, 0.45, 0.9, // generic mid
    ]
}

/// Build the model-equivalent [`DisplayToneCurveInputs`] AND the matching
/// raw-core `AdjustmentModel` from the same source fields, so both sides
/// see identical curves.
struct Case {
    master: Vec<(f32, f32)>,
    red: Vec<(f32, f32)>,
    green: Vec<(f32, f32)>,
    blue: Vec<(f32, f32)>,
}

impl Case {
    fn inputs(&self) -> DisplayToneCurveInputs {
        DisplayToneCurveInputs {
            master: self.master.clone(),
            red: self.red.clone(),
            green: self.green.clone(),
            blue: self.blue.clone(),
        }
    }

    fn model(&self) -> AdjustmentModel {
        AdjustmentModel {
            display_tone_curve_luma: ToneCurve::new(self.master.clone()),
            display_tone_curve_red: ToneCurve::new(self.red.clone()),
            display_tone_curve_green: ToneCurve::new(self.green.clone()),
            display_tone_curve_blue: ToneCurve::new(self.blue.clone()),
            ..Default::default()
        }
    }
}

/// Run the REAL `raw_core::stages::display_tone_curve::apply` on the RGB
/// lanes of `rgba` (built into a `DisplayLinearRec2020` Image), returning a
/// full RGBA buffer (alpha carried through). THE reference.
fn raw_core_apply(rgba: &[f32], model: &AdjustmentModel) -> Vec<f32> {
    let count = rgba.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::DisplayLinearRec2020);
    for (i, chunk) in rgba.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::display_tone_curve::apply(&mut img, model);
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

/// A smooth non-identity S-ish contrast curve.
fn s_curve() -> Vec<(f32, f32)> {
    vec![(0.0, 0.0), (0.25, 0.18), (0.5, 0.5), (0.75, 0.82), (1.0, 1.0)]
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
                master: vec![],
                red: vec![],
                green: vec![],
                blue: vec![],
            },
        ),
        (
            "master-only",
            Case {
                master: s_curve(),
                red: vec![],
                green: vec![],
                blue: vec![],
            },
        ),
        (
            "per-channel-only",
            Case {
                master: vec![],
                red: s_curve(),
                green: lift_curve(),
                blue: pull_curve(),
            },
        ),
        (
            "combined-master-and-per-channel",
            Case {
                master: lift_curve(),
                red: s_curve(),
                green: pull_curve(),
                blue: lift_curve(),
            },
        ),
        (
            "mixed-identity-red-only",
            Case {
                master: vec![],
                red: s_curve(),
                green: vec![],
                blue: vec![],
            },
        ),
        (
            "single-point-constant",
            Case {
                master: vec![(0.5, 0.7)],
                red: vec![],
                green: vec![],
                blue: vec![],
            },
        ),
    ]
}

/// THE PARITY GATE (the ticket's contract): the WGSL display-tone-curve
/// kernel matches the REAL `stages::display_tone_curve::apply` within 1e-4
/// across the whole case matrix.
#[test]
fn wgsl_display_tone_curve_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;

    for (label, case) in cases() {
        let model = case.model();
        let reference = raw_core_apply(&input, &model);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DisplayToneCurvePass {
            inputs: case.inputs(),
        }]);

        let max_diff = max_abs_diff(&reference, &gpu);
        eprintln!(
            "PARITY vs raw-core display_tone_curve::apply [{label}]: max abs diff = {max_diff:e}"
        );
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs raw-core display_tone_curve::apply max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_display_tone_curve`) to the real stage
/// too, so the convenience oracle this crate exports can't silently drift.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let input = tc_rgba();
    for (label, case) in cases() {
        let model = case.model();
        let reference = raw_core_apply(&input, &model);
        let mut local = input.clone();
        apply_display_tone_curve(&mut local, &case.inputs());
        let max_diff = max_abs_diff(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "[{label}]: local oracle vs raw-core display_tone_curve::apply diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU
/// oracle within 1e-4 (no raw-core dep needed to run).
#[test]
fn wgsl_display_tone_curve_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;

    for (label, case) in cases() {
        let inputs = case.inputs();
        let mut cpu = input.clone();
        apply_display_tone_curve(&mut cpu, &inputs);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&DisplayToneCurvePass { inputs }]);

        let max_diff = max_abs_diff(&cpu, &gpu);
        eprintln!("PARITY [{label}]: GPU vs CPU oracle max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "[{label}]: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// The all-default case is a TRUE no-op on the GPU (bit-identical to the
/// input, still clamped to [0, 1] by the clamp that would run regardless):
/// every curve is empty, so the kernel writes the pixel through unchanged.
#[test]
fn all_default_is_exact_passthrough_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;
    let inputs = DisplayToneCurveInputs::default();
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&DisplayToneCurvePass { inputs }]);
    let max_diff = max_abs_diff(&input, &gpu);
    assert!(
        max_diff < 1e-6,
        "all-default display tone curve must be exact passthrough; max diff {max_diff}"
    );
}

/// Alpha is carried through untouched by the GPU kernel (the stage touches
/// only RGB).
#[test]
fn gpu_alpha_passthrough() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tc_rgba();
    let count = (input.len() / 4) as u32;
    let inputs = Case {
        master: lift_curve(),
        red: s_curve(),
        green: pull_curve(),
        blue: lift_curve(),
    }
    .inputs();
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&DisplayToneCurvePass { inputs }]);
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

/// The master curve is NOT luma-coupled: applying it to an off-diagonal
/// pixel changes the R:G:B ratio (a luma-coupled implementation would keep
/// it constant). Proves the per-channel-independent application is real on
/// the GPU path too, not just in the CPU oracle's own unit tests.
#[test]
fn master_curve_is_not_luma_coupled_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    // One off-diagonal pixel, alpha irrelevant.
    let input = vec![0.1, 0.2, 0.9, 1.0];
    let inputs = Case {
        master: vec![(0.0, 0.0), (0.25, 1.0), (1.0, 1.0)],
        red: vec![],
        green: vec![],
        blue: vec![],
    }
    .inputs();
    let img = GpuImage::upload(&ctx, &input, 1, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&DisplayToneCurvePass { inputs }]);
    let (r, g) = (gpu[0], gpu[1]);
    assert!(
        (r / g - input[0] / input[1]).abs() > 1e-3,
        "master curve preserved the input ratio (r={r}, g={g}) — looks luma-coupled"
    );
}
