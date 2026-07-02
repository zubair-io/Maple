//! Phase 1 DCP coverage — single-patch synthetic with real Hasselblad
//! ColorMatrix1+2, optional ForwardMatrix, hand-crafted ProfileToneCurve.
//! See spec .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

const EPS_SCENE_LINEAR: f32 = 5e-4;

fn develop(dng: &SyntheticGreyDng, model: &AdjustmentModel) -> raw_core::image::Image {
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic must decode");
    develop_scene_linear_from_raw_with_quality(&raw, model, RenderQuality::Full)
        .expect("scene-linear render must succeed")
}

/// Spec § 3.4: a neutral camera reading at the calibration illuminant
/// renders neutral after CM application. Hasselblad dual-CM CCT
/// interpolation must preserve that.
#[test]
fn neutral_preserved_under_real_dcp() {
    let dng = SyntheticGreyDng::default().with_hasselblad_dcp();
    let model = AdjustmentModel::default();
    let img = develop(&dng, &model);
    for (i, p) in img.pixels.iter().enumerate() {
        let (r, g, b) = (p[0], p[1], p[2]);
        assert!(
            (r - g).abs() <= EPS_SCENE_LINEAR,
            "pixel {} |R-G| = {} > {}: ({}, {}, {})",
            i,
            (r - g).abs(),
            EPS_SCENE_LINEAR,
            r,
            g,
            b
        );
        assert!(
            (r - b).abs() <= EPS_SCENE_LINEAR,
            "pixel {} |R-B| = {} > {}: ({}, {}, {})",
            i,
            (r - b).abs(),
            EPS_SCENE_LINEAR,
            r,
            g,
            b
        );
    }
}

/// Sweep AsShotNeutral across a StdA → D65 axis. Output should be
/// continuous — no discontinuity at the CCT crossover where Maple flips
/// between the two CMs.
#[test]
fn cct_interpolation_continuous() {
    use raw_core::test_support::hasselblad_dcp::AS_SHOT_NEUTRAL;

    fn pick_asn(t: f32) -> [f32; 3] {
        // Synthetic StdA-side endpoint (cooler/warmer-leaning than D65).
        let stda = [0.65, 1.0, 0.45];
        let d65 = AS_SHOT_NEUTRAL;
        [
            stda[0] + t * (d65[0] - stda[0]),
            stda[1] + t * (d65[1] - stda[1]),
            stda[2] + t * (d65[2] - stda[2]),
        ]
    }

    let mut samples = Vec::new();
    for k in 0..=4 {
        let t = (k as f32) / 4.0;
        let mut dng = SyntheticGreyDng::default().with_hasselblad_dcp();
        dng.as_shot_neutral_override = Some(pick_asn(t));
        let img = develop(&dng, &AdjustmentModel::default());
        samples.push(img.pixels[(32 * 64 + 32) as usize]);
    }

    // Continuity: no adjacent sample pair differs by more than 1e-2 per
    // channel. Coarse bound — the WB curve isn't required to be smooth,
    // just discontinuity-free.
    for i in 1..samples.len() {
        for c in 0..3 {
            let d = (samples[i][c] - samples[i - 1][c]).abs();
            assert!(
                d < 1e-2,
                "discontinuity between AsShotNeutral samples {} and {} chan {}: |Δ|={}",
                i - 1,
                i,
                c,
                d
            );
        }
    }
}

/// With FM populated, the DCP path bypasses Bradford CA. FM-on vs FM-off
/// outputs should differ in scene-linear because FM and Bradford aren't
/// equivalent in general. Confirms the decoder reads ForwardMatrix1/2
/// tags and the DCP path consumes them when present.
#[test]
fn forward_matrix_replaces_bradford() {
    // Hand-crafted near-identity FM with channel bias.
    let fm = [[1.05, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.95]];

    let without_fm = SyntheticGreyDng::default().with_hasselblad_dcp();
    let mut with_fm = SyntheticGreyDng::default().with_hasselblad_dcp();
    with_fm.forward_matrix_1 = Some(fm);
    with_fm.forward_matrix_2 = Some(fm);

    let img_off = develop(&without_fm, &AdjustmentModel::default());
    let img_on = develop(&with_fm, &AdjustmentModel::default());

    let p_off = img_off.pixels[(32 * 64 + 32) as usize];
    let p_on = img_on.pixels[(32 * 64 + 32) as usize];

    let max_delta = (0..3)
        .map(|c| (p_off[c] - p_on[c]).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        max_delta > 5e-3,
        "FM-on vs FM-off identical (max |Δ|={}) — FM path may not be activating. \
         off={:?} on={:?}",
        max_delta,
        p_off,
        p_on
    );
}

/// Under ticket #425 (colorimetry-only DCP), the source DNG's
/// ProfileToneCurve no longer feeds into the DCP apply path on any
/// `ProfileSource`. The Adobe aesthetic layers (PTC, PLT) were
/// calibrated to sit under Adobe's tone mapping; AgX is the view
/// transform, so they were dropped to remove compound hue errors and
/// per-format inconsistency.
///
/// This test pins the post-#425 contract: attaching a synthetic
/// ProfileToneCurve to a RawImage must NOT change the scene-linear
/// output (because the DCP path ignores it). Pre-#425 the curve fed
/// through the (removed) `apply_with_plt_and_ptc` entry point for the
/// Fallback / non-bundled path and the test asserted the curve's
/// output value at L; the predictor's premise no longer applies.
#[test]
fn profile_tone_curve_is_noop_under_colorimetry_only() {
    let curve = vec![
        (0.0, 0.0),
        (0.18, 0.15),
        (0.5, 0.55),
        (0.82, 0.9),
        (1.0, 1.0),
    ];
    for L in [0.05, 0.18, 0.50, 0.82] {
        let dng_no_ptc = SyntheticGreyDng {
            linear_value: L,
            ..Default::default()
        }
        .with_hasselblad_dcp();
        let mut dng_with_ptc = dng_no_ptc.clone();
        dng_with_ptc.profile_tone_curve = Some(curve.clone());

        let img_no_ptc = develop(&dng_no_ptc, &AdjustmentModel::default());
        let img_with_ptc = develop(&dng_with_ptc, &AdjustmentModel::default());

        // Under #425, PTC is a no-op in the DCP stage — the two renders
        // must be pixel-identical regardless of `profile_tone_curve`.
        for (i, (a, b)) in img_no_ptc
            .pixels
            .iter()
            .zip(img_with_ptc.pixels.iter())
            .enumerate()
        {
            for c in 0..3 {
                assert!(
                    (a[c] - b[c]).abs() <= EPS_SCENE_LINEAR,
                    "pixel {} chan {}: PTC must be a no-op under \
                     colorimetry-only DCP (no-PTC={}, with-PTC={}, |Δ|>{}, L={})",
                    i,
                    c,
                    a[c],
                    b[c],
                    EPS_SCENE_LINEAR,
                    L
                );
            }
        }
    }
}
