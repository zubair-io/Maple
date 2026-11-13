//! Real export containers, profile tags and native-depth precision (#5192).
use super::transfer::export_configured;
use std::io::Cursor;

#[test]
fn configured_exports_use_core_containers_profiles_and_16_bit_tiff() {
    let root = std::env::temp_dir().join(format!(
        "maple-export-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    std::fs::create_dir(&root).unwrap();
    let source = root.join("input.png");
    let raster = image::RgbImage::from_fn(64, 32, |x, y| {
        image::Rgb([(x * 4) as u8, (y * 8) as u8, ((x + y) * 2) as u8])
    });
    raster.save(&source).unwrap();
    let original = std::fs::read(&source).unwrap();
    for format in ["jpeg", "png", "tiff", "avif", "webp"] {
        for p3 in [false, true] {
            let destination = root.join(format!("{format}-{p3}.out"));
            export_configured(
                source.to_str().unwrap(),
                "",
                destination.to_str().unwrap(),
                format,
                75,
                32,
                p3,
            )
            .unwrap();
            let bytes = std::fs::read(&destination).unwrap();
            let metadata =
                raw_core::raster::probe_raster_metadata_reader(&mut Cursor::new(&bytes)).unwrap();
            assert_eq!((metadata.width, metadata.height), (32, 16), "{format}");
            // sRGB AVIF/WebP retain their established implicit sRGB encoding.
            // Wide-gamut files and other containers carry explicit ICC profiles.
            if p3 || !matches!(format, "avif" | "webp") {
                let profile = raw_core::raster_meta::read_sidecars(&bytes)
                    .icc
                    .unwrap_or_else(|| panic!("missing ICC in {format} p3={p3}"));
                assert_eq!(
                    profile,
                    if p3 {
                        include_bytes!(
                            "../../../../test-fixtures/export-recipes/maple-display-p3-v2.icc"
                        )
                        .as_slice()
                    } else {
                        include_bytes!("../../../../test-fixtures/export-recipes/maple-srgb-v2.icc")
                            .as_slice()
                    },
                    "{format}"
                );
            }
            if format == "tiff" {
                let mut decoder = tiff::decoder::Decoder::new(Cursor::new(&bytes)).unwrap();
                assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGB(16));
                let tiff::decoder::DecodingResult::U16(samples) = decoder.read_image().unwrap()
                else {
                    panic!("TIFF must contain 16-bit pixels");
                };
                assert!(
                    samples.iter().any(|value| value % 257 != 0),
                    "TIFF must retain precision beyond 8 bits"
                );
            }
            assert!(export_configured(
                source.to_str().unwrap(),
                "",
                destination.to_str().unwrap(),
                format,
                75,
                32,
                p3
            )
            .is_err());
            assert_eq!(bytes, std::fs::read(&destination).unwrap());
        }
    }
    assert_eq!(original, std::fs::read(&source).unwrap());
    std::fs::remove_dir_all(root).unwrap();
}
