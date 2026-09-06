use super::*;
use crate::{decode::decode_bytes, image::CfaPattern, test_support::synth_perf::SyntheticPerfDng};
use image::ImageDecoder;
use std::io::Cursor;

fn fixture() -> Vec<u8> {
    SyntheticPerfDng {
        width: 64,
        height: 48,
        cfa: CfaPattern::Rggb,
    }
    .write_to_bytes()
}

#[test]
fn recipes_render_real_raw_pixels_with_exact_profile_and_without_source_metadata() {
    let bytes = fixture();
    let original = bytes.clone();
    let raw = decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel {
        exposure: 0.7,
        contrast: 12.0,
        ..Default::default()
    };
    for (format, depth, _) in ENCODERS {
        for profile in OUTPUT_PROFILES {
            let recipe = ExportRecipe {
                format: (*format).into(),
                bit_depth: *depth,
                quality: if *format == "jpeg" { Some(92) } else { None },
                output_profile: (*profile).into(),
                ..Default::default()
            };
            let output = export_with_recipe(
                &raw,
                &model,
                Some(RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                }),
                &recipe,
                None,
            )
            .unwrap();
            let mut decoder = image::ImageReader::new(Cursor::new(&output.bytes))
                .with_guessed_format()
                .unwrap()
                .into_decoder()
                .unwrap();
            assert_eq!(decoder.dimensions(), (64, 48));
            // image's TIFF decoder returns None for this encoder's BYTE-typed ICC
            // field. Inspect the actual IFD payload; Pillow also reads this tag.
            let icc = if *format == "tiff" {
                tiff_icc(&output.bytes)
            } else {
                decoder.icc_profile().unwrap().unwrap()
            };
            assert_eq!(
                icc,
                crate::icc::profile_for(recipe.options().unwrap().target)
            );
            assert!(
                decoder.exif_metadata().unwrap().is_none(),
                "source EXIF must be stripped"
            );
            assert_eq!(decoder.color_type().bits_per_pixel(), (*depth * 3) as u16);
        }
    }
    assert_eq!(bytes, original, "rendering must not change source bytes");
}

fn tiff_icc(bytes: &[u8]) -> Vec<u8> {
    let le = &bytes[..2] == b"II";
    let u16_at = |at| {
        let b = bytes[at..at + 2].try_into().unwrap();
        if le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        }
    };
    let u32_at = |at| {
        let b = bytes[at..at + 4].try_into().unwrap();
        if le {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        }
    };
    let ifd = u32_at(4) as usize;
    let entries: Vec<_> = (0..u16_at(ifd) as usize)
        .map(|i| ifd + 2 + i * 12)
        .collect();
    for entry in &entries {
        assert!(
            ![34665, 34853, 700].contains(&u16_at(*entry)),
            "source metadata in export"
        );
    }
    let entry = entries
        .into_iter()
        .find(|at| u16_at(*at) == 34675)
        .expect("ICC IFD tag");
    assert_eq!(u16_at(entry + 2), 1, "ICC bytes");
    let count = u32_at(entry + 4) as usize;
    let offset = u32_at(entry + 8) as usize;
    bytes[offset..offset + count].to_vec()
}

#[test]
fn lossless_recipe_matches_display_pixels_and_size_cap_never_upscales() {
    let bytes = fixture();
    let raw = decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel {
        exposure: 0.8,
        contrast: -9.0,
        ..Default::default()
    };
    let source = || {
        Some(RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        })
    };
    let (width, height, expected) = crate::pipeline::render_from_raw_with_quality_and_source(
        &raw,
        &model,
        crate::pipeline::RenderQuality::Amaze,
        source(),
    )
    .unwrap();
    let mut recipe = ExportRecipe {
        format: "png".into(),
        quality: None,
        ..Default::default()
    };
    let full = export_with_recipe(&raw, &model, source(), &recipe, None).unwrap();
    assert_eq!((full.width, full.height), (width, height));
    assert_eq!(
        image::load_from_memory(&full.bytes)
            .unwrap()
            .to_rgb8()
            .as_raw(),
        &expected
    );
    recipe.max_long_edge = Some(1000);
    let large = export_with_recipe(&raw, &model, source(), &recipe, None).unwrap();
    assert_eq!(large.bytes, full.bytes);
    recipe.max_long_edge = Some(32);
    let small = export_with_recipe(&raw, &model, source(), &recipe, None).unwrap();
    assert_eq!(small.width.max(small.height), 32);
}

#[test]
fn unresolved_film_is_an_error_instead_of_an_unrequested_different_render() {
    let bytes = fixture();
    let raw = decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel {
        film_look: "missing-film".into(),
        ..Default::default()
    };
    assert!(
        export_with_recipe(&raw, &model, None, &ExportRecipe::default(), None)
            .err()
            .unwrap()
            .contains("film LUT unavailable")
    );
}
