//! Actual Bayer full/tile entry regression for guided context loss (#4378).
use crate::{
    pipeline::{self, RenderQuality, TileRect},
    test_support::synth_dng::SyntheticGreyDng,
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

fn compare(quality: RenderQuality, active_area: bool) {
    let bytes = SyntheticGreyDng {
        width: 320,
        height: 320,
        as_shot_neutral_override: Some([0.5, 1.0, 0.7]),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.black_level = [0; 4];
    raw.white_level = 10000;
    raw.baseline_exposure = 0.0;
    raw.as_shot_neutral = [0.5, 1.0, 0.7];
    raw.crop_rect = None;
    raw.lens_metadata.active_area = None;
    if active_area {
        raw.lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
            left: 5,
            top: 7,
            width: 306,
            height: 304,
        });
    }
    for (i, v) in raw.raw_data.iter_mut().enumerate() {
        let (x, y) = (i as u32 % 320, i as u32 / 320);
        let c = raw.cfa.color_at(x, y) as usize;
        *v = if (60..261).contains(&x) && (60..261).contains(&y) {
            [9000u16, 10000, 4200][c]
        } else {
            [4500u16, 7000, 2100][c]
        };
    }
    let base = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        capture_sharpening_amount: 0.0,
        ..Default::default()
    };
    let divisor = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    for mode in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = AdjustmentModel {
            highlight_recovery: mode,
            ..base.clone()
        };
        let full =
            pipeline::develop_scene_linear_from_raw_with_quality(&raw, &model, quality).unwrap();
        for (x, y) in [(152, 152), (158, 154), (48, 52)] {
            let rect = TileRect {
                src_x: x,
                src_y: y,
                src_w: 16,
                src_h: 16,
                out_w: 16 / divisor,
                out_h: 16 / divisor,
            };
            let (w, h, tile) = pipeline::render_scene_linear_tile_from_raw_with_quality_f32(
                &raw, &model, rect, quality,
            )
            .unwrap();
            assert_eq!((w, h), (16 / divisor, 16 / divisor));
            for ty in 0..h {
                for tx in 0..w {
                    for c in 0..3 {
                        let expected = full.pixels
                            [((y / divisor + ty) * full.width + x / divisor + tx) as usize][c];
                        let actual = tile[((ty * w + tx) * 4 + c as u32) as usize];
                        assert!((expected-actual).abs() <= 1e-4,"{quality:?}/{mode:?}/AA{active_area} ({x},{y}) pixel({tx},{ty}) channel{c}: full{expected} tile{actual}");
                    }
                }
            }
        }
    }
}
#[test]
fn guided_large_bayer_tile_matches_full_rcd() {
    compare(RenderQuality::Full, false);
}
#[test]
fn guided_large_bayer_tile_matches_full_amaze() {
    compare(RenderQuality::Amaze, false);
}
#[test]
fn guided_bayer_tile_preserves_odd_active_area_sampling() {
    compare(RenderQuality::Full, true);
}
#[test]
fn guided_large_bayer_tile_matches_full_preview() {
    compare(RenderQuality::Preview, false);
}

