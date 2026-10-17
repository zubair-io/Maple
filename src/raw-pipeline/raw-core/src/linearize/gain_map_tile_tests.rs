//! Gain-map transport through complete full/tile entry points (#4647).
use super::gain_map_tests::{calibrated_raw, list, payload};
use crate::{
    image::RawImage,
    pipeline::{self, RenderQuality, TileRect},
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

fn model(mode: HighlightRecoveryMode) -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        sharpen_amount: 0.,
        nr_luminance: 0.,
        nr_color: 0.,
        highlight_recovery: mode,
        ..Default::default()
    }
}

fn compare(
    raw: &RawImage,
    quality: RenderQuality,
    mode: HighlightRecoveryMode,
    points: &[(u32, u32)],
) {
    let model = model(mode);
    let full = pipeline::develop_scene_linear_from_raw_with_quality(raw, &model, quality).unwrap();
    let d = if quality == RenderQuality::Preview {
        2
    } else {
        1
    };
    // The full image is DefaultCrop-relative; the low-level tile entry is
    // uncropped sensor-relative, as the native-detail wrapper also accounts for.
    let (crop_x, crop_y) = raw.crop_rect.map_or((0, 0), |r| (r.x, r.y));
    for &(x, y) in points {
        let rect = TileRect {
            src_x: x + crop_x,
            src_y: y + crop_y,
            src_w: 32,
            src_h: 32,
            out_w: 32 / d,
            out_h: 32 / d,
        };
        let (w, h, tile) = pipeline::render_scene_linear_tile_from_raw_with_quality_f32(
            raw, &model, rect, quality,
        )
        .unwrap();
        let mut max = 0.0_f32;
        for ty in 0..h {
            for tx in 0..w {
                for c in 0..3 {
                    let expected =
                        full.pixels[((y / d + ty) * full.width + x / d + tx) as usize][c];
                    let actual = tile[((ty * w + tx) * 4 + c as u32) as usize];
                    assert!(expected.is_finite() && actual.is_finite());
                    max = max.max((expected - actual).abs());
                }
            }
        }
        eprintln!("GainMap {quality:?}/{mode:?} tile {x},{y}: max {max}");
        assert!(
            max <= 1e-4,
            "GainMap full/tile {quality:?}/{mode:?} {x},{y}: max{max}"
        );
    }
}

#[test]
fn spatial_gains_preserve_full_tile_and_guided_scene_agreement() {
    let mut raw = calibrated_raw(320, 320);
    raw.black_level = [0; 4];
    raw.white_level = 10000;
    raw.baseline_exposure = 0.;
    raw.as_shot_neutral = [0.5, 1., 0.7];
    raw.crop_rect = None;
    raw.lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
        left: 5,
        top: 7,
        width: 306,
        height: 304,
    });
    let ops: Vec<_> = (0..4)
        .map(|i| {
            (
                9,
                0,
                payload(
                    [i / 2, i % 2, 304, 306],
                    [2; 2],
                    [2; 2],
                    [1.; 2],
                    [0.; 2],
                    &[1.2 + i as f32 * 0.1, 2.3, 3.1, 4.],
                ),
            )
        })
        .collect();
    raw.sensor_gain_maps = super::GainMaps::parse(&list(&ops)).unwrap();
    for (i, v) in raw.raw_data.iter_mut().enumerate() {
        let (x, y) = (i as u32 % 320, i as u32 / 320);
        let c = raw.cfa.color_at(x, y) as usize;
        *v = if (60..261).contains(&x) && (60..261).contains(&y) {
            [9000, 10000, 4200][c]
        } else {
            [4500, 7000, 2100][c]
        };
    }
    for q in [
        RenderQuality::Full,
        RenderQuality::Amaze,
        RenderQuality::Preview,
    ] {
        for m in [
            HighlightRecoveryMode::Off,
            HighlightRecoveryMode::ChromaticAdaptation,
        ] {
            compare(&raw, q, m, &[(144, 144), (158, 154), (48, 52)]);
        }
    }
}

#[test]
#[ignore = "requires test_0015.dng physical fixture"]
fn physical_pixel_gain_maps_and_vendor_warp_match_native_tiles() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0015.dng");
    let raw = crate::decode::decode(&path).expect("required Pixel fixture");
    assert!(raw.sensor_gain_maps.is_some() && raw.opcode_list3.is_some());
    assert_eq!(raw.orientation, crate::image::ExifOrientation::Normal);
    compare(
        &raw,
        RenderQuality::Amaze,
        HighlightRecoveryMode::ChromaticAdaptation,
        &[(288, 1440), (2400, 2240), (2016, 1472), (32, 32)],
    );
}
