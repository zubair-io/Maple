//! Saved detail must include accepted pixels and preserve terminal geometry.
use super::*;
use crate::{
    image::ExifOrientation,
    pipeline::{DetailRenderOptions, RawInput, RenderQuality, TileRect},
};

#[test]
fn saved_detail_matches_native_saved_display_in_every_orientation() {
    let (mut raw, original, model, assets) = super::tests::fixture();
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::Rotate180,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
        ExifOrientation::Rotate270,
    ] {
        raw.orientation = orientation;
        let stack =
            ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
                .unwrap();
        for exposure in [-2.0, 1.0] {
            let grade = AdjustmentModel {
                exposure,
                grain_amount: 30.0,
                grain_size: 40.0,
                ..model.clone()
            };
            let (w, h, base, context) = stack
                .render_detail_base(
                    &raw,
                    &original,
                    &grade,
                    RawInput::Bytes {
                        bytes: super::tests::RAW,
                        ext: "dng",
                    },
                    DetailRenderOptions {
                        quality: RenderQuality::Amaze,
                        max_long_edge: 1024,
                        film_lut: None,
                    },
                )
                .unwrap();
            let ordinary_saved = stack
                .render_display(
                    &raw,
                    &original,
                    &grade,
                    RenderQuality::Amaze,
                    Some(RawInput::Bytes {
                        bytes: super::tests::RAW,
                        ext: "dng",
                    }),
                    Some(1024),
                    None,
                )
                .unwrap();
            assert_eq!((w, h, base.clone()), ordinary_saved);
            for (x, y) in [(0, 0), (w / 3, h / 3)] {
                let rect = TileRect {
                    src_x: x,
                    src_y: y,
                    src_w: w / 2,
                    src_h: h / 2,
                    out_w: w / 2,
                    out_h: h / 2,
                };
                let (tw, th, rgb) = stack
                    .render_detail_tile(&raw, &original, &context, rect, None, 1024 * 1024)
                    .unwrap();
                let expected: Vec<u8> = (y..y + th)
                    .flat_map(|row| {
                        let start = ((row * w + x) * 3) as usize;
                        base[start..start + tw as usize * 3].iter().copied()
                    })
                    .collect();
                assert_eq!(rgb, expected, "{orientation:?} {exposure} ({x},{y})");
                assert!(
                    crate::pipeline::render_detail_tile(&raw, &context, rect, None, u64::MAX)
                        .is_err()
                );
                assert!(stack
                    .render_detail_tile(&raw, &original, &context, rect, None, 1)
                    .is_err());
                let wrong = ContentDigest::for_bytes(b"different original");
                assert!(stack
                    .render_detail_tile(&raw, &wrong, &context, rect, None, u64::MAX)
                    .is_err());
            }
        }
    }
}

#[cfg(feature = "test-support")]
#[test]
fn bounded_saved_tiles_match_a_larger_cropped_frame_across_patch_edges() {
    use crate::{
        image::CropRect,
        pipeline::{patch_to_bytes, prepare_accepted_removal, removal_mask_to_bytes},
        test_support::synth_chart::{ChartEncoding, SyntheticColorChart},
        types::{
            accepted_removal::NativeWindow, inpaint::decode_removals, removal_mask::RemovalMask,
        },
    };
    let bytes = SyntheticColorChart {
        patch_size: 64,
        guard: 8,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode_raw(&bytes, "dng").unwrap();
    raw.crop_rect = Some(CropRect {
        x: 12,
        y: 16,
        w: raw.width - 32,
        h: raw.height - 40,
    });
    let original = ContentDigest::for_bytes(&bytes);
    let source = super::super::removal_calibration_source_anchor(&raw, &original).unwrap();
    let window = NativeWindow {
        x: 80,
        y: 60,
        width: 128,
        height: 64,
    };
    let mask = removal_mask_to_bytes(&RemovalMask {
        source_width: source.width,
        source_height: source.height,
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
        pixels: vec![255; (window.width * window.height) as usize],
    })
    .unwrap();
    let patch = patch_to_bytes(&InpaintPatch {
        width: window.width,
        height: window.height,
        origin: [
            window.x as f32 / source.width as f32,
            window.y as f32 / source.height as f32,
        ],
        extent: [
            window.width as f32 / source.width as f32,
            window.height as f32 / source.height as f32,
        ],
        pixels: vec![[-0.08, 1.5, 0.25]; (window.width * window.height) as usize],
        coverage: vec![1.0; (window.width * window.height) as usize],
    })
    .unwrap();
    let records = prepare_accepted_removal(
        &serde_json::json!({
            "plate":"linear-calibration-v1", "source":source,
            "patch_window":window, "context_window":window,
            "model":ContentDigest::for_bytes(b"detail fixture model"),
            "recipe":ContentDigest::for_bytes(b"detail fixture recipe"),
            "model_version":"detail fixture", "bake":{"temp":6500,"tint":0,"ev":0},
        })
        .to_string(),
        "[]",
        &mask,
        &patch,
    )
    .unwrap();
    let model = AdjustmentModel {
        inpaint_removals: decode_removals(&records).unwrap(),
        profile: crate::types::adjustment::Profile::Neutral,
        exposure: -0.8,
        temperature: 4800.0,
        tint: 12.0,
        grain_amount: 30.0,
        grain_size: 40.0,
        vignette_amount: -35.0,
        ..super::super::removal_context::anchor_model()
    };
    let assets = BTreeMap::from([
        (
            format!("{}.mask", ContentDigest::for_bytes(&mask).hex()),
            mask,
        ),
        (
            format!("{}.f16", ContentDigest::for_bytes(&patch).hex()),
            patch,
        ),
    ]);
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
    ] {
        raw.orientation = orientation;
        let (w, h, base, context) = stack
            .render_detail_base(
                &raw,
                &original,
                &model,
                RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                },
                DetailRenderOptions {
                    quality: RenderQuality::Amaze,
                    max_long_edge: 2048,
                    film_lut: None,
                },
            )
            .unwrap();
        for (x, y) in [(40, 40), (96, 72), (w - 80, h - 64)] {
            let rect = TileRect {
                src_x: x,
                src_y: y,
                src_w: 80,
                src_h: 64,
                out_w: 80,
                out_h: 64,
            };
            let (_, _, tile) = stack
                .render_detail_tile(&raw, &original, &context, rect, None, 1024 * 1024)
                .unwrap();
            let expected: Vec<u8> = (y..y + 64)
                .flat_map(|row| {
                    let start = ((row * w + x) * 3) as usize;
                    base[start..start + 80 * 3].iter().copied()
                })
                .collect();
            let error = tile
                .iter()
                .zip(&expected)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                error <= 1,
                "{orientation:?} ({x},{y}) max code error={error}"
            );
        }
    }
}
