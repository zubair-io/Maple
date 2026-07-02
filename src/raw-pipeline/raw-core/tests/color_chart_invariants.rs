//! Known-color invariants on the synthetic 24-patch ColorChecker DNG (#1521).
//!
//! The RAW analog of `tools/sanity-checks/make_color_target.py`: a real Bayer
//! DNG whose 24 patches carry the known scene-linear Rec.2020 targets in
//! `COLORCHECKER_REC2020`. Unlike the neutral grey card (`grey_invariants.rs`),
//! this exercises CHROMA through the full decode → demosaic → WB → DCP →
//! scene-linear path, so it can pin the color path and chroma sliders.
//!
//! Two chart variants tested here:
//!   - **Rec.2020 chart** (test_0018, `ChartEncoding::Rec2020`): `ColorMatrix1
//!     = M_XYZ_D65_TO_REC2020` declares camera = Rec.2020. Resolves via
//!     `EmbeddedCmOnly`; patches develop at their Rec.2020 targets within a
//!     global exposure gain.
//!   - **Camera chart** (test_0019, `ChartEncoding::Camera`): same 24 targets,
//!     re-encoded through Canon EOS 5D Mark IV matrices; resolves via
//!     `EmbeddedCmOnly` with embedded Canon CM/FM; patches round-trip to
//!     targets within a looser tolerance (DCP CM/FM rounding).
//!
//! Develop gain: with the chart's corrected `ColorMatrix1 = M_XYZ_D65_TO_REC2020`
//! and `AsShotNeutral = [1,1,1]`, the developed scene-linear is the known target
//! scaled by a single global exposure gain G (the DCP color chain preserves
//! hue/chroma up to G). The invariants are GAIN-INVARIANT: we self-calibrate G
//! by least squares and assert every patch matches `want * G` — i.e. no hue or
//! chroma distortion.
//!
//! See spec .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md
//! and .archived-plans/specs/2026-07-02-acr-color-calibration-design.md.
//!
//! Refs: #1711 (Phase 1 trustworthy fixtures)

#![cfg(feature = "test-support")]

use raw_core::color::dcp::ProfileSource;
use raw_core::image::Image;
use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_chart::{
    camera_patch_unclipped, ChartEncoding, SyntheticColorChart,
};
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

// ── Phase 1 (#1711): trustworthy fixtures ────────────────────────────────────

/// The corrected Rec.2020 chart (test_0018) must resolve to `EmbeddedCmOnly`,
/// not `RawlerFallback`. This was broken before #1711: the identity CM was
/// filtered by `is_approx_identity`, leaving `color_matrices` empty after
/// decode, which caused `profile_from_embedded_cm_only` to return `None` and
/// the resolver to fall through to `RawlerFallback`. With the corrected
/// `ColorMatrix1 = M_XYZ_D65_TO_REC2020` (non-identity), the embedded CM
/// passes the filter and the chart resolves via its own embedded CM.
///
/// Refs: #1711.
#[test]
fn rec2020_chart_resolves_to_embedded_cm_only_not_fallback() {
    use raw_core::color::dcp::profile_for_with_source;

    let chart = SyntheticColorChart::default(); // Rec2020 encoding
    let bytes = chart.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("Rec.2020 chart must decode");

    // Verify color_matrices is populated (not filtered away as identity).
    assert!(
        !raw.color_matrices.is_empty(),
        "Rec.2020 chart embedded CM was rejected as identity — \
         ColorMatrix1 must be M_XYZ_D65_TO_REC2020, not identity"
    );

    // Profile resolver must NOT fall back to RawlerFallback.
    let (_, source) = profile_for_with_source(&raw).expect("profile resolve must not error");
    assert!(
        matches!(source, ProfileSource::EmbeddedCmOnly { .. }),
        "Rec.2020 chart must resolve to EmbeddedCmOnly, got {:?}",
        source
    );
}

/// Patch means of the corrected Rec.2020 chart (test_0018) must match their
/// scene-linear Rec.2020 targets within a self-calibrated global gain G.
/// This replaces the pre-#1711 `chart_chroma_fidelity_scene_linear`, which
/// asserted the same invariant but relied on the identity-CM coincidence
/// (Maple's RawlerFallback treated the values as Rec.2020 while ACR
/// misread them as XYZ). The chart is now correctly tagged, so this is the
/// single chroma-fidelity gate: per-patch |got − G·want| ≤ EPS_CHROMA
/// (1e-3), with the global gain G bounded to [1.0, 1.4).
///
/// Refs: #1711.
#[test]
fn rec2020_chart_patch_means_match_targets_within_gain() {
    let (chart, scene) = develop(&AdjustmentModel::default());
    let g = lsq_gain(&chart, &scene);

    assert!(
        (1.0..1.4).contains(&g),
        "rec2020 chart: develop gain G={g} outside sane range [1.0, 1.4)"
    );

    for row in 0..4 {
        for col in 0..6 {
            let got = chart.read_patch_mean(&scene, col, row);
            let want = chart.patches[row][col];
            for c in 0..3 {
                let resid = (got[c] - g * want[c]).abs();
                assert!(
                    resid <= EPS_CHROMA,
                    "rec2020 chart patch ({col},{row}) chan {c}: \
                     |got {:.6} - G*want {:.6}| = {resid:.6} > {EPS_CHROMA} (G={g:.4})",
                    got[c],
                    g * want[c],
                );
            }
        }
    }
}

