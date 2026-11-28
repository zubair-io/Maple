//! Which preview-strip layouts in a DNG SubIFD decode to the preview's pixels.

use super::*;
use crate::test_support::synth_dng_preview::{dng_with_jpeg_preview_layout, StripLayout};

const SIDE: (u32, u32) = (96, 64);

fn jpeg() -> Vec<u8> {
    let rgb = image::RgbImage::from_fn(SIDE.0, SIDE.1, |x, y| {
        image::Rgb([x as u8 * 2, y as u8 * 3, 90])
    });
    crate::jpeg::encode(SIDE.0, SIDE.1, rgb.as_raw(), 90).unwrap()
}

fn expected_pixels() -> image::RgbImage {
    image::load_from_memory_with_format(&jpeg(), image::ImageFormat::Jpeg)
        .unwrap()
        .into_rgb8()
}

fn extracted(layout: StripLayout) -> Result<(image::DynamicImage, ExifOrientation)> {
    let dng = dng_with_jpeg_preview_layout(&jpeg(), SIDE.0, SIDE.1, layout);
    extract_embedded_preview(&dng, "dng")
}

#[test]
fn the_jpeg_under_64_kb_stays_inside_a_16_bit_count() {
    assert!(jpeg().len() < u16::MAX as usize);
}

#[test]
fn a_long_strip_decodes_to_the_jpeg_pixels() {
    let (image, _) = extracted(StripLayout::Long).unwrap();
    assert_eq!(image.into_rgb8(), expected_pixels());
}

#[test]
fn a_strip_whose_offset_and_size_are_16_bit_values_decodes_to_the_jpeg_pixels() {
    let (image, _) = extracted(StripLayout::Short).unwrap();
    assert_eq!(image.into_rgb8(), expected_pixels());
}

#[test]
fn tile_tags_beside_a_single_strip_decode_to_the_jpeg_pixels() {
    let (image, _) = extracted(StripLayout::TiledWithStrayStrip).unwrap();
    assert_eq!(image.into_rgb8(), expected_pixels());
}

fn jpeg_of(width: u32, height: u32) -> Vec<u8> {
    let rgb = vec![0x80; (width * height * 3) as usize];
    crate::jpeg::encode(width, height, &rgb, 90).unwrap()
}

fn extracted_from(jpeg: &[u8], width: u32, height: u32, layout: StripLayout) -> Result<()> {
    let dng = dng_with_jpeg_preview_layout(jpeg, width, height, layout);
    extract_embedded_preview(&dng, "dng").map(|_| ())
}

#[test]
fn zero_rows_per_strip_gives_no_preview() {
    assert!(extracted(StripLayout::ZeroRowsPerStrip).is_err());
}

#[test]
fn a_preview_wider_than_the_decoder_limit_gives_no_preview() {
    let (width, height) = (16_700, 8);
    assert!(extracted_from(&jpeg_of(width, height), width, height, StripLayout::Long).is_err());
}

#[test]
fn a_preview_taller_than_the_decoder_limit_gives_no_preview() {
    let (width, height) = (8, 50_001);
    assert!(extracted_from(&jpeg_of(width, height), width, height, StripLayout::Long).is_err());
}

#[test]
fn a_preview_at_the_width_limit_still_decodes() {
    let (width, height) = (16_666, 8);
    assert!(extracted_from(&jpeg_of(width, height), width, height, StripLayout::Long).is_ok());
}
