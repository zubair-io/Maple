//! Known-color invariants on the synthetic 24-patch ColorChecker DNG (#1521).
//!
//! The RAW analog of `tools/sanity-checks/make_color_target.py`: a real Bayer
//! DNG whose 24 patches carry the known scene-linear Rec.2020 targets in
//! `COLORCHECKER_REC2020`. Unlike the neutral grey card (`grey_invariants.rs`),
//! this exercises CHROMA through the full decode → demosaic → WB → DCP →
//! scene-linear path, so it can pin the color path and chroma sliders.
//!
//! Develop gain: with the chart's identity `ColorMatrix1` and `AsShotNeutral`,
//! the developed scene-linear is the known target scaled by a single global
//! exposure gain G ≈ 1.191 (the same untested gain the grey card carries — its
//! tests only check neutrality/flatness, never absolute level). The invariants
//! here are therefore GAIN-INVARIANT: we self-calibrate G by least squares and
//! assert every patch matches `want * G`, i.e. the chart reproduces the known
//! colors with no hue/chroma distortion. Measured residual after self-calibration
//! is abs 1e-5 / 0.017 % rel — the tolerances below leave generous headroom and
//! ratchet downward as the chain tightens.
//!
//! See spec .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md.

#![cfg(feature = "test-support")]

use raw_core::image::Image;
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_chart::SyntheticColorChart;
use raw_core::xmp::AdjustmentModel;

/// Self-calibrated chroma residual: abs |got - G*want|. Observed worst 1e-5.
const EPS_CHROMA: f32 = 1e-3;
/// Per-patch interior flatness (max-min per channel). Observed worst 1.4e-4.
const EPS_FLAT: f32 = 1e-3;
/// Neutral-patch channel spread |R-G|,|R-B|. Observed worst 2e-6.
const EPS_NEUTRAL: f32 = 1e-3;

fn develop(model: &AdjustmentModel) -> (SyntheticColorChart, Image) {
    let chart = SyntheticColorChart::default();
    let raw = raw_core::decode::decode_bytes(&chart.write_to_bytes(), "dng")
        .expect("synthetic chart must decode");
    let scene = develop_scene_linear_from_raw_with_quality(&raw, model, RenderQuality::Full)
        .expect("scene-linear develop must succeed");
    (chart, scene)
}

/// Least-squares global gain G that best maps the known targets onto the
/// developed patch means: G = sum(got*want) / sum(want*want).
fn lsq_gain(chart: &SyntheticColorChart, scene: &Image) -> f32 {
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for row in 0..4 {
        for col in 0..6 {
            let got = chart.read_patch_mean(scene, col, row);
            let want = chart.patches[row][col];
            for c in 0..3 {
                num += (got[c] * want[c]) as f64;
                den += (want[c] * want[c]) as f64;
            }
        }
    }
    (num / den) as f32
}

/// Core invariant: every one of the 24 known colors survives the full RAW
/// pipeline up to a single global exposure gain — no hue or chroma distortion.
#[test]
fn chart_chroma_fidelity_scene_linear() {
    let (chart, scene) = develop(&AdjustmentModel::default());
    let g = lsq_gain(&chart, &scene);

    // Sanity-bound the gain so a gross exposure regression (e.g. a doubling)
    // still trips this test. The gain itself is not a tight contract — the
    // per-patch chroma match below is the real gate.
    assert!(
        (1.0..1.4).contains(&g),
        "develop gain G={g} outside sane exposure range [1.0, 1.4)"
    );

    for row in 0..4 {
        for col in 0..6 {
            let got = chart.read_patch_mean(&scene, col, row);
            let want = chart.patches[row][col];
            for c in 0..3 {
                let resid = (got[c] - g * want[c]).abs();
                assert!(
                    resid <= EPS_CHROMA,
                    "patch ({col},{row}) chan {c}: |got {} - G*want {}| = {resid} > {EPS_CHROMA} (G={g})",
                    got[c],
                    g * want[c],
                );
            }
        }
    }
}

