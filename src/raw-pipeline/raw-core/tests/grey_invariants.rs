//! Pipeline neutrality + flatness invariants on synthetic grey DNGs.
//! See `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Render a synthetic grey DNG to scene-linear and assert per-pixel
/// neutrality + spatial flatness.
fn run_scene_linear_case(linear_value: f32, eps_color: f32, eps_flat: f32) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let model = AdjustmentModel::default();
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    // Invariant A: per-pixel R == G == B within eps_color.
    for (i, p) in scene.pixels.iter().enumerate() {
        let (r, g, b) = (p[0], p[1], p[2]);
        assert!(
            (r - g).abs() <= eps_color,
            "pixel {}: |R-G| = {} > {} (R={} G={} B={})",
            i,
            (r - g).abs(),
            eps_color,
            r,
            g,
            b
        );
        assert!(
            (r - b).abs() <= eps_color,
            "pixel {}: |R-B| = {} > {} (R={} G={} B={})",
            i,
            (r - b).abs(),
            eps_color,
            r,
            g,
            b
        );
    }

    // Invariant B: per-pixel value == image mean within eps_flat (per channel).
    let n = scene.pixels.len() as f32;
    let mean_r: f32 = scene.pixels.iter().map(|p| p[0]).sum::<f32>() / n;
    let mean_g: f32 = scene.pixels.iter().map(|p| p[1]).sum::<f32>() / n;
    let mean_b: f32 = scene.pixels.iter().map(|p| p[2]).sum::<f32>() / n;
    for (i, p) in scene.pixels.iter().enumerate() {
        assert!(
            (p[0] - mean_r).abs() <= eps_flat,
            "pixel {} R={} deviates from mean R={} by > {}",
            i,
            p[0],
            mean_r,
            eps_flat
        );
        assert!(
            (p[1] - mean_g).abs() <= eps_flat,
            "pixel {} G={} deviates from mean G={} by > {}",
            i,
            p[1],
            mean_g,
            eps_flat
        );
        assert!(
            (p[2] - mean_b).abs() <= eps_flat,
            "pixel {} B={} deviates from mean B={} by > {}",
            i,
            p[2],
            mean_b,
            eps_flat
        );
    }
}

// Scene-linear tolerance scales roughly linearly with `linear_value`
// because float drift in the demosaic + matrix-mul chain compounds with
// magnitude. 5e-4 covers the full sweep up to L = 0.50 (observed worst
// case |R-B| ≈ 1.07e-4). Ratchet downward as the chain tightens.
const SCENE_LINEAR_EPS: f32 = 5e-4;

#[test]
fn neutral_scene_linear_018() {
    run_scene_linear_case(0.18, SCENE_LINEAR_EPS, SCENE_LINEAR_EPS);
}

use raw_core::pipeline::render_from_raw;

/// Render a synthetic grey DNG through the full production pipeline
/// (AgX + sRGB + u8 quantize) and assert per-pixel neutrality + flatness
/// in 8-bit LSB.
fn run_display_case(linear_value: f32, eps_color: i32, eps_flat: i32) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let model = AdjustmentModel::default();
    let (w, h, rgb) = render_from_raw(&raw, &model).expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    assert_eq!(rgb.len(), n * 3);

    // Invariant A: per-pixel R == G == B in 8-bit LSB.
    for i in 0..n {
        let r = rgb[i * 3] as i32;
        let g = rgb[i * 3 + 1] as i32;
        let b = rgb[i * 3 + 2] as i32;
        assert!(
            (r - g).abs() <= eps_color,
            "pixel {}: |R-G| = {} > {} (R={} G={} B={})",
            i,
            (r - g).abs(),
            eps_color,
            r,
            g,
            b
        );
        assert!(
            (r - b).abs() <= eps_color,
            "pixel {}: |R-B| = {} > {} (R={} G={} B={})",
            i,
            (r - b).abs(),
            eps_color,
            r,
            g,
            b
        );
    }

    // Invariant B: per-channel flatness in 8-bit LSB.
    let mean = |chan: usize| -> i32 {
        let s: i32 = (0..n).map(|i| rgb[i * 3 + chan] as i32).sum();
        (s + n as i32 / 2) / n as i32 // round-half-up
    };
    let (mr, mg, mb) = (mean(0), mean(1), mean(2));
    for i in 0..n {
        assert!(
            (rgb[i * 3] as i32 - mr).abs() <= eps_flat,
            "pixel {} R={} deviates from mean {} by > {}",
            i,
            rgb[i * 3],
            mr,
            eps_flat
        );
        assert!(
            (rgb[i * 3 + 1] as i32 - mg).abs() <= eps_flat,
            "pixel {} G={} deviates from mean {} by > {}",
            i,
            rgb[i * 3 + 1],
            mg,
            eps_flat
        );
        assert!(
            (rgb[i * 3 + 2] as i32 - mb).abs() <= eps_flat,
            "pixel {} B={} deviates from mean {} by > {}",
            i,
            rgb[i * 3 + 2],
            mb,
            eps_flat
        );
    }
}

#[test]
fn neutral_display_srgb_018() {
    run_display_case(0.18, 2, 2);
}

#[test]
fn neutral_scene_linear_005() {
    run_scene_linear_case(0.05, SCENE_LINEAR_EPS, SCENE_LINEAR_EPS);
}
#[test]
fn neutral_scene_linear_050() {
    run_scene_linear_case(0.50, SCENE_LINEAR_EPS, SCENE_LINEAR_EPS);
}

#[test]
fn neutral_display_srgb_005() {
    run_display_case(0.05, 2, 2);
}
#[test]
fn neutral_display_srgb_050() {
    run_display_case(0.50, 2, 2);
}
