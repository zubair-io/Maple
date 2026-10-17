//! #4627: both native-resolution develop entries use the same balanced
//! reconstruction, including the explicit dual AMaZE selector.
#![cfg(feature = "test-support")]

use raw_core::{
    image::{CfaPattern, RawImage},
    pipeline::{
        develop_scene_linear_from_raw_with_quality,
        develop_scene_linear_from_raw_with_quality_cancellable,
        develop_scene_linear_sized_from_raw_with_quality,
        develop_scene_linear_sized_from_raw_with_quality_cancellable,
        render_scene_linear_tile_from_raw_with_quality_f32, RenderQuality, TileRect,
    },
    test_support::synth_dng::SyntheticGreyDng,
    xmp::{AdjustmentModel, AutoExposureMode, DemosaicChoice, HighlightRecoveryMode, Profile},
    CancelToken, Error,
};

fn raw(cfa: CfaPattern) -> RawImage {
    let bytes = SyntheticGreyDng {
        width: 96,
        height: 80,
        as_shot_neutral_override: Some([0.4, 1.0, 0.6]),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.cfa = cfa;
    raw.black_level = [0; 4];
    raw.white_level = 10000;
    raw.baseline_exposure = 0.0;
    raw.crop_rect = None;
    for (i, sample) in raw.raw_data.iter_mut().enumerate() {
        let (x, y) = (i as u32 % raw.width, i as u32 / raw.width);
        let c = cfa.color_at(x, y) as usize;
        let light = 0.4 + 0.2 * (x as f32 * 0.5).sin() + 0.1 * (y as f32 * 0.8).cos();
        *sample = (10000.0 * light * raw.as_shot_neutral[c]).round() as u16;
    }
    raw
}

#[test]
fn full_and_sized_camera_prefixes_match() {
    for cfa in [
        CfaPattern::Rggb,
        CfaPattern::Bggr,
        CfaPattern::Grbg,
        CfaPattern::Gbrg,
    ] {
        let raw = raw(cfa);
        for demosaic in [DemosaicChoice::Amaze, DemosaicChoice::DualAmaze] {
            let model = AdjustmentModel {
                demosaic,
                profile: Profile::Neutral,
                auto_exposure: AutoExposureMode::Off,
                highlight_recovery: HighlightRecoveryMode::Off,
                sharpen_amount: 0.0,
                nr_color: 0.0,
                ..Default::default()
            };
            let full =
                develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Amaze)
                    .unwrap();
            let sized = develop_scene_linear_sized_from_raw_with_quality(
                &raw,
                &model,
                RenderQuality::Amaze,
                96,
            )
            .unwrap();
            assert_eq!(
                (full.width, full.height, full.space),
                (sized.width, sized.height, sized.space)
            );
            assert_eq!(full.pixels, sized.pixels, "{cfa:?} {demosaic:?}");
            // This interior tile's padding spans the small synthetic frame,
            // so it must use exactly the same balanced camera reconstruction.
            let rect = TileRect {
                src_x: 32,
                src_y: 24,
                src_w: 32,
                src_h: 32,
                out_w: 32,
                out_h: 32,
            };
            let (w, h, tile) = render_scene_linear_tile_from_raw_with_quality_f32(
                &raw,
                &model,
                rect,
                RenderQuality::Amaze,
            )
            .unwrap();
            assert_eq!((w, h), (32, 32));
            for y in 0..32 {
                for x in 0..32 {
                    let actual = &tile[4 * (y * 32 + x)..4 * (y * 32 + x) + 3];
                    let expected = full.pixels[(y + 24) * 96 + x + 32];
                    for c in 0..3 {
                        assert!(
                            (actual[c] - expected[c]).abs() < 1e-4,
                            "tile {cfa:?} {demosaic:?} ({x},{y}): {actual:?} vs {expected:?}"
                        );
                    }
                }
            }
            let flag = std::sync::atomic::AtomicBool::new(true);
            let cancelled = CancelToken::new(&flag);
            assert!(matches!(
                develop_scene_linear_from_raw_with_quality_cancellable(
                    &raw,
                    &model,
                    RenderQuality::Amaze,
                    cancelled
                ),
                Err(Error::Cancelled)
            ));
            assert!(matches!(
                develop_scene_linear_sized_from_raw_with_quality_cancellable(
                    &raw,
                    &model,
                    RenderQuality::Amaze,
                    96,
                    cancelled
                ),
                Err(Error::Cancelled)
            ));
        }
    }
}
