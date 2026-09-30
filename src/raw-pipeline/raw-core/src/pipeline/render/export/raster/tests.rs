use super::*;
use crate::export_recipe::{export_bytes_with_recipe, ExportRecipe};
use image::{ImageEncoder, Rgb, RgbImage};

fn model() -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    }
}

fn jpeg() -> Vec<u8> {
    let pixels = RgbImage::from_fn(32, 24, |x, y| Rgb([40 + x as u8, 50 + y as u8, 60]));
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100)
        .encode_image(&pixels)
        .unwrap();
    bytes
}

#[test]
fn jpeg_defaults_preserve_baked_tone_and_exposure_changes_export() {
    let source = jpeg();
    let before = source.clone();
    let recipe = ExportRecipe {
        format: "png".into(),
        quality: None,
        ..Default::default()
    };
    let baseline = export_bytes_with_recipe(&source, "jpg", &model(), &recipe, None).unwrap();
    let expected = image::load_from_memory(&source).unwrap().to_rgb8();
    let actual = image::load_from_memory(&baseline.bytes).unwrap().to_rgb8();
    for (got, want) in actual.as_raw().iter().zip(expected.as_raw()) {
        assert!(
            got.abs_diff(*want) <= 1,
            "a baked JPEG must not be tone-mapped again"
        );
    }
    let boosted = export_bytes_with_recipe(
        &source,
        "jpg",
        &AdjustmentModel {
            exposure: 1.0,
            ..model()
        },
        &recipe,
        None,
    )
    .unwrap();
    let boosted = image::load_from_memory(&boosted.bytes).unwrap().to_rgb8();
    assert!(
        boosted.as_raw().iter().map(|v| *v as u64).sum::<u64>()
            > actual.as_raw().iter().map(|v| *v as u64).sum::<u64>() * 12 / 10
    );
    assert_eq!(source, before);
}

#[test]
fn sixteen_bit_tiff_keeps_sub_eight_bit_precision_and_output_profile() {
    let pixels =
        image::ImageBuffer::from_fn(64, 8, |x, _| image::Rgb([16000u16 + x as u16 * 4; 3]));
    let mut source = Cursor::new(Vec::new());
    DynamicImage::ImageRgb16(pixels)
        .write_to(&mut source, image::ImageFormat::Tiff)
        .unwrap();
    let source = source.into_inner();
    let recipe = ExportRecipe {
        format: "tiff".into(),
        quality: None,
        bit_depth: 16,
        output_profile: "display-p3".into(),
        ..Default::default()
    };
    let output = export_bytes_with_recipe(&source, "tif", &model(), &recipe, None).unwrap();
    let pixels = image::load_from_memory(&output.bytes).unwrap().to_rgb16();
    let unique: std::collections::HashSet<_> = pixels.pixels().map(|p| p[0]).collect();
    assert!(
        unique.len() > 50,
        "an RGB8 intermediate destroys this gradient"
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&output.bytes)
            .icc
            .unwrap(),
        crate::icc::profile_for(TargetPrimaries::P3)
    );
}

#[test]
fn invalid_profile_and_raw_only_adjustments_fail_explicitly() {
    let mut source = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut source);
    encoder
        .set_icc_profile(b"invalid ICC profile".to_vec())
        .unwrap();
    encoder
        .encode(&[80; 12], 2, 2, image::ExtendedColorType::Rgb8)
        .unwrap();
    let error = export_bytes_with_recipe(&source, "jpg", &model(), &ExportRecipe::default(), None)
        .err()
        .unwrap();
    assert!(error.contains("input ICC profile"), "{error}");
    let error = export_bytes_with_recipe(
        &jpeg(),
        "jpg",
        &AdjustmentModel {
            deep_denoise: 20.0,
            ..model()
        },
        &ExportRecipe::default(),
        None,
    )
    .err()
    .unwrap();
    assert!(
        error.contains("deep denoise requires a RAW source"),
        "{error}"
    );
}

