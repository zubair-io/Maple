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

#[test]
fn opaque_png_and_webp_preserve_baked_pixels_and_support_exposure() {
    let pixels = RgbImage::from_fn(32, 24, |x, y| Rgb([40 + x as u8, 50 + y as u8, 60]));
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(pixels.as_raw(), 32, 24, image::ExtendedColorType::Rgb8)
        .unwrap();
    let mut webp = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
        .write_image(pixels.as_raw(), 32, 24, image::ExtendedColorType::Rgb8)
        .unwrap();
    for (extension, source) in [("png", png), ("webp", webp)] {
        let recipe = ExportRecipe {
            format: "png".into(),
            quality: None,
            ..Default::default()
        };
        let exported =
            export_bytes_with_recipe(&source, extension, &model(), &recipe, None).unwrap();
        let actual = image::load_from_memory(&exported.bytes).unwrap().to_rgb8();
        for (actual, expected) in actual.as_raw().iter().zip(pixels.as_raw()) {
            assert!(actual.abs_diff(*expected) <= 1);
        }
        let (w, h, result) = crate::pipeline::render_export_raster(
            &source,
            &model(),
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        assert_eq!((w, h), (32, 24));
        let ExportPixels::Eight(rgb) = result else {
            panic!("wrong output depth")
        };
        for (actual, expected) in rgb.iter().zip(pixels.as_raw()) {
            assert!(actual.abs_diff(*expected) <= 1);
        }
        let boosted = AdjustmentModel {
            exposure: 1.0,
            ..model()
        };
        let (_, _, result) = crate::pipeline::render_export_raster(
            &source,
            &boosted,
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        let ExportPixels::Eight(brighter) = result else {
            panic!("wrong output depth")
        };
        assert!(
            brighter.iter().map(|v| *v as u64).sum::<u64>()
                > rgb.iter().map(|v| *v as u64).sum::<u64>() * 12 / 10
        );
    }
}

#[test]
fn png_and_webp_transparency_is_rejected_without_flattening() {
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[80, 90, 100, 128], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let mut webp = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
        .write_image(&[80, 90, 100, 128], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    for source in [png, webp] {
        let error = crate::pipeline::render_export_raster(
            &source,
            &model(),
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("transparency"));
    }
}

#[test]
fn sixteen_bit_png_retains_sub_eight_bit_precision() {
    let pixels =
        image::ImageBuffer::from_fn(64, 8, |x, _| image::Rgb([16000u16 + x as u16 * 4; 3]));
    let mut source = Cursor::new(Vec::new());
    DynamicImage::ImageRgb16(pixels)
        .write_to(&mut source, image::ImageFormat::Png)
        .unwrap();
    let (_, _, result) = crate::pipeline::render_export_raster(
        source.get_ref(),
        &model(),
        None,
        TargetPrimaries::Srgb,
        ExportDepth::Sixteen,
        None,
    )
    .unwrap();
    let ExportPixels::Sixteen(rgb) = result else {
        panic!("wrong output depth")
    };
    let unique: std::collections::HashSet<_> = rgb.chunks_exact(3).map(|p| p[0]).collect();
    assert!(
        unique.len() > 50,
        "an RGB8 intermediate destroys this gradient"
    );
}

#[test]
fn tagged_p3_png_matches_the_existing_tagged_tiff_colour_path() {
    let pixels = [80, 180, 40].repeat(4);
    let profile = crate::icc::profile_for(TargetPrimaries::P3);
    let mut source = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut source);
    encoder.set_icc_profile(profile.clone()).unwrap();
    encoder
        .write_image(&pixels, 2, 2, image::ExtendedColorType::Rgb8)
        .unwrap();
    let tiff = crate::raster_encode_tiff::encode_tiff_opts(
        &crate::raster::RasterImage::new_rgb(2, 2, pixels.clone()),
        &crate::raster_encode_tiff::TiffOptions {
            bitdepth: 8,
            ..Default::default()
        },
        &crate::raster_encode::EmbeddedMetadata {
            icc: Some(&profile),
            ..Default::default()
        },
    )
    .unwrap();
    let (png_scene, _) = decode(&source).unwrap();
    let (tiff_scene, _) = decode(&tiff).unwrap();
    assert_eq!(png_scene.pixels, tiff_scene.pixels);
    let untagged = crate::png::encode(2, 2, &pixels).unwrap();
    let (untagged_scene, _) = decode(&untagged).unwrap();
    assert_ne!(
        png_scene.pixels, untagged_scene.pixels,
        "the tagged P3 input must not be treated as sRGB"
    );
    let render = |bytes: &[u8]| {
        let (_, _, output) = crate::pipeline::render_export_raster(
            bytes,
            &model(),
            None,
            TargetPrimaries::P3,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        let ExportPixels::Eight(rgb) = output else {
            panic!("wrong output depth")
        };
        rgb
    };
    assert_eq!(render(&source), render(&tiff));
}

#[test]
fn jpeg_compressed_tiff_editor_matches_independent_oracles_and_rgb_chain() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/jpeg-tiff");
    for (name, width, height, orientation) in [
        ("strips", 73, 273, 1),
        ("tiles", 67, 45, 1),
        ("bigtiff", 67, 45, 1),
        ("quality40", 31, 27, 1),
        ("quality95", 31, 27, 1),
        ("orientation6", 31, 27, 6),
    ] {
        let bytes = std::fs::read(root.join(format!("{name}.tiff"))).unwrap();
        let oracle = std::fs::read(root.join(format!("{name}.rgb"))).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
        let errors: Vec<_> = decoded
            .data
            .iter()
            .zip(&oracle)
            .map(|(a, b)| a.abs_diff(*b))
            .collect();
        let max = *errors.iter().max().unwrap();
        let mean = errors.iter().map(|v| f64::from(*v)).sum::<f64>() / errors.len() as f64;
        // Retain the established independent JPEG decoder oracle budgets.
        // The editor's gamut mapping need not reproduce raw container RGB.
        assert!(max <= 4 && mean <= 0.5, "{name}: max={max}, mean={mean}");
        assert_eq!(decoded.orientation, ExifOrientation::from_u16(orientation));
        // Give the RGB counterpart the same EXIF orientation and sensor
        // ordering, so full-frame anchors see the identical reduction order.
        let mut png = Vec::new();
        {
            let mut encoder = image::codecs::png::PngEncoder::new(&mut png);
            encoder
                .set_exif_metadata(crate::raster_meta::set_exif_orientation(&[], orientation))
                .unwrap();
            if let Some(profile) = crate::raster_meta::read_sidecars(&bytes).icc {
                encoder.set_icc_profile(profile).unwrap();
            }
            encoder
                .write_image(&decoded.data, width, height, image::ExtendedColorType::Rgb8)
                .unwrap();
        }
        let (tiff_scene, tiff_orientation) = decode(&bytes).unwrap();
        let (png_scene, png_orientation) = decode(&png).unwrap();
        assert_eq!(tiff_orientation, png_orientation);
        assert_eq!(tiff_scene.pixels, png_scene.pixels, "{name}: scene decode");
        for exposure in [0.0, 1.0] {
            let edited = AdjustmentModel {
                exposure,
                ..model()
            };
            let tiff_result = render_export_raster(
                &bytes,
                &edited,
                None,
                TargetPrimaries::Srgb,
                ExportDepth::Eight,
                None,
            )
            .unwrap();
            let png_result = render_export_raster(
                &png,
                &edited,
                None,
                TargetPrimaries::Srgb,
                ExportDepth::Eight,
                None,
            )
            .unwrap();
            assert_eq!((tiff_result.0, tiff_result.1), (png_result.0, png_result.1));
            let (ExportPixels::Eight(tiff), ExportPixels::Eight(png)) =
                (tiff_result.2, png_result.2)
            else {
                panic!("wrong depth")
            };
            assert_eq!(tiff, png, "{name}: edit chain must be shared");
        }
    }
}
