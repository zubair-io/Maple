//! Physical decode / prefix regression for #4629. Explicitly provisioned;
//! a missing fixture fails this ignored local qualification test.
use raw_core::{
    color::dcp,
    image::CfaPattern,
    pipeline::{
        develop_scene_linear_from_raw_with_quality,
        develop_scene_linear_sized_from_raw_with_quality, RenderQuality,
    },
    stages::wb_camera::SliderFrameExport,
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
#[ignore = "requires physical test_0006.DNG"]
fn lossy_dng_declared_transfer_reaches_full_sized_and_wb_frame() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0006.DNG");
    let raw = raw_core::decode::decode(&path).expect("required physical fixture");
    assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    assert_eq!(raw.white_level, 255);
    assert!(raw.linearization_transfer.is_some());
    assert!(!raw.uses_legacy_lossy_linearraw());
    let linear = raw_core::linearize::linearraw_to_camera_rgb(&raw).unwrap();
    for (pixel, stored) in linear.pixels.iter().zip(raw.raw_data.chunks_exact(3)) {
        for c in 0..3 {
            let x = stored[c] as f64 / 255.;
            let base = 0.0625 * x + 0.9375 * x * x * x;
            let expected = if c == 1 {
                0.0002746623941405356 + (1.0 - 0.0002746623941405356) * base
            } else {
                base
            };
            assert!((f64::from(pixel[c]) - expected).abs() < 2e-7);
        }
    }
    drop(linear);
    let profile = dcp::profile_for(&raw).unwrap();
    assert!(
        profile.wb_already_baked,
        "declared linearization uses camera WB pre-gain"
    );
    assert!(SliderFrameExport::resolve(&raw, &profile).is_present());
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.,
        nr_color: 0.,
        tint: 150.,
        tint_seen: true,
        ..Default::default()
    };
    let full =
        develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Amaze).unwrap();
    let sized = develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Amaze,
        raw.width.max(raw.height),
    )
    .unwrap();
    assert_eq!(
        (full.width, full.height, full.space),
        (sized.width, sized.height, sized.space)
    );
    assert_eq!(full.pixels, sized.pixels);
}
