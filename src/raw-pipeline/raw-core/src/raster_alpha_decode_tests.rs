//! #3574: grayscale and high-depth alpha must survive the RGB expansion.
use super::*;
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

fn png(data: &[u8], color: ExtendedColorType) -> Vec<u8> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(data, 2, 2, color)
        .unwrap();
    bytes
}

fn grey_alpha() -> Vec<u8> {
    png(&[32, 0, 64, 85, 128, 170, 255, 255], ExtendedColorType::La8)
}

#[test]
fn grey_alpha_png_expands_to_rgba_and_stats_agree_with_metadata() {
    let bytes = grey_alpha();
    let meta = probe_raster_metadata(&bytes).unwrap();
    assert_eq!((meta.channels, meta.has_alpha), (2, true));
    let decoded = decode_raster(&bytes, None).unwrap();
    assert_eq!((decoded.width, decoded.height, decoded.channels), (2, 2, 4));
    assert_eq!(
        decoded.data,
        [32, 32, 32, 0, 64, 64, 64, 85, 128, 128, 128, 170, 255, 255, 255, 255]
    );
    assert!(!decoded.is_opaque());
    let analysis: serde_json::Value = serde_json::from_str(
        &crate::raster_analyze::analyze(&bytes, r#"{"v":1,"what":["metadata","stats"]}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(analysis["metadata"]["hasAlpha"], true);
    assert_eq!(analysis["stats"]["isOpaque"], false);
    assert_eq!(analysis["stats"]["channels"].as_array().unwrap().len(), 4);
}

#[test]
fn high_depth_alpha_survives_conversion_to_eight_bits() {
    for (color, data) in [
        (
            ExtendedColorType::La16,
            vec![
                32_u16 * 257,
                0,
                64 * 257,
                85 * 257,
                128 * 257,
                170 * 257,
                65535,
                65535,
            ],
        ),
        (
            ExtendedColorType::Rgba16,
            vec![
                32_u16 * 257,
                32 * 257,
                32 * 257,
                0,
                64 * 257,
                64 * 257,
                64 * 257,
                85 * 257,
                128 * 257,
                128 * 257,
                128 * 257,
                170 * 257,
                65535,
                65535,
                65535,
                65535,
            ],
        ),
    ] {
        let native = data
            .into_iter()
            .flat_map(u16::to_ne_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_raster(&png(&native, color), Some("png")).unwrap();
        assert_eq!(decoded.channels, 4);
        assert_eq!(
            decoded.data,
            [32, 32, 32, 0, 64, 64, 64, 85, 128, 128, 128, 170, 255, 255, 255, 255]
        );
    }
    let grey = decode_raster(&png(&[32, 64, 128, 255], ExtendedColorType::L8), None).unwrap();
    assert_eq!(grey.channels, 3);
    assert!(grey.is_opaque());
}

#[test]
fn grey_alpha_resize_and_png_export_retain_transparency() {
    use crate::raster_recipe::parse_recipe;
    use crate::raster_recipe_exec::run_recipe;
    let recipe = parse_recipe(r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","width":4,"height":4,"fit":"fill","kernel":"nearest","withoutEnlargement":false}],"output":{"format":"png"}}"#).unwrap();
    let result = run_recipe(&recipe, &grey_alpha(), &[]).unwrap();
    let decoded = decode_raster(&result.bytes, None).unwrap();
    assert_eq!((decoded.width, decoded.height, decoded.channels), (4, 4, 4));
    assert_eq!(result.channels, 4);
    // Nearest expansion preserves each source alpha in its 2x2 block.
    for y in 0..4 {
        for x in 0..4 {
            assert_eq!(
                decoded.data[(y * 4 + x) * 4 + 3],
                [0, 85, 170, 255][(y / 2) * 2 + x / 2]
            );
        }
    }
}
