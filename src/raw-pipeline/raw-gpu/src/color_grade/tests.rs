//! Parity tests for the colour-grading WGSL kernel (#275).
//!
//! Split out of `color_grade.rs` (600-LOC budget; mirrors saturation's
//! split). Included via `#[path = "color_grade/tests.rs"] mod tests;`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A DISPLAY-LINEAR test buffer ([0, 1] post-AgX domain) spanning the
/// luminance axis (both crossovers) plus colored pixels (the tint composes
/// with existing chroma) and the Yd-clamp edges.
fn display_buffer() -> Vec<f32> {
    vec![
        // r,   g,    b,    a
        0.00, 0.00, 0.00, 1.0, // black (Yd = 0: pure shadow weight)
        0.03, 0.03, 0.03, 1.0, // deep shadow
        0.18, 0.18, 0.18, 1.0, // mid grey
        0.35, 0.35, 0.35, 1.0, // shadow→midtone hand-off
        0.50, 0.50, 0.50, 0.7, // midtone centre
        0.72, 0.72, 0.72, 1.0, // midtone→highlight hand-off
        0.95, 0.95, 0.95, 1.0, // near white
        1.00, 1.00, 1.00, 1.0, // white (Yd = 1: pure highlight weight)
        0.62, 0.30, 0.18, 1.0, // warm colored midtone
        0.10, 0.35, 0.70, 1.0, // cool colored midtone
    ]
}

/// The raw-core slider set matching a raw-gpu one — the two structs are
/// deliberately separate definitions (raw-core is only a dev-dependency
/// here), so this conversion is the seam these tests pin.
fn to_raw_core(s: &ColorGradeSliders) -> raw_core::stages::color_grade::ColorGradeSliders {
    raw_core::stages::color_grade::ColorGradeSliders {
        shadow: s.shadow,
        midtone: s.midtone,
        highlight: s.highlight,
        global: s.global,
        balance: s.balance,
    }
}

/// Run `raw_core::stages::color_grade::apply` (the ticket's reference).
fn raw_core_color_grade(buf: &[f32], sliders: &ColorGradeSliders) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::DisplayLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::color_grade::apply(&mut img, &to_raw_core(sliders));
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// The slider sets both parity gates sweep: every wheel combination that
/// exercises a distinct code path, plus the balance rails ±100 where the
/// tonal-axis exponent hits 0.5 / 2.
fn parity_cases() -> Vec<(&'static str, ColorGradeSliders)> {
    vec![
        (
            "all-wheels",
            ColorGradeSliders {
                shadow: [30.0, 60.0, 25.0],
                midtone: [150.0, 55.0, -30.0],
                highlight: [210.0, 40.0, -15.0],
                global: [90.0, 20.0, 5.0],
                balance: 0.0,
            },
        ),
        (
            "balance+100",
            ColorGradeSliders {
                shadow: [30.0, 100.0, 100.0],
                midtone: [150.0, 100.0, -100.0],
                highlight: [210.0, 100.0, -100.0],
                global: [0.0, 0.0, 0.0],
                balance: 100.0,
            },
        ),
        (
            "balance-100",
            ColorGradeSliders {
                shadow: [300.0, 45.0, -60.0],
                midtone: [15.0, 90.0, 40.0],
                highlight: [120.0, 80.0, 20.0],
                global: [270.0, 35.0, -10.0],
                balance: -100.0,
            },
        ),
        (
            "highlight-only",
            ColorGradeSliders {
                highlight: [45.0, 70.0, 0.0],
                balance: 30.0,
                ..Default::default()
            },
        ),
        (
            "shadow-only",
            ColorGradeSliders {
                shadow: [200.0, 70.0, 0.0],
                balance: -40.0,
                ..Default::default()
            },
        ),
        (
            "midtone-only",
            ColorGradeSliders {
                midtone: [340.0, 85.0, 0.0],
                ..Default::default()
            },
        ),
        (
            "global-only",
            ColorGradeSliders {
                global: [180.0, 65.0, 30.0],
                ..Default::default()
            },
        ),
        (
            "luminance-only",
            ColorGradeSliders {
                shadow: [0.0, 0.0, 70.0],
                midtone: [0.0, 0.0, -50.0],
                highlight: [0.0, 0.0, -80.0],
                ..Default::default()
            },
        ),
    ]
}

/// THE PARITY GATE: the WGSL colour-grading kernel matches
/// `raw_core::stages::color_grade::apply` within 1e-4 across every wheel
/// combination and both balance rails.
#[test]
fn wgsl_color_grade_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = display_buffer();
    let count = (input.len() / 4) as u32;

    for (name, sliders) in parity_cases() {
        let reference = raw_core_color_grade(&input, &sliders);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ColorGradePass { sliders }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core color_grade [{name}]: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "color_grade[{name}]: GPU vs raw-core max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle to raw-core's stage within float noise — the
/// oracle re-derives the inverse Oklab matrices per call (raw-core caches
/// them via OnceLock with the identical cofactor math), so the match is
/// near-exact rather than bit-for-bit.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_6() {
    let input = display_buffer();
    for (name, sliders) in parity_cases() {
        let reference = raw_core_color_grade(&input, &sliders);
        let mut local = input.clone();
        apply_color_grade(&mut local, &sliders);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-6,
            "local oracle vs raw-core stage [{name}] diff {max_diff} exceeds 1e-6"
        );
    }
}

/// The identity gate agrees with raw-core's, wheel for wheel: a hue or a
/// balance alone never engages the stage.
#[test]
fn identity_gate_matches_raw_core() {
    for sliders in [
        ColorGradeSliders::default(),
        ColorGradeSliders {
            shadow: [220.0, 0.0, 0.0],
            midtone: [90.0, 0.0, 0.0],
            highlight: [40.0, 0.0, 0.0],
            global: [310.0, 0.0, 0.0],
            balance: 60.0,
        },
        ColorGradeSliders {
            midtone: [90.0, 0.0, 12.0],
            ..Default::default()
        },
    ] {
        let core = raw_core::stages::color_grade::color_grade_params(&to_raw_core(&sliders));
        assert_eq!(
            color_grade_is_identity(&sliders),
            core.is_identity,
            "identity gate disagrees with raw-core for {sliders:?}"
        );
    }
}

/// Chroma-only grading keeps L invariant on the GPU (the split-toning
/// guarantee, still true when every luminance slider is at default), and
/// alpha passes through untouched.
#[test]
fn gpu_chroma_only_grade_keeps_l_invariant() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = display_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ColorGradePass {
        sliders: ColorGradeSliders {
            shadow: [30.0, 80.0, 0.0],
            midtone: [150.0, 80.0, 0.0],
            highlight: [250.0, 80.0, 0.0],
            global: [0.0, 0.0, 0.0],
            balance: 20.0,
        },
    }]);
    for (i, (before, after)) in input.chunks_exact(4).zip(gpu.chunks_exact(4)).enumerate() {
        let l_before = rec2020_to_oklab([before[0], before[1], before[2]])[0];
        let l_after = rec2020_to_oklab([after[0], after[1], after[2]])[0];
        assert!(
            (l_before - l_after).abs() < 1e-4,
            "pixel {i}: L drifted {l_before} → {l_after}"
        );
        assert_eq!(before[3], after[3], "alpha must pass through");
    }
}