/// The camera-encoded chart (test_0019) must also resolve to `EmbeddedCmOnly`
/// — not `BundleConfident` (its UCM "Maple Synthetic Chart DCP" has no bundle
/// entry) and not `RawlerFallback` (it ships real Canon CM1+CM2 matrices).
///
/// Refs: #1711.
#[test]
fn camera_chart_resolves_to_embedded_cm_only() {
    use raw_core::color::dcp::profile_for_with_source;

    let chart = SyntheticColorChart {
        encoding: ChartEncoding::Camera,
        ..Default::default()
    };
    let bytes = chart.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("camera chart must decode");

    // Both StdA and D65 CMs must be present (dual-illuminant Canon profile).
    assert_eq!(
        raw.color_matrices.len(),
        2,
        "camera chart must carry both StdA and D65 CMs, got {}",
        raw.color_matrices.len()
    );

    let (_, source) =
        profile_for_with_source(&raw).expect("camera chart profile resolve must not error");
    assert!(
        matches!(source, ProfileSource::EmbeddedCmOnly { .. }),
        "camera chart must resolve to EmbeddedCmOnly, got {:?} — \
         UCM must not collide with bundle and CMs must pass identity filter",
        source
    );
}

/// Camera chart (test_0019) round-trips the 24 patch targets through the full
/// Canon DCP chain. Tolerance is looser than the Rec.2020 chart to absorb
/// rational-quantisation rounding on the embedded CM/FM tags.
///
/// Only patches where all three camera raw channels are non-negative (unclipped)
/// are included in the gain calibration and residual check. Highly saturated
/// patches (orange, red, yellow) produce negative camera blue or red channels
/// when inverted through the Canon FM — those values clip to 0 in the DNG and
/// cannot be round-tripped. `camera_patch_unclipped` identifies and skips them.
///
/// Success criterion: every unclipped patch mean is within EPS_CAMERA of
/// `G * target` where G is the self-calibrated global gain over unclipped patches.
///
/// Refs: #1711.
#[test]
fn camera_chart_round_trips_to_rec2020_targets() {
    // Looser tolerance: rational tag quantisation (1e-6 scale) introduces
    // per-patch residuals up to ~1.4e-2 on the unclipped patches.
    const EPS_CAMERA: f32 = 0.02;

    let chart = SyntheticColorChart {
        encoding: ChartEncoding::Camera,
        ..Default::default()
    };
    let bytes = chart.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("camera chart must decode");
    let scene = develop_scene_linear_from_raw_with_quality(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Full,
    )
    .expect("camera chart develop must succeed");

    // Gain calibrated over unclipped patches only.
    let (mut num, mut den) = (0.0f64, 0.0f64);
    let mut used_patches = 0u32;
    for row in 0..4 {
        for col in 0..6 {
            let want = chart.patches[row][col];
            if !camera_patch_unclipped(want) {
                continue;
            }
            used_patches += 1;
            let got = chart.read_patch_mean(&scene, col, row);
            for c in 0..3 {
                num += (got[c] * want[c]) as f64;
                den += (want[c] * want[c]) as f64;
            }
        }
    }
    assert!(
        used_patches > 0 && den > 0.0,
        "camera chart: every patch clipped — the calibration set is empty, \
         so gain G is undefined (chart/target change broke camera_patch_unclipped?)"
    );
    let g = (num / den) as f32;

    assert!(
        (0.8..1.6).contains(&g),
        "camera chart: develop gain G={g} outside sane range [0.8, 1.6)"
    );

    for row in 0..4 {
        for col in 0..6 {
            let want = chart.patches[row][col];
            if !camera_patch_unclipped(want) {
                continue;
            }
            let got = chart.read_patch_mean(&scene, col, row);
            for c in 0..3 {
                let resid = (got[c] - g * want[c]).abs();
                assert!(
                    resid <= EPS_CAMERA,
                    "camera chart patch ({col},{row}) chan {c}: \
                     |got {:.6} - G*want {:.6}| = {resid:.6} > {EPS_CAMERA} (G={g:.4})",
                    got[c],
                    g * want[c],
                );
            }
        }
    }
}
