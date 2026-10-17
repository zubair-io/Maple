//! Physical sensor calibration reaches the shared native/Web GPU prefix.
use super::prepare::develop_prefix_rgba;
use crate::{
    pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality},
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
#[ignore = "requires test_0015.dng physical fixture"]
fn physical_pixel_gain_maps_reach_gpu_host_and_keep_hot_controls_out_of_prefix() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0015.dng");
    let bytes = std::fs::read(&path).expect("required Pixel fixture");
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    assert!(raw.sensor_gain_maps.is_some());
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
        ..Default::default()
    };
    let prepared = develop_prefix_rgba(&raw, &bytes, "dng", &model, 512).unwrap();
    let cpu = develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &prepared.3,
        RenderQuality::Amaze,
        512,
    )
    .unwrap();
    assert_eq!((prepared.1, prepared.2), (cpu.width, cpu.height));
    assert_eq!(prepared.0.len(), cpu.pixels.len() * 4);
    for (actual, expected) in prepared.0.chunks_exact(4).zip(&cpu.pixels) {
        assert_eq!(&actual[..3], expected);
        assert_eq!(actual[3], 1.0);
    }
    // This is a non-vacuous calibration check: removing the required maps
    // changes the production GPU upload, not just a parsed metadata field.
    let mut uncalibrated = raw.clone();
    uncalibrated.sensor_gain_maps = None;
    let missing = develop_prefix_rgba(&uncalibrated, &bytes, "dng", &model, 512).unwrap();
    assert!(prepared
        .0
        .iter()
        .zip(&missing.0)
        .any(|(a, b)| (a - b).abs() > 1e-3));

    let edited = AdjustmentModel {
        exposure: 2.0,
        temperature: 8500.0,
        temperature_seen: true,
        saturation: 35.0,
        ..model
    };
    let again = develop_prefix_rgba(&raw, &bytes, "dng", &edited, 512).unwrap();
    assert_eq!(
        prepared, again,
        "hot controls must reuse the calibrated prefix"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