#[test]
fn tagged_p3_tiff_round_trip_keeps_colour_and_uses_its_input_profile() {
    let bytes = jpeg();
    let recipe = ExportRecipe {
        format: "tiff".into(),
        bit_depth: 16,
        quality: None,
        output_profile: "display-p3".into(),
        ..Default::default()
    };
    let p3 = export_bytes_with_recipe(&bytes, "jpg", &model(), &recipe, None).unwrap();
    let srgb = ExportRecipe {
        format: "png".into(),
        quality: None,
        ..Default::default()
    };
    let restored = export_bytes_with_recipe(&p3.bytes, "tiff", &model(), &srgb, None).unwrap();
    let restored = image::load_from_memory(&restored.bytes).unwrap().to_rgb8();
    let original = image::load_from_memory(&bytes).unwrap().to_rgb8();
    for (got, want) in restored.as_raw().iter().zip(original.as_raw()) {
        assert!(got.abs_diff(*want) <= 2, "ICC round trip {got}/{want}");
    }
}

#[test]
fn raw_dispatch_remains_identical_to_existing_recipe_render() {
    let bytes = crate::test_support::synth_perf::SyntheticPerfDng {
        width: 64,
        height: 48,
        cfa: crate::image::CfaPattern::Rggb,
    }
    .write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    let recipe = ExportRecipe::default();
    let expected = crate::export_recipe::export_with_recipe(
        &raw,
        &model(),
        Some(crate::pipeline::RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        }),
        &recipe,
        None,
    )
    .unwrap();
    let actual = export_bytes_with_recipe(&bytes, "dng", &model(), &recipe, None).unwrap();
    assert_eq!(actual.bytes, expected.bytes);
}

#[test]
fn jpeg_orientation_is_applied_once_before_display_relative_crop() {
    let source = jpeg();
    for orientation in 1u16..=8 {
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&[0; 6]);
        let mut tagged = vec![0xff, 0xd8, 0xff, 0xe1];
        tagged.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(&exif);
        tagged.extend_from_slice(&source[2..]);
        let mut expected = crate::raster::decode_raster(&tagged, Some("jpg")).unwrap();
        expected.auto_orient();
        let (width, height, output) = render_export_raster(
            &tagged,
            &model(),
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        assert_eq!((width, height), (expected.width, expected.height));
        let ExportPixels::Eight(output) = output else {
            panic!("eight-bit output expected")
        };
        for (got, want) in output.iter().zip(&expected.data) {
            assert!(
                got.abs_diff(*want) <= 2,
                "orientation {orientation}: {got}/{want}"
            );
        }
        let mut cropped = model();
        cropped.crop.right = 0.5;
        let (w, h, _) = render_export_raster(
            &tagged,
            &cropped,
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        assert_eq!((w, h), (width / 2, height));
    }
}

#[test]
fn edited_export_matches_non_raw_live_chain_and_respects_size_cap() {
    let bytes = jpeg();
    let edits = AdjustmentModel {
        exposure: 0.3,
        saturation: 15.0,
        vibrance: 8.0,
        temperature: 7000.0,
        tint: 3.0,
        grain_amount: 10.0,
        ..model()
    };
    let (mut decoded, _) = decode(&bytes).unwrap();
    downsample_image_area(&mut decoded, 16);
    let rgba: Vec<f32> = decoded
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let chained = crate::pipeline::apply_scene_linear_chain_f32(
        &rgba,
        decoded.width,
        decoded.height,
        &edits,
        &ChainOptions {
            skip_agx: true,
            ..Default::default()
        },
    )
    .unwrap();
    let expected =
        crate::pipeline::encode_display_srgb_f32(&chained, decoded.width, decoded.height).unwrap();
    let (width, height, output) = render_export_raster(
        &bytes,
        &edits,
        Some(16),
        TargetPrimaries::Srgb,
        ExportDepth::Eight,
        None,
    )
    .unwrap();
    assert_eq!((width, height), (16, 12));
    let ExportPixels::Eight(output) = output else {
        panic!("eight-bit output expected")
    };
    for (got, expected) in output.chunks_exact(3).zip(expected.chunks_exact(4)) {
        for channel in 0..3 {
            let want = (expected[channel].clamp(0.0, 1.0) * 255.0).round() as u8;
            assert!(got[channel].abs_diff(want) <= 1);
        }
    }
}