fn textured_raw() -> crate::image::RawImage {
    let bytes = SyntheticGreyDng {
        width: 640,
        height: 640,
        as_shot_neutral_override: Some([0.5, 1.0, 0.7]),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.black_level = [0; 4];
    raw.white_level = 10000;
    raw.baseline_exposure = 0.75;
    raw.as_shot_neutral = [0.5, 1.0, 0.7];
    raw.crop_rect = Some(crate::image::CropRect {
        x: 3,
        y: 5,
        w: 631,
        h: 629,
    });
    raw.lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
        left: 5,
        top: 7,
        width: 626,
        height: 624,
    });
    for (i, v) in raw.raw_data.iter_mut().enumerate() {
        let (x, y) = (i as u32 % 640, i as u32 / 640);
        let c = raw.cfa.color_at(x, y) as usize;
        let noise = (x
            .wrapping_mul(131)
            .wrapping_add(y.wrapping_mul(173))
            .wrapping_add(x.wrapping_mul(y).wrapping_mul(7)))
            % 71;
        let clipped = ((160..361).contains(&x) && (160..361).contains(&y))
            || ((112..143).contains(&x) && (112..143).contains(&y));
        let rgb = [
            3500 + x * 5 + noise,
            if clipped { 10000 } else { 5500 + noise },
            1800 + y * 5 + noise,
        ];
        *v = rgb[c] as u16;
    }
    raw
}
fn neutral_model() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        capture_sharpening_amount: 0.0,
        ..Default::default()
    }
}
fn assert_roi(
    full: &crate::image::Image,
    tile: &[f32],
    raw: &crate::image::RawImage,
    quality: RenderQuality,
    rect: TileRect,
) {
    let d = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let crop = raw.crop_rect.unwrap();
    for y in 0..rect.out_h {
        for x in 0..rect.out_w {
            for c in 0..3 {
                let expected = full.pixels[((rect.src_y / d - crop.y / d + y) * full.width
                    + rect.src_x / d
                    - crop.x / d
                    + x) as usize][c];
                let actual = tile[((y * rect.out_w + x) * 4 + c as u32) as usize];
                assert!((expected-actual).abs() <= 1e-4,"textured {quality:?} ROI({},{}), pixel({x},{y}) channel{c}: full{expected} tile{actual}",rect.src_x,rect.src_y);
            }
        }
    }
}
fn textured_compare(quality: RenderQuality) {
    let raw = std::sync::Arc::new(textured_raw());
    let d = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
    let base = neutral_model();
    let mut centers = Vec::new();
    for mode in [
        HighlightRecoveryMode::Off,
        HighlightRecoveryMode::ChromaticAdaptation,
    ] {
        let model = AdjustmentModel {
            highlight_recovery: mode,
            ..base.clone()
        };
        let frame = pipeline::HighlightFrameContext::prepare(raw.clone(), &model, quality).unwrap();
        assert_eq!(frame.quality(), quality);
        assert!(std::ptr::eq(frame.raw(), raw.as_ref()));
        let full =
            pipeline::develop_scene_linear_from_raw_with_quality(&raw, &model, quality).unwrap();
        for (x, y) in [(247, 251), (121, 125), (381, 253), (7, 9)] {
            let rect = TileRect {
                src_x: x,
                src_y: y,
                src_w: 16,
                src_h: 16,
                out_w: 16 / d,
                out_h: 16 / d,
            };
            let (w, h, tile) = pipeline::render_scene_linear_tile_from_frame_context_f32(
                &frame, &model, rect, None, 1.0,
            )
            .unwrap();
            assert_eq!((w, h), (rect.out_w, rect.out_h));
            assert_roi(&full, &tile, &raw, quality, rect);
            if (x, y) == (247, 251) {
                centers.push(tile[1]);
                assert_ne!(
                    tile[0].to_bits(),
                    tile[(w as usize - 1) * 4].to_bits(),
                    "known red texture must vary"
                );
            }
        }
    }
    assert!(
        (centers[0] - centers[1]).abs() > 0.01,
        "guided recovery must genuinely change clipped green"
    );
}
#[test]
fn guided_textured_frame_phase_rcd() {
    textured_compare(RenderQuality::Full);
}
#[test]
fn guided_textured_frame_phase_amaze() {
    textured_compare(RenderQuality::Amaze);
}
#[test]
fn guided_textured_frame_phase_preview() {
    textured_compare(RenderQuality::Preview);
}
#[test]
fn guided_context_source_ownership_and_prefix() {
    use std::sync::Arc;
    let mut raw = Arc::new(textured_raw());
    let model = neutral_model();
    let weak = Arc::downgrade(&raw);
    let frame =
        pipeline::HighlightFrameContext::prepare(raw.clone(), &model, RenderQuality::Full).unwrap();
    assert!(
        Arc::get_mut(&mut raw).is_none(),
        "retained source cannot be mutated"
    );
    let changed = AdjustmentModel {
        hot_pixel_suppression: crate::types::adjustment::HotPixelSuppressionMode::On,
        ..model.clone()
    };
    let rect = TileRect {
        src_x: 247,
        src_y: 251,
        src_w: 16,
        src_h: 16,
        out_w: 16,
        out_h: 16,
    };
    assert!(pipeline::render_scene_linear_tile_from_frame_context_f32(
        &frame, &changed, rect, None, 1.0
    )
    .is_err());
    let invalid = TileRect {
        src_x: 9999,
        ..rect
    };
    assert!(pipeline::render_scene_linear_tile_from_frame_context_f32(
        &frame, &model, invalid, None, 1.0
    )
    .is_err());
    let (_, _, retry) =
        pipeline::render_scene_linear_tile_from_frame_context_f32(&frame, &model, rect, None, 1.0)
            .unwrap();
    let (_, _, legacy) = pipeline::render_scene_linear_tile_from_raw_with_quality_f32(
        &raw,
        &model,
        rect,
        RenderQuality::Full,
    )
    .unwrap();
    assert_eq!(
        retry, legacy,
        "failed request must preserve captured context"
    );
    drop(raw);
    assert!(weak.upgrade().is_some());
    drop(frame);
    assert!(weak.upgrade().is_none());
}

#[test]
fn guided_preparation_admission_counts_odd_sensor_tail() {
    let mut raw = textured_raw();
    raw.width = 12000;
    raw.height = 769;
    let model = neutral_model();
    assert_eq!(
        pipeline::HighlightFrameContext::preparation_working_pixels(
            &raw,
            &model,
            RenderQuality::Preview
        ),
        12000 * 769
    );
    raw.width = 24000;
    raw.height = 1000;
    assert!(
        pipeline::HighlightFrameContext::preparation_working_pixels(
            &raw,
            &model,
            RenderQuality::Auto
        ) > 8 * 1024 * 1024
    );
    let bytes = SyntheticGreyDng {
        width: 32,
        height: 32,
        ..Default::default()
    }
    .write_to_bytes();
    let raw = std::sync::Arc::new(crate::decode::decode_bytes(&bytes, "dng").unwrap());
    let result = pipeline::render_detail_base_retained(
        raw.clone(),
        &model,
        pipeline::RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        pipeline::DetailRenderOptions {
            quality: RenderQuality::Preview,
            max_long_edge: 32,
            film_lut: None,
        },
        0,
        None,
    );
    assert!(
        matches!(result, Err(crate::error::Error::Pipeline(ref message)) if message.contains("preparation exceeds working-pixel budget"))
    );
    assert_eq!(
        std::sync::Arc::strong_count(&raw),
        1,
        "rejected preparation retains no source/context"
    );
}

