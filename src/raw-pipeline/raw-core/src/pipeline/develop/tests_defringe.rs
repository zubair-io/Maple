//! Global defringe must reach the viewport entry, including actual downsampling.
use super::*;
use crate::xmp::{AutoExposureMode, HighlightRecoveryMode, Profile};
use crate::{image::CfaPattern, test_support::synth_dng::SyntheticGreyDng};

#[test]
fn sized_defringe_applies_both_bands_after_resize() {
    let bytes = SyntheticGreyDng {
        width: 32,
        height: 32,
        as_shot_neutral_override: Some([1.0; 3]),
        color_matrix_1_override: Some(crate::color::matrices::M_XYZ_D65_TO_REC2020.0),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.cfa = CfaPattern::LinearRgb;
    raw.white_level = 10_000;
    raw.black_level = [0; 4];
    raw.baseline_exposure = 0.0;
    raw.crop_rect = None;
    let base = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    for purple in [true, false] {
        raw.raw_data = (0..32 * 32)
            .flat_map(|i| {
                let x = i % 32;
                if (14..18).contains(&x) {
                    if purple {
                        [9000, 2000, 9000]
                    } else {
                        [2000, 9000, 2000]
                    }
                } else if x < 16 {
                    [200; 3]
                } else {
                    [9000; 3]
                }
            })
            .collect();
        let model = AdjustmentModel {
            defringe_purple_amount: if purple { 100.0 } else { 0.0 },
            defringe_green_amount: if purple { 0.0 } else { 100.0 },
            defringe_purple_hue_lo: 0.0,
            defringe_purple_hue_hi: 100.0,
            defringe_green_hue_lo: 0.0,
            defringe_green_hue_hi: 100.0,
            ..base.clone()
        };
        for edge in [32, 16] {
            let develop = |m: &AdjustmentModel| {
                crate::pipeline::develop_scene_linear_sized_from_raw_with_quality(
                    &raw,
                    m,
                    RenderQuality::Preview,
                    edge,
                )
                .unwrap()
            };
            let baseline = develop(&base);
            let mut expected = baseline.clone();
            defringe::apply_model(&mut expected, &model);
            assert!(
                baseline
                    .pixels
                    .iter()
                    .zip(&expected.pixels)
                    .any(|(a, b)| (0..3).any(|c| (a[c] - b[c]).abs() > 1e-5)),
                "fixture must engage band"
            );
            let actual = develop(&model);
            assert_eq!(
                actual.pixels, expected.pixels,
                "sized defringe missing at edge {edge}"
            );
            if edge == 32 {
                let full = develop_scene_linear_from_raw_with_quality(
                    &raw,
                    &model,
                    RenderQuality::Preview,
                )
                .unwrap();
                assert_eq!(actual.pixels, full.pixels);
            }
        }
    }
}
