use super::*;
use crate::test_support::synth_chart::{ChartEncoding, SyntheticColorChart};
use crate::types::adjustment::Profile;

fn chart() -> (RawImage, Vec<u8>) {
    let bytes = SyntheticColorChart {
        patch_size: 40,
        guard: 8,
        encoding: ChartEncoding::Camera,
        ..Default::default()
    }
    .write_to_bytes();
    (crate::decode::decode_bytes(&bytes, "dng").unwrap(), bytes)
}

fn base(
    raw: &RawImage,
    bytes: &[u8],
    model: &AdjustmentModel,
) -> (u32, u32, Vec<u8>, DetailContext) {
    render_detail_base(
        raw,
        model,
        RawInput::Bytes { bytes, ext: "dng" },
        DetailRenderOptions {
            quality: RenderQuality::Amaze,
            max_long_edge: 1024,
            film_lut: None,
        },
    )
    .unwrap()
}

#[test]
fn transformed_canvas_keeps_the_full_frame_fallback() {
    let (raw, bytes) = chart();
    let (_, _, _, mut context) = base(&raw, &bytes, &AdjustmentModel::default());
    let rect = TileRect {
        src_x: 0,
        src_y: 0,
        src_w: 32,
        src_h: 32,
        out_w: 32,
        out_h: 32,
    };
    context.model.geo_rotation = 5.0;
    let error = render_detail_tile(&raw, &context, rect, None, 1024 * 1024).unwrap_err();
    assert!(error.to_string().contains("transformed canvas"));
    context.model.geo_rotation = 0.0;
    context.model.lens_profile = format!("lcp1:{}", "a".repeat(64));
    let error = render_detail_tile(&raw, &context, rect, None, 1024 * 1024).unwrap_err();
    assert!(error.to_string().contains("transformed canvas"));
}

#[test]
fn detail_matches_native_display_in_every_orientation_with_default_crop() {
    let (mut raw, bytes) = chart();
    raw.crop_rect = Some(crate::image::CropRect {
        x: 12,
        y: 16,
        w: raw.width - 32,
        h: raw.height - 40,
    });
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        grain_amount: 30.0,
        grain_size: 40.0,
        vignette_amount: -35.0,
        ..Default::default()
    };
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
        let (w, h, rgb, context) = base(&raw, &bytes, &model);
        for (x, y) in [(0, 0), (w / 3, h / 3)] {
            let rect = TileRect {
                src_x: x,
                src_y: y,
                src_w: w / 3,
                src_h: h / 3,
                out_w: w / 3,
                out_h: h / 3,
            };
            let (pw, ph, patch) =
                render_detail_tile(&raw, &context, rect, None, 8 * 1024 * 1024).unwrap();
            assert_eq!((pw, ph), (rect.src_w, rect.src_h));
            let mut max_error = 0;
            for py in 0..ph {
                for px in 0..pw {
                    for c in 0..3 {
                        let a = patch[((py * pw + px) * 3 + c) as usize];
                        let b = rgb[(((py + y) * w + px + x) * 3 + c) as usize];
                        max_error = max_error.max(a.abs_diff(b));
                    }
                }
            }
            assert!(
                max_error <= 1,
                "{orientation:?} ({x},{y}) max code error={max_error}"
            );
        }
    }
}

#[test]
fn retained_base_preserves_existing_render_bytes() {
    let (raw, bytes) = chart();
    for profile in [Profile::Neutral, Profile::Auto] {
        let model = AdjustmentModel {
            profile,
            exposure: 0.35,
            ..Default::default()
        };
        for quality in [RenderQuality::Preview, RenderQuality::Amaze] {
            let (w, h, rgb, _) = render_detail_base(
                &raw,
                &model,
                RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                },
                DetailRenderOptions {
                    quality,
                    max_long_edge: 1024,
                    film_lut: None,
                },
            )
            .unwrap();
            let normal = crate::pipeline::render_sized_from_raw_with_quality_and_source(
                &raw,
                &model,
                quality,
                Some(RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                }),
                1024,
            )
            .unwrap();
            assert_eq!((w, h, rgb), normal, "{profile:?} {quality:?}");
        }
    }
}