#[test]
fn guided_clipped_radial_warp_matches_full_order() {
    use crate::pipeline::pano::opcodes::{
        ActiveAreaRect, OpcodeList3, PanoOpcode, WarpPlaneParams, WarpRectilinearOpcode,
    };
    let mut raw = textured_raw();
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![WarpPlaneParams {
                    kr: [0.984778, 0.035585, -0.075203, 0.054787],
                    kt: [0.0, 0.0],
                }],
                center_x: 0.5,
                center_y: 0.5,
            })],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(raw.width, raw.height),
    ));
    let raw = std::sync::Arc::new(raw);
    for quality in [
        RenderQuality::Full,
        RenderQuality::Amaze,
        RenderQuality::Preview,
    ] {
        let d = crate::pipeline::develop::effective_quality_divisor(quality, raw.cfa);
        let mut centers = Vec::new();
        for mode in [
            HighlightRecoveryMode::Off,
            HighlightRecoveryMode::ChromaticAdaptation,
        ] {
            let model = AdjustmentModel {
                highlight_recovery: mode,
                ..neutral_model()
            };
            let frame =
                pipeline::HighlightFrameContext::prepare(raw.clone(), &model, quality).unwrap();
            let full = pipeline::develop_scene_linear_from_raw_with_quality(&raw, &model, quality)
                .unwrap();
            for (x, y) in [(247, 251), (121, 125), (381, 253)] {
                let rect = TileRect {
                    src_x: x,
                    src_y: y,
                    src_w: 16,
                    src_h: 16,
                    out_w: 16 / d,
                    out_h: 16 / d,
                };
                let (_, _, tile) = pipeline::render_scene_linear_tile_from_frame_context_f32(
                    &frame, &model, rect, None, 1.0,
                )
                .unwrap();
                assert_roi(&full, &tile, &raw, quality, rect);
                if (x, y) == (247, 251) {
                    centers.push(tile[1]);
                }
            }
        }
        assert!(
            (centers[0] - centers[1]).abs() > 0.01,
            "clipped warp control must engage recovery"
        );
    }
}

#[test]
fn guided_context_reuse_requires_same_source_quality_and_prefix() {
    use std::sync::Arc;
    let raw = Arc::new(textured_raw());
    let model = neutral_model();
    let frame =
        pipeline::HighlightFrameContext::prepare(raw.clone(), &model, RenderQuality::Auto).unwrap();
    let slider_edit = AdjustmentModel {
        exposure: 1.25,
        contrast: 30.0,
        ..model.clone()
    };
    assert!(frame.reusable_for(&raw, &slider_edit, RenderQuality::Auto));
    assert!(!frame.reusable_for(&raw, &model, RenderQuality::Full));
    let recovery_edit = AdjustmentModel {
        highlight_recovery: HighlightRecoveryMode::Off,
        ..model.clone()
    };
    assert!(!frame.reusable_for(&raw, &recovery_edit, RenderQuality::Auto));
    let demosaic_edit = AdjustmentModel {
        demosaic: crate::types::adjustment::DemosaicChoice::Rcd,
        ..model.clone()
    };
    assert!(!frame.reusable_for(&raw, &demosaic_edit, RenderQuality::Auto));
    let same_pixels = Arc::new(textured_raw());
    assert!(!frame.reusable_for(&same_pixels, &model, RenderQuality::Auto));
}

#[test]
fn guided_context_samples_frame_only_when_a_tile_defers_to_the_scene_prior() {
    let raw = std::sync::Arc::new(textured_raw());
    let model = neutral_model();
    let frame =
        pipeline::HighlightFrameContext::prepare(raw.clone(), &model, RenderQuality::Full).unwrap();
    assert!(!frame.scene_sampled());
    let unclipped = TileRect {
        src_x: 500,
        src_y: 500,
        src_w: 16,
        src_h: 16,
        out_w: 16,
        out_h: 16,
    };
    pipeline::render_scene_linear_tile_from_frame_context_f32(&frame, &model, unclipped, None, 1.0)
        .unwrap();
    assert!(
        !frame.scene_sampled(),
        "a tile with no deferred pixels must not sample the frame"
    );
    let clipped_interior = TileRect {
        src_x: 247,
        src_y: 251,
        ..unclipped
    };
    pipeline::render_scene_linear_tile_from_frame_context_f32(
        &frame,
        &model,
        clipped_interior,
        None,
        1.0,
    )
    .unwrap();
    assert!(frame.scene_sampled());
}
