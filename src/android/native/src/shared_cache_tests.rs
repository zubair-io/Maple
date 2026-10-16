use super::*;
use raw_core::{
    export::ExportFormat,
    pipeline::{ExportDepth, ExportPixels},
    view::encode::TargetPrimaries,
};

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
        assert!(cache_valid(destination.to_str().unwrap(), edge, "avif").unwrap());
        assert!(!cache_valid(destination.to_str().unwrap(), edge - 1, "avif").unwrap());
        assert!(!cache_valid(destination.to_str().unwrap(), edge, "jpeg").unwrap());
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
        assert!(!cache_valid(destination.to_str().unwrap(), edge, "avif").unwrap_or(false));
    }
    assert_eq!(original, std::fs::read(source).unwrap());
    std::fs::remove_dir_all(folder).unwrap();
}
