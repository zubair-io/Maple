use super::*;
use raw_core::{
    export::ExportFormat,
    pipeline::{ExportDepth, ExportPixels},
    view::encode::TargetPrimaries,
};
use std::io::{Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::path::Path;

/// Calls through an open descriptor, as the app does, and pins that its offset is untouched.
fn through_descriptor<T>(path: &Path, call: impl FnOnce(i32) -> T) -> T {
    let mut file = std::fs::File::open(path).unwrap();
    file.seek(SeekFrom::Start(3)).unwrap();
    let result = call(file.as_raw_fd());
    assert_eq!(file.stream_position().unwrap(), 3);
    result
}

fn valid(path: &Path, edge: u32, format: &str) -> Result<bool, String> {
    through_descriptor(path, |fd| cache_valid(fd, edge, format))
}

fn png(source: &Path, destination: &Path) -> Result<(), String> {
    through_descriptor(source, |fd| cache_png(fd, destination.to_str().unwrap()))
}

#[test]
fn shared_avif_tiers_match_the_api_parameters_and_reject_invalid_artifacts() {
    let folder = std::env::temp_dir().join(format!("maple-shared-cache-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let source = folder.join("source.png");
    let image = image::RgbImage::from_fn(1400, 100, |x, y| {
        image::Rgb([(x % 256) as u8, (y * 2) as u8, 90])
    });
    image.save(&source).unwrap();
    let original = std::fs::read(&source).unwrap();
    let api = include_str!("../../../api/src/thumbs/render.ts");
    assert!(api.contains("export const THUMB_LONG_EDGE_PX = 512;"));
    assert!(api.contains("export const THUMB_AVIF_QUALITY = 55;"));
    let preview_api = include_str!("../../../api/src/indexer/previewer.ts");
    assert!(preview_api.contains("export const PREVIEW_LONG_EDGE_PX = 1280;"));
    assert!(preview_api.contains("PREVIEW_LONG_EDGE_PX,\n    70,"));
    for (preview, edge, quality) in [(false, 512, 55), (true, 1280, 70)] {
        let destination = folder.join(format!("{edge}.avif"));
        shared_derivative(
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            "",
            preview,
        )
        .unwrap();
        assert!(valid(&destination, edge, "avif").unwrap());
        assert!(!valid(&destination, edge - 1, "avif").unwrap());
        assert!(!valid(&destination, edge, "jpeg").unwrap());
        let (w, h, pixels) = raw_core::pipeline::render_export_raster(
            &original,
            &Default::default(),
            Some(edge),
            TargetPrimaries::Srgb,
            ExportDepth::Eight,
            None,
        )
        .unwrap();
        assert_eq!(w.max(h), edge);
        let ExportPixels::Eight(rgb) = pixels else {
            panic!("RGB8 output required")
        };
        let expected = raw_core::export::encode_raster(
            &raw_core::raster::RasterImage::new_rgb(w, h, rgb),
            ExportFormat::Avif,
            quality,
        )
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), expected);
        std::fs::write(&destination, &expected[..expected.len() / 2]).unwrap();
        assert!(!valid(&destination, edge, "avif").unwrap_or(false));
    }
    assert_eq!(original, std::fs::read(source).unwrap());
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn transparent_rasters_cannot_publish_opaque_shared_derivatives() {
    let folder = std::env::temp_dir().join(format!("maple-cache-alpha-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let image = image::RgbaImage::from_fn(4, 2, |x, _| {
        image::Rgba([80, 140, 200, [0, 64, 128, 255][x as usize]])
    });
    let edited = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.5" /></rdf:RDF></x:xmpmeta>"#;
    for (extension, format) in [
        ("png", image::ImageFormat::Png),
        ("webp", image::ImageFormat::WebP),
        ("tiff", image::ImageFormat::Tiff),
    ] {
        let source = folder.join(format!("transparent.{extension}"));
        image.save_with_format(&source, format).unwrap();
        let original = std::fs::read(&source).unwrap();
        let decoded = raw_core::raster::decode_raster(&original, Some(extension)).unwrap();
        assert!(!decoded.is_opaque(), "{extension} fixture lost its alpha");
        for (label, xml) in [("original", ""), ("edited", edited)] {
            for preview in [false, true] {
                let destination = folder.join(format!("{extension}-{label}-{preview}.avif"));
                // The editor core rejects transparency before rendering. Keep that
                // error intact: no alpha-stripped file may reach the shared tier.
                let error = shared_derivative(
                    source.to_str().unwrap(),
                    destination.to_str().unwrap(),
                    xml,
                    preview,
                )
                .unwrap_err();
                assert!(error.contains("transparency"), "{extension}: {error}");
                assert!(!destination.exists());
            }
        }
        assert_eq!(original, std::fs::read(&source).unwrap());
    }
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn legacy_avif_display_bridge_preserves_decoded_pixels_and_rejects_oversize() {
    use raw_core::raster_encode::{encode_raster_opts, RasterEncodeOptions};
    let folder = std::env::temp_dir().join(format!("maple-cache-png-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let source = folder.join("shared.avif");
    let destination = folder.join("display.png");
    let rgba = raw_core::raster::RasterImage::new_rgba(
        4,
        2,
        (0..8).flat_map(|i| [80, 140, 200, i * 32]).collect(),
    );
    for primaries in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
        let original = encode_raster_opts(
            &rgba,
            &RasterEncodeOptions {
                format: ExportFormat::Avif,
                quality: 70,
                avif_speed: 10,
                primaries,
            },
        )
        .unwrap();
        std::fs::write(&source, &original).unwrap();
        png(&source, &destination).unwrap();
        let expected = raw_core::raster::decode_raster(&original, Some("avif")).unwrap();
        let png = std::fs::read(&destination).unwrap();
        let decoded = raw_core::raster::decode_raster(&png, Some("png")).unwrap();
        assert_eq!(
            (decoded.width, decoded.height),
            (expected.width, expected.height)
        );
        assert_eq!(decoded.channels, 4);
        assert_eq!(decoded.data, expected.data);
        assert!(!decoded.is_opaque());
        assert_eq!(original, std::fs::read(&source).unwrap());
        std::fs::remove_file(&destination).unwrap();
    }
    let oversized =
        raw_core::export::encode_avif_with_speed(1281, 1, &vec![80; 1281 * 3], 55, 10).unwrap();
    std::fs::write(&source, oversized).unwrap();
    assert!(png(&source, &destination).is_err());
    assert!(!destination.exists());
    std::fs::write(&source, b"corrupt").unwrap();
    assert!(png(&source, &destination).is_err());
    assert!(!destination.exists());
    std::fs::remove_dir_all(folder).unwrap();
}
