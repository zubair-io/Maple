//! The DNG SDK selects HueSatMapForWhite at the requested white point (#4633).
use super::*;
use crate::color::{
    hsm::{HsmEncoding, HsmTable},
    illuminant::Illuminant,
};
use crate::math::Matrix3;

fn tables() -> (HsmTable, HsmTable) {
    let cold = vec![0.0, 1.0, 1.0, -6.0, 0.8, 0.9, 0.0, 1.0, 1.0, 4.0, 1.2, 1.1];
    let warm = vec![
        0.0, 1.0, 1.0, 12.0, 1.4, 1.2, 0.0, 1.0, 1.0, -8.0, 0.7, 0.85,
    ];
    (
        HsmTable::new([2, 2, 1], cold, HsmEncoding::Linear).unwrap(),
        HsmTable::new([2, 2, 1], warm, HsmEncoding::Linear).unwrap(),
    )
}

fn calibrated(cold: Option<&HsmTable>, warm: Option<&HsmTable>) -> (SliderFrame, DcpProfile) {
    // Identical CM endpoints isolate HSM interpolation from matrix changes.
    let cm = Matrix3([
        [0.6722, -0.0635, -0.0963],
        [-0.4287, 1.2460, 0.2028],
        [-0.0908, 0.2162, 0.5668],
    ]);
    let neutral = camera_neutral_for(cm, 5500.0, 0.0);
    let profile = dcp::interpolated_profile(
        cm,
        Illuminant::StdA,
        cm,
        Illuminant::D65,
        neutral,
        false,
        cold,
        warm,
        None,
        None,
        None,
        None,
    );
    let frame = SliderFrame {
        endpoints: Some((cm, Illuminant::StdA.cct(), cm, Illuminant::D65.cct())),
        cm_as_shot: cm,
        scene_cct: 5500.0,
        scene_tint: 0.0,
        render_cm: cm,
    };
    (frame, profile)
}

#[test]
fn requested_white_reinterpolates_hsm_with_independent_reciprocal_cct_predictions() {
    let (cold, warm) = tables();
    let (frame, profile) = calibrated(Some(&cold), Some(&warm));
    // Adobe SDK HueSatMapForWhite_Dual: clamp endpoints, otherwise reciprocal
    // CCT weights. The interior targets exercise both nontrivial directions.
    for temperature in [2000.0_f32, 3500.0, 4500.0, 9000.0] {
        let cold_weight =
            ((1.0 / temperature - 1.0 / 6504.0) / (1.0 / 2856.0 - 1.0 / 6504.0)).clamp(0.0, 1.0);
        let retargeted = retargeted_render_profile(&frame, profile.clone(), temperature, 0.0);
        let actual = retargeted.hsm.unwrap();
        assert_eq!(actual.dims, cold.dims);
        assert_eq!(actual.encoding, cold.encoding);
        for (i, value) in actual.data.iter().enumerate() {
            let expected = cold_weight * cold.data[i] + (1.0 - cold_weight) * warm.data[i];
            assert!(
                (value - expected).abs() < 0.002,
                "temperature={temperature}, entry={i}: {value} != {expected}"
            );
        }
        assert_eq!(retargeted.color_matrix.0, profile.color_matrix.0);
        assert_eq!(retargeted.scene_white_xyz, profile.scene_white_xyz);
    }
}

#[test]
fn as_shot_preserves_hsm_bits_and_single_table_stays_fixed() {
    let (cold, warm) = tables();
    for (a, b) in [
        (Some(&cold), Some(&warm)),
        (Some(&cold), None),
        (None, Some(&warm)),
    ] {
        let (frame, profile) = calibrated(a, b);
        let original = profile.hsm.as_ref().unwrap().data.clone();
        let unchanged = retargeted_render_profile(&frame, profile.clone(), 5500.0, 0.0);
        assert_eq!(unchanged.hsm.unwrap().data, original);
        if a.is_none() || b.is_none() {
            for temperature in [2000.0, 4500.0, 9000.0] {
                let target = retargeted_render_profile(&frame, profile.clone(), temperature, 0.0);
                assert_eq!(target.hsm.unwrap().data, original);
            }
        }
    }
}

#[test]
fn hsm_uses_the_same_render_frame_weight_as_the_forward_matrix() {
    let (cold, warm) = tables();
    let (mut frame, mut profile) = calibrated(Some(&cold), Some(&warm));
    // The slider calibration differs from the rendering calibration, as it
    // can for embedded slider metadata plus a bundled rendering profile.
    frame.cm_as_shot = Matrix3([
        [0.7234, 0.0231, -0.0542],
        [-0.3956, 1.1998, 0.2239],
        [-0.0512, 0.1892, 0.5231],
    ]);
    frame.endpoints = None;
    let endpoints = profile.cm_endpoints.as_mut().unwrap();
    endpoints.fm_cold = Some(Matrix3([[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]]));
    endpoints.fm_warm = Some(Matrix3([[4.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 4.0]]));
    let temperature = 4500.0;
    let target = retargeted_render_profile(&frame, profile, temperature, 40.0);
    // Infer the existing FM interpolation weight from its two exact endpoints.
    let warm_weight = (target.forward_matrix.unwrap().0[0][0] - 2.0) / 2.0;
    let literal_weight = (1.0 / 2856.0 - 1.0 / temperature) / (1.0 / 2856.0 - 1.0 / 6504.0);
    assert!((warm_weight - literal_weight).abs() > 0.01);
    for (i, value) in target.hsm.unwrap().data.iter().enumerate() {
        let expected = (1.0 - warm_weight) * cold.data[i] + warm_weight * warm.data[i];
        assert!((value - expected).abs() < 1e-5);
    }
}

