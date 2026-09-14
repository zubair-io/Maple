//! The Whites statistic belongs to the decoded as-shot frame, before user WB.
#![cfg(feature = "test-support")]

use raw_core::color::dcp::{profile_for_with_source, ProfileSource};
use raw_core::image::{Image, RawImage};
use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, develop_scene_linear_sized_from_raw_with_quality,
    RenderQuality,
};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::xmp::AdjustmentModel;

fn calibrated_raw() -> RawImage {
    let bytes = SyntheticGreyDng::default()
        .with_hasselblad_dcp()
        .write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode calibrated DNG");
    let (_, source) = profile_for_with_source(&raw).expect("resolve calibrated profile");
    assert!(
        !matches!(source, ProfileSource::RawlerFallback),
        "fixture must exercise camera-space WB, not fallback CAT16"
    );
    raw
}

fn baseline() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        temperature_seen: true,
        tint_seen: true,
        ..AdjustmentModel::default()
    }
}

fn develop(raw: &RawImage, model: &AdjustmentModel, sized: bool) -> Image {
    let image = if sized {
        develop_scene_linear_sized_from_raw_with_quality(raw, model, RenderQuality::Full, 32)
    } else {
        develop_scene_linear_from_raw_with_quality(raw, model, RenderQuality::Full)
    }
    .expect("production develop");
    assert_eq!(image.width, if sized { 32 } else { 64 });
    image
}

fn anchor_bits(image: &Image) -> u32 {
    let anchor = image
        .whites_anchor_ev
        .expect("develop must carry Whites anchor");
    assert!(anchor.is_finite());
    anchor.to_bits()
}

fn max_pixel_change(a: &Image, b: &Image) -> f32 {
    assert_eq!(a.pixels.len(), b.pixels.len());
    a.pixels
        .iter()
        .flatten()
        .zip(b.pixels.iter().flatten())
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

#[test]
fn calibrated_wb_changes_pixels_without_changing_full_or_sized_whites_anchor() {
    let raw = calibrated_raw();
    for sized in [false, true] {
        let base = develop(&raw, &baseline(), sized);
        for (temperature, tint) in [(3500.0, 0.0), (9500.0, 0.0), (6500.0, 35.0)] {
            let model = AdjustmentModel {
                temperature,
                tint,
                ..baseline()
            };
            let edited = develop(&raw, &model, sized);
            assert!(
                max_pixel_change(&base, &edited) > 1e-3,
                "WB must engage: sized={sized} temperature={temperature} tint={tint}"
            );
            assert_eq!(
                anchor_bits(&base),
                anchor_bits(&edited),
                "WB changed frozen anchor: sized={sized} temperature={temperature} tint={tint}"
            );
        }
    }
}

#[test]
fn exposure_and_whites_leave_full_or_sized_anchor_bit_identical() {
    let raw = calibrated_raw();
    for sized in [false, true] {
        let base = develop(&raw, &baseline(), sized);
        for exposure in [-1.0, 1.0] {
            let edited = develop(
                &raw,
                &AdjustmentModel {
                    exposure,
                    ..baseline()
                },
                sized,
            );
            assert!(
                max_pixel_change(&base, &edited) > 1e-3,
                "exposure must engage"
            );
            assert_eq!(anchor_bits(&base), anchor_bits(&edited));
        }
        for whites in [-100.0, 100.0] {
            let edited = develop(
                &raw,
                &AdjustmentModel {
                    whites,
                    ..baseline()
                },
                sized,
            );
            assert_eq!(anchor_bits(&base), anchor_bits(&edited));
            // Whites is a view-transform adjustment; this API ends scene-linear.
            assert_eq!(base.pixels, edited.pixels);
        }
    }
}
