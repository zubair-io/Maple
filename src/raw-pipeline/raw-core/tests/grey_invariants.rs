//! Pipeline neutrality + flatness invariants on synthetic grey DNGs.
//! See `docs/superpowers/specs/2026-04-28-synthetic-grey-dng-design.md`.

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
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let model = AdjustmentModel::default();
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    // Invariant A: per-pixel R == G == B within eps_color.
    for (i, p) in scene.pixels.iter().enumerate() {
        let (r, g, b) = (p[0], p[1], p[2]);
        assert!((r - g).abs() <= eps_color,
            "pixel {}: |R-G| = {} > {} (R={} G={} B={})", i, (r-g).abs(), eps_color, r, g, b);
        assert!((r - b).abs() <= eps_color,
            "pixel {}: |R-B| = {} > {} (R={} G={} B={})", i, (r-b).abs(), eps_color, r, g, b);
    }

    // Invariant B: per-pixel value == image mean within eps_flat (per channel).
    let n = scene.pixels.len() as f32;
    let mean_r: f32 = scene.pixels.iter().map(|p| p[0]).sum::<f32>() / n;
    let mean_g: f32 = scene.pixels.iter().map(|p| p[1]).sum::<f32>() / n;
    let mean_b: f32 = scene.pixels.iter().map(|p| p[2]).sum::<f32>() / n;
    for (i, p) in scene.pixels.iter().enumerate() {
        assert!((p[0] - mean_r).abs() <= eps_flat,
            "pixel {} R={} deviates from mean R={} by > {}", i, p[0], mean_r, eps_flat);
        assert!((p[1] - mean_g).abs() <= eps_flat,
            "pixel {} G={} deviates from mean G={} by > {}", i, p[1], mean_g, eps_flat);
        assert!((p[2] - mean_b).abs() <= eps_flat,
            "pixel {} B={} deviates from mean B={} by > {}", i, p[2], mean_b, eps_flat);
    }
}

#[test]
fn neutral_scene_linear_018() {
    // Tolerance 1e-4 absorbs demosaic-edge + matrix-mul float drift on a
    // 64×64 patch (observed worst-case |R-G| ≈ 1.1e-5, |R-B| ≈ 5e-5).
    // Ratchet downward as the chain tightens.
    run_scene_linear_case(0.18, 1e-4, 1e-4);
}