/// Neutral row (row 3 in `colorchecker.rs`) must develop neutral (R==G==B) —
/// chroma sliders and the color matrix must not tint the gray axis.
#[test]
fn chart_neutrals_stay_neutral() {
    let (chart, scene) = develop(&AdjustmentModel::default());
    for col in 0..6 {
        let p = chart.read_patch_mean(&scene, col, 3);
        assert!(
            (p[0] - p[1]).abs() <= EPS_NEUTRAL && (p[0] - p[2]).abs() <= EPS_NEUTRAL,
            "neutral patch (col {col}): not neutral, got [{},{},{}]",
            p[0],
            p[1],
            p[2]
        );
    }
}

/// Each patch interior must be spatially flat (single solid color) — guards the
/// demosaic + the patch-sampling region against bleed from patch edges.
#[test]
fn chart_patches_are_flat() {
    let (chart, scene) = develop(&AdjustmentModel::default());
    // The sampler skips a 4px border on every side, so the interior is
    // `patch_size - 8`; assert the precondition rather than underflow-panic.
    assert!(
        chart.patch_size >= 16,
        "patch sampling needs patch_size >= 16 (got {})",
        chart.patch_size
    );
    let stride = (chart.patch_size + chart.guard) as usize;
    let inner = chart.patch_size as usize - 8;
    let w = scene.width as usize;
    for row in 0..4 {
        for col in 0..6 {
            let (x0, y0) = (col * stride + 4, row * stride + 4);
            let mut mn = [f32::INFINITY; 3];
            let mut mx = [f32::NEG_INFINITY; 3];
            for dy in 0..inner {
                for dx in 0..inner {
                    let p = scene.pixels[(y0 + dy) * w + (x0 + dx)];
                    for c in 0..3 {
                        mn[c] = mn[c].min(p[c]);
                        mx[c] = mx[c].max(p[c]);
                    }
                }
            }
            for c in 0..3 {
                assert!(
                    mx[c] - mn[c] <= EPS_FLAT,
                    "patch ({col},{row}) chan {c} not flat: spread {} > {EPS_FLAT}",
                    mx[c] - mn[c]
                );
            }
        }
    }
}

/// Saturation slider moves chroma on COLOR patches (which the neutral grey card
/// cannot test) while leaving neutrals neutral. `chroma = max(rgb) - min(rgb)`
/// is a monotone proxy for saturation in linear RGB.
#[test]
fn chart_saturation_slider_moves_color_not_neutrals() {
    let chroma = |p: [f32; 3]| p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]);

    let mut up = AdjustmentModel::default();
    up.saturation = 100.0;
    let mut down = AdjustmentModel::default();
    down.saturation = -100.0;

    let (chart, base) = develop(&AdjustmentModel::default());
    let (_, more) = develop(&up);
    let (_, less) = develop(&down);

    // A strongly colored patch (primary red, row 2 col 2) must gain chroma at
    // +100 and lose it at -100, by a clear margin above the flatness noise floor.
    let (rc, rr) = (2usize, 2usize); // primary red
    let (c0, cup, cdn) = (
        chroma(chart.read_patch_mean(&base, rc, rr)),
        chroma(chart.read_patch_mean(&more, rc, rr)),
        chroma(chart.read_patch_mean(&less, rc, rr)),
    );
    assert!(
        cup > c0 + 0.01,
        "saturation +100 must raise chroma: base {c0} -> {cup}"
    );
    assert!(
        cdn < c0 - 0.01,
        "saturation -100 must lower chroma: base {c0} -> {cdn}"
    );

    // Neutrals must remain (near) zero chroma at every saturation setting.
    for (label, scene) in [("base", &base), ("+100", &more), ("-100", &less)] {
        let nc = chroma(chart.read_patch_mean(scene, 1, 3)); // neutral 8
        assert!(
            nc <= EPS_NEUTRAL,
            "neutral patch gained chroma {nc} at saturation {label}"
        );
    }
}
