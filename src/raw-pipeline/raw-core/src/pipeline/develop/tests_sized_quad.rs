//! #4373: a bounded non-Preview Bayer sized develop reconstructs its
//! half-size buffer with RCD quads, not `half_res`'s CFA binning.
use super::*;
use crate::{
    cancel::CancelToken,
    demosaic,
    pipeline::develop_sized::develop_sized_camera,
    test_support::synth_dng::SyntheticGreyDng,
    xmp::{AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
fn bounded_sized_develop_demosaics_with_rcd_quads() {
    let (width, height) = (512u32, 384u32);
    let bytes = SyntheticGreyDng {
        width,
        height,
        as_shot_neutral_override: Some([1.0; 3]),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.cfa = crate::image::CfaPattern::Rggb;
    raw.black_level = [0; 4];
    raw.white_level = 60_000;
    raw.crop_rect = None;
    raw.baseline_exposure = 0.0;
    // Detail near the sensor's Nyquist rate, where a reconstruction and a
    // CFA-sample binning part; nothing clips.
    raw.raw_data = (0..width * height)
        .map(|i| {
            let (x, y) = ((i % width) as f32, (i / width) as f32);
            let value =
                0.5 + 0.2 * (x * 1.3).sin() * (y * 0.9).cos() + 0.1 * ((x + y) * 0.21).sin();
            (value * 60_000.0).round() as u16
        })
        .collect();
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        ..Default::default()
    };

    let ready = develop_sized_camera(
        &raw,
        &model,
        RenderQuality::Full,
        width / 2,
        CancelToken::never(),
    )
    .unwrap();

    let mosaic = crate::linearize::sensor_linearize(&raw);
    let quads = demosaic::rcd_quad_half_cancellable(&mosaic, raw.cfa, CancelToken::never());
    let binned = demosaic::half_res_cancellable(&mosaic, raw.cfa, CancelToken::never());
    assert_ne!(
        quads.pixels, binned.pixels,
        "the frame must tell the kernels apart"
    );
    assert_eq!(
        (ready.camera_rgb.width, ready.camera_rgb.height),
        (width / 2, height / 2)
    );
    assert!(
        ready.camera_rgb.pixels == quads.pixels,
        "the bounded sized develop must reconstruct with RCD quads"
    );
}
