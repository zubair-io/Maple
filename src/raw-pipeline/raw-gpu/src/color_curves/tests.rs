//! Parity tests for the Oklab secondary color curves WGSL kernel (#5041).

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

fn scene_buffer() -> Vec<f32> {
    vec![
        // Neutrals (C = 0 -> bit-identical pass-through)
        0.18, 0.18, 0.18, 1.0, // mid grey
        0.01, 0.01, 0.01, 1.0, // near-black neutral
        1.00, 1.00, 1.00, 1.0, // white neutral
        // Saturated primaries (Rec.2020 scene linear)
        1.00, 0.05, 0.05, 1.0, // saturated red
        0.05, 1.00, 0.05, 1.0, // saturated green
        0.05, 0.05, 1.00, 1.0, // saturated blue
        // Off-axis colours + HDR highlights
        0.80, 0.40, 0.10, 1.0, // warm orange-ish
        0.10, 0.50, 0.80, 1.0, // cool cyan-blue
        0.50, 0.80, 0.30, 1.0, // yellow-green
        0.60, 0.10, 0.60, 1.0, // magenta-purple
        2.40, 1.20, 0.30, 1.0, // HDR warm highlight
    ]
}

fn raw_core_color_curves(buf: &[f32], inputs: &ColorCurveInputs) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    use raw_core::types::adjustment::ToneCurve;
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::color_curves::apply(
        &mut img,
        &ToneCurve::new(inputs.hue_vs_hue.clone().into_owned()),
        &ToneCurve::new(inputs.hue_vs_sat.clone().into_owned()),
        &ToneCurve::new(inputs.hue_vs_luma.clone().into_owned()),
        &ToneCurve::new(inputs.luma_vs_sat.clone().into_owned()),
        &ToneCurve::new(inputs.sat_vs_sat.clone().into_owned()),
        &ToneCurve::new(inputs.sat_vs_luma.clone().into_owned()),
    );
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

#[test]
fn wgsl_color_curves_matches_raw_core_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let mut input = scene_buffer();
    for chroma in [0.0499_f32, 0.0501, 0.06, 0.075, 0.09, 0.10] {
        let rgb = raw_core::color::oklab::oklab_to_rec2020([0.65, chroma, 0.0]);
        input.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
    }
    let count = (input.len() / 4) as u32;

    let cases: Vec<ColorCurveInputs> = vec![
        // 1. Hue vs Hue only
        ColorCurveInputs {
            hue_vs_hue: vec![(0.0, 0.5), (0.15, 0.72), (0.4, 0.5), (0.75, 0.3)].into(),
            ..Default::default()
        },
        // 2. Hue vs Sat + Hue vs Luma
        ColorCurveInputs {
            hue_vs_sat: vec![(0.05, 0.8), (0.35, 0.5), (0.65, 0.25)].into(),
            hue_vs_luma: vec![(0.15, 0.65), (0.55, 0.35), (0.85, 0.5)].into(),
            ..Default::default()
        },
        // 3. Luma vs Sat + Sat vs Sat + Sat vs Luma
        ColorCurveInputs {
            luma_vs_sat: vec![(0.0, 0.2), (0.5, 0.65), (1.0, 0.3)].into(),
            sat_vs_sat: vec![(0.0, 0.7), (0.5, 0.5), (1.0, 0.25)].into(),
            sat_vs_luma: vec![(0.0, 0.5), (0.5, 0.65), (1.0, 0.35)].into(),
            ..Default::default()
        },
        ColorCurveInputs {
            luma_vs_sat: vec![(0.0, 1.0), (1.0, 1.0)].into(),
            ..Default::default()
        },
        // 4. All 6 curves active simultaneously
        ColorCurveInputs {
            hue_vs_hue: vec![(0.1, 0.65), (0.5, 0.5), (0.8, 0.35)].into(),
            hue_vs_sat: vec![(0.2, 0.75), (0.6, 0.35)].into(),
            hue_vs_luma: vec![(0.1, 0.6), (0.7, 0.4)].into(),
            luma_vs_sat: vec![(0.0, 0.3), (0.5, 0.6), (1.0, 0.4)].into(),
            sat_vs_sat: vec![(0.0, 0.65), (0.6, 0.5), (1.0, 0.35)].into(),
            sat_vs_luma: vec![(0.0, 0.5), (0.7, 0.6), (1.0, 0.4)].into(),
        },
    ];

    for (idx, case) in cases.iter().enumerate() {
        let reference = raw_core_color_curves(&input, case);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ColorCurvesPass { inputs: case }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-4,
            "case {idx}: ColorCurves GPU vs raw-core max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

#[test]
fn local_oracle_matches_raw_core_within_1e_6() {
    let input = scene_buffer();
    let case = ColorCurveInputs {
        hue_vs_hue: vec![(0.1, 0.65), (0.5, 0.5), (0.8, 0.35)].into(),
        hue_vs_sat: vec![(0.2, 0.75), (0.6, 0.35)].into(),
        hue_vs_luma: vec![(0.1, 0.6), (0.7, 0.4)].into(),
        luma_vs_sat: vec![(0.0, 0.3), (0.5, 0.6), (1.0, 0.4)].into(),
        sat_vs_sat: vec![(0.0, 0.65), (0.6, 0.5), (1.0, 0.35)].into(),
        sat_vs_luma: vec![(0.0, 0.5), (0.7, 0.6), (1.0, 0.4)].into(),
    };

    let reference = raw_core_color_curves(&input, &case);
    let mut local = input.clone();
    apply_color_curves(&mut local, &case);

    let max_diff = reference
        .iter()
        .zip(&local)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        max_diff < 1e-6,
        "local oracle vs raw-core stage diff {max_diff} exceeds 1e-6"
    );
}

#[test]
fn gpu_color_curves_neutral_is_bit_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input: Vec<f32> = vec![
        0.18, 0.18, 0.18, 1.0, 0.01, 0.01, 0.01, 1.0, 0.50, 0.50, 0.50, 1.0,
    ];
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let aggressive = ColorCurveInputs {
        hue_vs_hue: vec![(0.2, 1.0), (0.7, 0.0)].into(),
        hue_vs_sat: vec![(0.2, 1.0), (0.7, 0.0)].into(),
        hue_vs_luma: vec![(0.2, 1.0), (0.7, 0.0)].into(),
        luma_vs_sat: vec![(0.0, 1.0), (1.0, 1.0)].into(),
        sat_vs_sat: vec![(0.0, 1.0), (1.0, 1.0)].into(),
        sat_vs_luma: vec![(0.0, 1.0), (1.0, 0.0)].into(),
    };
    let gpu = runner.run_blocking(&[&ColorCurvesPass {
        inputs: &aggressive,
    }]);
    for (i, (before, after)) in input.chunks_exact(4).zip(gpu.chunks_exact(4)).enumerate() {
        for c in 0..4 {
            assert_eq!(
                before[c], after[c],
                "neutral pixel {i} channel {c} changed: {} -> {}",
                before[c], after[c]
            );
        }
    }
}
