//! #3516: real RGB16 inputs beyond image's default 512 MiB allocation ceiling.
//! The two formats run serially in one test to bound peak memory (~1.6 GiB).

use super::decode_raster;
use image::{ExtendedColorType, ImageEncoder, ImageReader};
use std::io::Cursor;

const WIDTH: u32 = 8192;
const HEIGHT: u32 = 10923;
const SAMPLES: usize = WIDTH as usize * HEIGHT as usize * 3;

fn large_png() -> Vec<u8> {
    let samples = vec![0x8080u16; SAMPLES];
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut bytes,
        image::codecs::png::CompressionType::Level(1),
        image::codecs::png::FilterType::NoFilter,
    )
    .write_image(
        bytemuck::cast_slice(&samples),
        WIDTH,
        HEIGHT,
        ExtendedColorType::Rgb16,
    )
    .unwrap();
    bytes
}

fn large_tiff() -> Vec<u8> {
    let samples = vec![0x8080u16; SAMPLES];
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut encoder = tiff::encoder::TiffEncoder::new(&mut bytes)
            .unwrap()
            .with_compression(tiff::encoder::Compression::Deflate(
                tiff::encoder::DeflateLevel::Fast,
            ));
        let mut image = encoder
            .new_image::<tiff::encoder::colortype::RGB16>(WIDTH, HEIGHT)
            .unwrap();
        // One large strip also exercises the TIFF decoder's own buffer limits.
        image.rows_per_strip(HEIGHT).unwrap();
        image.write_data(&samples).unwrap();
    }
    bytes.into_inner()
}

#[test]
fn large_png_and_tiff_decode_above_default_allocation_ceiling() {
    assert!(SAMPLES * 2 > 512 * 1024 * 1024);
    for (format, encode) in [
        ("png", large_png as fn() -> Vec<u8>),
        ("tiff", large_tiff as fn() -> Vec<u8>),
    ] {
        let bytes = encode();
        assert!(bytes.len() < 16 * 1024 * 1024, "small synthetic {format}");
        let default_result = ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .unwrap()
            .decode();
        assert!(
            matches!(default_result, Err(image::ImageError::Limits(_))),
            "{format} must actually exceed the upstream default limit"
        );
        for hint in [None, Some(format)] {
            let raster = decode_raster(&bytes, hint).unwrap();
            assert_eq!(
                (raster.width, raster.height, raster.channels),
                (WIDTH, HEIGHT, 3)
            );
            assert_eq!(raster.data.len(), SAMPLES);
            assert!(
                raster.data.iter().all(|&value| value == 128),
                "{format} pixels"
            );
        }
    }
}
