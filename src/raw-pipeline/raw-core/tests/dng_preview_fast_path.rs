//! The DNG preview fast path in the vendored rawler (`single_strip_rgb8_jpeg`)
//! takes only the shape the generic decoder reads the same way.

use image::{DynamicImage, ImageFormat};
use rawler::decoders::single_strip_rgb8_jpeg;
use rawler::formats::tiff::{ifd::IFD, writer::TiffWriter};
use rawler::rawsource::RawSource;
use rawler::tags::TiffCommonTag;
use std::io::Cursor;

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    LongStrip,
    ShortByteCount,
    TwoStrips,
    TiledWithStrayStrip,
}

const SIDE: (u32, u32) = (16, 8);

fn jpeg() -> Vec<u8> {
    let rgb = image::RgbImage::from_fn(SIDE.0, SIDE.1, |x, y| {
        image::Rgb([x as u8 * 12, y as u8 * 25, 90])
    });
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&rgb)
        .unwrap();
    out
}

fn preview_ifd(shape: Shape) -> (IFD, Vec<u8>) {
    let data = jpeg();
    let mut buf = Cursor::new(Vec::new());
    let mut tiff = TiffWriter::new(&mut buf).unwrap();
    let at = tiff.write_data(&data).unwrap();
    let mut dir = tiff.new_directory();
    dir.add_tag(TiffCommonTag::ImageWidth, SIDE.0);
    dir.add_tag(TiffCommonTag::ImageLength, SIDE.1);
    dir.add_tag(TiffCommonTag::SamplesPerPixel, 3_u16);
    dir.add_tag(TiffCommonTag::BitsPerSample, [8_u16, 8, 8]);
    dir.add_tag(TiffCommonTag::Compression, 7_u16);
    dir.add_tag(TiffCommonTag::PhotometricInt, 6_u16);
    let len = data.len() as u32;
    match shape {
        Shape::LongStrip => {
            dir.add_tag(TiffCommonTag::StripOffsets, [at]);
            dir.add_tag(TiffCommonTag::StripByteCounts, [len]);
        }
        Shape::ShortByteCount => {
            dir.add_tag(TiffCommonTag::StripOffsets, [at]);
            dir.add_tag(TiffCommonTag::StripByteCounts, [len as u16]);
        }
        Shape::TwoStrips => {
            let half = len / 2;
            dir.add_tag(TiffCommonTag::StripOffsets, [at, at + half]);
            dir.add_tag(TiffCommonTag::StripByteCounts, [half, len - half]);
        }
        Shape::TiledWithStrayStrip => {
            dir.add_tag(TiffCommonTag::StripOffsets, [at]);
            dir.add_tag(TiffCommonTag::StripByteCounts, [len]);
            dir.add_tag(TiffCommonTag::TileWidth, SIDE.0);
            dir.add_tag(TiffCommonTag::TileLength, SIDE.1);
            dir.add_tag(TiffCommonTag::TileOffsets, [at]);
            dir.add_tag(TiffCommonTag::TileByteCounts, [len]);
        }
    }
    tiff.build(dir).unwrap();
    let bytes = buf.into_inner();
    let ifd = IFD::new_root(&mut Cursor::new(&bytes), 0).unwrap();
    (ifd, bytes)
}

fn fast_path(shape: Shape) -> Option<DynamicImage> {
    let (ifd, bytes) = preview_ifd(shape);
    let source = RawSource::new_from_slice(&bytes);
    single_strip_rgb8_jpeg(&ifd, &source)
}

#[test]
fn a_long_single_strip_jpeg_takes_the_fast_path() {
    let decoded = fast_path(Shape::LongStrip).expect("fast path taken");
    let expected = image::load_from_memory_with_format(&jpeg(), ImageFormat::Jpeg).unwrap();
    assert_eq!(decoded.into_rgb8(), expected.into_rgb8());
}

#[test]
fn shapes_the_generic_path_handles_differently_fall_through() {
    for shape in [
        Shape::ShortByteCount,
        Shape::TwoStrips,
        Shape::TiledWithStrayStrip,
    ] {
        assert!(fast_path(shape).is_none());
    }
}
