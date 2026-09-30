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

fn tiff_dimensions(mut bytes: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
    assert_eq!(&bytes[..4], b"II*\0");
    let first = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[first..first + 2].try_into().unwrap()) as usize;
    let mut changed = 0;
    for i in 0..count {
        let at = first + 2 + i * 12;
        let tag = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
        let value = match tag {
            256 => width,
            257 => height,
            _ => continue,
        };
        assert_eq!(
            u16::from_le_bytes(bytes[at + 2..at + 4].try_into().unwrap()),
            4
        );
        bytes[at + 8..at + 12].copy_from_slice(&value.to_le_bytes());
        changed += 1;
    }
    assert_eq!(changed, 2);
    bytes
}

fn tiny_float_tiff() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    tiff::encoder::TiffEncoder::new(&mut bytes)
        .unwrap()
        .write_image::<tiff::encoder::colortype::RGB32Float>(4, 4, &[0.5; 48])
        .unwrap();
    bytes.into_inner()
}

#[test]
fn bitmap_pixel_ceiling_rejects_oversized_png_and_tiff_headers() {
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[128; 48], 4, 4, ExtendedColorType::Rgb8)
        .unwrap();
    png[16..20].copy_from_slice(&20_000u32.to_be_bytes());
    png[20..24].copy_from_slice(&20_000u32.to_be_bytes());
    // Keep the edited IHDR valid so it reaches the dimension guard.
    let crc = !png[12..29].iter().fold(!0u32, |crc, &b| {
        (0..8).fold(crc ^ u32::from(b), |n, _| {
            (n >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(n & 1))
        })
    });
    png[29..33].copy_from_slice(&crc.to_be_bytes());
    let tiff = tiff_dimensions(tiny_float_tiff(), 20_000, 20_000);
    for (format, bytes) in [("png", png), ("tiff", tiff)] {
        for hint in [None, Some(format)] {
            let error = decode_raster(&bytes, hint).unwrap_err();
            assert!(
                error.to_string().contains("268000000 pixel limit"),
                "{format}: {error}"
            );
        }
    }
}

#[test]
fn bitmap_byte_budget_rejects_high_depth_headers_below_the_pixel_ceiling() {
    // 256 MP is below the shared ceiling, but RGB32F needs over 3 GiB.
    // The tiny source is rejected from its headers before a pixel allocation.
    let bytes = tiff_dimensions(tiny_float_tiff(), 16_000, 16_000);
    for hint in [None, Some("tiff")] {
        let error = decode_raster(&bytes, hint).unwrap_err();
        assert!(
            error.to_string().contains("Memory limit exceeded"),
            "{error}"
        );
    }
}