#[test]
fn selected_hsm_reaches_full_sized_and_tile_develop() {
    use crate::pipeline::{
        develop_scene_linear_from_raw_with_quality,
        develop_scene_linear_sized_from_raw_with_quality,
        render_scene_linear_tile_from_raw_with_quality_f32, RenderQuality, TileRect,
    };
    use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
    use crate::xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile};

    let bytes = SyntheticColorChart {
        patch_size: 80,
        guard: 8,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let (cold, warm) = tables();
    let (_, calibration) = calibrated(Some(&cold), Some(&warm));
    let cm = calibration.color_matrix;
    let fm = Matrix3(crate::test_support::canon_dcp::FORWARD_MATRIX_2);
    raw.color_matrices = [(Illuminant::StdA, cm), (Illuminant::D65, cm)].into();
    raw.forward_matrices = [(Illuminant::StdA, fm), (Illuminant::D65, fm)].into();
    raw.as_shot_neutral = camera_neutral_for(cm, 5500.0, 0.0);
    raw.hsm_data = [
        (Illuminant::StdA, cold.clone()),
        (Illuminant::D65, warm.clone()),
    ]
    .into();
    let (profile, source) = dcp::profile_for_with_source(&raw).unwrap();
    assert!(matches!(source, dcp::ProfileSource::EmbeddedFull { .. }));
    let as_shot = profile.hsm.unwrap();

    for temperature in [2000.0_f32, 4500.0, 9000.0] {
        // Independent literal reciprocal-CCT prediction. Installing the same
        // expected table at both endpoints makes the oracle independent of
        // the selected-white retargeting implementation under test.
        let cold_weight =
            ((1.0 / temperature - 1.0 / 6504.0) / (1.0 / 2856.0 - 1.0 / 6504.0)).clamp(0.0, 1.0);
        let expected = HsmTable::new(
            cold.dims,
            cold.data
                .iter()
                .zip(&warm.data)
                .map(|(a, b)| cold_weight * a + (1.0 - cold_weight) * b)
                .collect(),
            cold.encoding,
        )
        .unwrap();
        let pinned = |table: &HsmTable| {
            let mut pinned = raw.clone();
            pinned.hsm_data = [
                (Illuminant::StdA, table.clone()),
                (Illuminant::D65, table.clone()),
            ]
            .into();
            pinned
        };
        let expected_raw = pinned(&expected);
        let stale_raw = pinned(&as_shot);
        let model = AdjustmentModel {
            temperature,
            tint: 0.0,
            temperature_seen: true,
            tint_seen: true,
            auto_exposure: AutoExposureMode::Off,
            highlight_recovery: HighlightRecoveryMode::Off,
            profile: Profile::Neutral,
            sharpen_amount: 0.0,
            nr_color: 0.0,
            nr_luminance: 0.0,
            ..Default::default()
        };
        for quality in [RenderQuality::Preview, RenderQuality::Amaze] {
            let render = |input: &crate::image::RawImage, route| -> Vec<f32> {
                match route {
                    0 => develop_scene_linear_from_raw_with_quality(input, &model, quality)
                        .unwrap()
                        .pixels
                        .into_iter()
                        .flatten()
                        .collect(),
                    1 => develop_scene_linear_sized_from_raw_with_quality(
                        input, &model, quality, 128,
                    )
                    .unwrap()
                    .pixels
                    .into_iter()
                    .flatten()
                    .collect(),
                    _ => render_scene_linear_tile_from_raw_with_quality_f32(
                        input,
                        &model,
                        TileRect {
                            src_x: 96,
                            src_y: 96,
                            src_w: 224,
                            src_h: 192,
                            out_w: 112,
                            out_h: 96,
                        },
                        quality,
                    )
                    .unwrap()
                    .2
                    .chunks_exact(4)
                    .flat_map(|p| [p[0], p[1], p[2]])
                    .collect(),
                }
            };
            for (route, name) in ["full", "sized", "tile"].into_iter().enumerate() {
                let actual = render(&raw, route);
                let expected = render(&expected_raw, route);
                let stale = render(&stale_raw, route);
                assert_eq!(actual.len(), expected.len());
                let maximum = |a: &[f32], b: &[f32]| {
                    a.iter()
                        .zip(b)
                        .map(|(a, b)| {
                            assert!(a.is_finite() && b.is_finite());
                            (a - b).abs()
                        })
                        .fold(0.0_f32, f32::max)
                };
                let error = maximum(&actual, &expected);
                let effect = maximum(&expected, &stale);
                assert!(
                    error < 1e-4,
                    "{name} {quality:?} {temperature}: HSM error {error:e}"
                );
                assert!(effect > 1e-3, "{name} {quality:?} {temperature}: stale HSM did not change pixels ({effect:e})");
            }
        }
    }
}
