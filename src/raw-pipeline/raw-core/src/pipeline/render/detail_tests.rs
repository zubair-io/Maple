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
            target: crate::view::encode::TargetPrimaries::Srgb,
            quality: RenderQuality::Amaze,
            max_long_edge: 1024,
            film_lut: None,
        },
    )
    .unwrap()
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
        local_adjustments: vec![crate::types::LocalAdjustment {
            mask: crate::types::Mask::Radial {
                center: crate::types::Point2::new(0.3, 0.25),
                radii: crate::types::Point2::new(0.35, 0.2),
                angle: 0.4,
                feather: 0.5,
                invert: false,
            },
            range: None,
            adjustments: crate::types::PartialAdjustments {
                exposure: Some(1.5),
                ..Default::default()
            },
        }],
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
                    target: crate::view::encode::TargetPrimaries::Srgb,
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
fn detail_rejects_perspective_unsupported_stage_and_padded_allocation() {
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
    context.model.perspective_vertical = 10.0;
    assert!(render_detail_tile(&raw, &context, rect, None, u64::MAX)
        .unwrap_err()
        .to_string()
        .contains("perspective"));
    context.model.perspective_vertical = 0.0;
    context.active_model.deep_denoise = 30.0;
    assert!(render_detail_tile(&raw, &context, rect, None, u64::MAX)
        .unwrap_err()
        .to_string()
        .contains("deep denoise"));
    context.active_model.deep_denoise = 0.0;
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
    let mut previous_pixels = None;
    for target in [encode::TargetPrimaries::Srgb, encode::TargetPrimaries::P3] {
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
                target,
                quality: RenderQuality::Amaze,
                max_long_edge: 1024,
                film_lut: Some(&film),
            },
        )
        .unwrap();
        // Auto 2's cached curve is a marker that render contexts omit (#5000).
        assert_eq!(
            context.profile_curve,
            crate::view::auto_profile::apply_pipeline::auto1_enabled_by_env().then_some(curve)
        );
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
        let (_, _, patch) =
            render_detail_tile(&raw, &context, rect, Some(&film), u64::MAX).unwrap();
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
        if let Some(previous) = previous_pixels.take() {
            assert_ne!(previous, rgb, "P3 must use its requested primaries");
        }
        previous_pixels = Some(rgb);
    }
}

#[path = "detail_crop_tests.rs"]
mod crop_tests;

/// #3287: a native-detail session tiles dehaze from the haze map its base
/// measured, keeps that map while only the dehaze amount moves, and measures
/// again when anything upstream of dehaze does.
#[test]
fn detail_dehaze_tiles_from_the_retained_map_and_keeps_it_across_amount_moves() {
    let (raw, bytes) = chart();
    let raw = std::sync::Arc::new(raw);
    let retained = |model: &AdjustmentModel, previous: Option<DetailContext>| {
        render_detail_base_retained(
            std::sync::Arc::clone(&raw),
            model,
            RawInput::Bytes {
                bytes: &bytes,
                ext: "dng",
            },
            DetailRenderOptions {
                target: crate::view::encode::TargetPrimaries::Srgb,
                quality: RenderQuality::Amaze,
                max_long_edge: 1024,
                film_lut: None,
            },
            u64::MAX,
            previous,
        )
        .unwrap()
    };
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        dehaze: 40.0,
        ..Default::default()
    };
    let (w, h, rgb, context) = retained(&model, None);
    let measured = context.haze.clone().expect("dehaze measures a map");
    let rect = TileRect {
        src_x: w / 4,
        src_y: h / 4,
        src_w: w / 2,
        src_h: h / 2,
        out_w: w / 2,
        out_h: h / 2,
    };
    let (pw, ph, patch) = render_detail_tile(&raw, &context, rect, None, u64::MAX).unwrap();
    let worst = (0..ph)
        .flat_map(|y| (0..pw * 3).map(move |i| (y, i)))
        .map(|(y, i)| {
            let a = patch[(y * pw * 3 + i) as usize];
            let b = rgb[((y + rect.src_y) * w * 3 + rect.src_x * 3 + i) as usize];
            a.abs_diff(b)
        })
        .max()
        .unwrap();
    // The base measures its own map from this 520-px chart, which the
    // 2048-texel proxy grid upsamples 4×, while the tile reads the
    // Preview-density map a native export uses. On real 24–40 MP frames the
    // two add under one code of mean seam to the base/patch floor.
    assert!(
        worst <= 6,
        "dehaze tile parts from its base by {worst} codes"
    );

    let moved = AdjustmentModel {
        dehaze: -60.0,
        ..model.clone()
    };
    let (_, _, _, next) = retained(&moved, Some(context));
    assert!(std::sync::Arc::ptr_eq(
        &measured,
        next.haze.as_ref().expect("still engaged")
    ));
    let upstream = AdjustmentModel {
        exposure: 0.5,
        ..moved
    };
    let (_, _, _, last) = retained(&upstream, Some(next));
    assert!(!std::sync::Arc::ptr_eq(
        &measured,
        last.haze.as_ref().expect("still engaged")
    ));
    // Dragging the only per-mask dehaze layer keeps its map too (#3287).
    let layered = |amount: f32| AdjustmentModel {
        local_adjustments: vec![crate::types::LocalAdjustment::radial(
            crate::types::Point2::new(0.5, 0.5),
            crate::types::Point2::new(0.3, 0.3),
            crate::types::PartialAdjustments {
                dehaze: Some(amount),
                ..Default::default()
            },
        )],
        ..model.clone()
    };
    let (_, _, _, first) = retained(&layered(20.0), Some(last));
    let kept = first.haze.clone().expect("layer dehaze measures");
    let (_, _, _, dragged) = retained(&layered(70.0), Some(first));
    assert!(std::sync::Arc::ptr_eq(
        &kept,
        dragged.haze.as_ref().unwrap()
    ));
}