#[test]
fn detail_rejects_crop_unsupported_stage_and_padded_allocation() {
    let (raw, bytes) = chart();
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        ..Default::default()
    };
    let (_, _, _, mut context) = base(&raw, &bytes, &model);
    let rect = TileRect {
        src_x: 40,
        src_y: 40,
        src_w: 24,
        src_h: 24,
        out_w: 24,
        out_h: 24,
    };
    let error = render_detail_tile(&raw, &context, rect, None, 24 * 24)
        .unwrap_err()
        .to_string();
    assert!(error.contains("memory budget"), "{error}");
    context.model.crop.left = 0.1;
    assert!(render_detail_tile(&raw, &context, rect, None, u64::MAX)
        .unwrap_err()
        .to_string()
        .contains("uncropped"));
    context.model.crop.left = 0.0;
    context.active_model.dehaze = 30.0;
    assert!(render_detail_tile(&raw, &context, rect, None, u64::MAX)
        .unwrap_err()
        .to_string()
        .contains("dehaze"));
    let invalid = TileRect {
        src_x: u32::MAX,
        ..rect
    };
    assert!(render_detail_tile(&raw, &context, invalid, None, u64::MAX)
        .unwrap_err()
        .to_string()
        .contains("rectangle"));
}

#[test]
fn detail_keeps_the_exact_auto_pair_and_film_of_the_base() {
    use crate::view::auto_profile::{cache, curve::ProfileCurve, lut::ColorLut};
    let (raw, mut bytes) = chart();
    // Distinct source key so this test cannot reuse another chart's fit.
    bytes.extend_from_slice(b"native-detail-auto-pair");
    let key = cache::CacheKey::from_bytes(&bytes, RenderQuality::Amaze).with_origin(
        super::super::auto_fit::render_fit_origin(raw.width.max(raw.height), Some(1024)),
    );
    let mut curve = ProfileCurve::identity();
    for (_, y) in &mut curve.r.anchors {
        *y *= 0.85;
    }
    let mut lut = ColorLut::identity(3);
    for p in lut.data.chunks_exact_mut(3) {
        p[2] *= 0.8;
    }
    cache::insert(key.clone(), curve.clone());
    cache::insert_lut(key, lut.clone());
    let mut film = FilmLut {
        size: 3,
        data: ColorLut::identity(3).data,
    };
    for p in film.data.chunks_exact_mut(3) {
        p[1] *= 0.85;
    }
    let model = AdjustmentModel {
        profile: Profile::Auto,
        exposure: 0.4,
        film_strength: 70.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    let (w, _, rgb, context) = render_detail_base(
        &raw,
        &model,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        DetailRenderOptions {
            quality: RenderQuality::Amaze,
            max_long_edge: 1024,
            film_lut: Some(&film),
        },
    )
    .unwrap();
    assert_eq!(context.profile_curve, Some(curve));
    assert_eq!(context.profile_lut, Some(lut));
    assert_eq!(context.ae_gain, 1.0, "Auto fitted base must pin AE off");
    let rect = TileRect {
        src_x: 60,
        src_y: 40,
        src_w: 80,
        src_h: 60,
        out_w: 80,
        out_h: 60,
    };
    let (_, _, patch) = render_detail_tile(&raw, &context, rect, Some(&film), u64::MAX).unwrap();
    let expected: Vec<u8> = (rect.src_y..rect.src_y + rect.src_h)
        .flat_map(|y| {
            let start = ((y * w + rect.src_x) * 3) as usize;
            rgb[start..start + rect.src_w as usize * 3].iter().copied()
        })
        .collect();
    let max_error = patch
        .iter()
        .zip(&expected)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(
        max_error <= 1,
        "retained Auto + film max code error={max_error}"
    );
    let without_film = render_detail_tile(&raw, &context, rect, None, u64::MAX)
        .unwrap()
        .2;
    assert_ne!(patch, without_film, "film test must exercise a real look");
}
