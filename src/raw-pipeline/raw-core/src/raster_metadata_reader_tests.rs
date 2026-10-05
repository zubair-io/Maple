//! Byte/file parity and actual bytes-read budgets for #3620. Real encoder
//! fixtures carry metadata; counted File reads include BufReader read-ahead.

use crate::raster::{probe_raster_metadata, probe_raster_metadata_reader, RasterImage};
use crate::raster_analyze::{analyze, analyze_reader};
use crate::raster_encode::RasterOutput;
use crate::raster_meta::{read_sidecars, read_sidecars_reader, set_exif_orientation};
use crate::raster_recipe_meta::ResolvedMetadata;
use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write};
const METADATA: &str = r#"{"v":1,"what":["metadata"]}"#;
const XMP: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/">seekable</x:xmpmeta>"#;

pub(super) struct TestFile(tempfile::NamedTempFile);

impl TestFile {
    pub(super) fn new(bytes: &[u8]) -> Self {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        Self(file)
    }

    pub(super) fn open(&self) -> File {
        self.0.reopen().unwrap()
    }
}

pub(super) struct Counted<R> {
    inner: R,
    pub(super) bytes_read: usize,
}

impl<R> Counted<R> {
    pub(super) fn new(inner: R) -> Self {
        Self {
            inner,
            bytes_read: 0,
        }
    }
}

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(out)?;
        self.bytes_read += count;
        Ok(count)
    }
}
impl<R: Seek> Seek for Counted<R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.inner.seek(from)
    }
}

pub(super) fn fixtures() -> Vec<(&'static str, Vec<u8>)> {
    let pixels = RasterImage::new_rgba(
        8,
        6,
        (0..48).flat_map(|i| [i * 3, 100, 200, i * 5]).collect(),
    );
    let metadata = ResolvedMetadata {
        icc: Some(crate::icc::profile_for(
            crate::view::encode::TargetPrimaries::P3,
        )),
        exif: Some(set_exif_orientation(&[], 6)),
        xmp: Some(XMP.to_vec()),
        density: None,
        orientation: Some(6),
        ..Default::default()
    };
    let outputs = [
        ("jpeg", RasterOutput::Jpeg(Default::default())),
        ("png", RasterOutput::Png(Default::default())),
        ("tiff", RasterOutput::Tiff(Default::default())),
    ];
    let mut fixtures: Vec<_> = outputs
        .into_iter()
        .map(|(name, output)| {
            let bytes = crate::raster_recipe_encode::encode_raster_output(
                &pixels,
                &output,
                &metadata,
                crate::view::encode::TargetPrimaries::Srgb,
            )
            .unwrap();
            (
                name,
                if name == "tiff" {
                    relocate_tiff(&bytes, bytes.len() + 64, false)
                } else {
                    bytes
                },
            )
        })
        .collect();
    let tiff = &fixtures.iter().find(|(name, _)| *name == "tiff").unwrap().1;
    fixtures.push(("dng", relocate_tiff(tiff, tiff.len() + 64, true)));
    #[cfg(feature = "avif")]
    {
        let rgb = vec![100u8; 8 * 6 * 3];
        let base = crate::avif::encode_with_speed(8, 6, &rgb, 50, 10).unwrap();
        let bytes = crate::avif_boxes::encoder_tests::mux_avif(
            &base,
            Some(3),
            None,
            metadata.exif.as_deref(),
            Some(XMP),
        );
        fixtures.push(("avif", bytes));
    }
    {
        use image::ImageEncoder;
        let mut base = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut base)
            .write_image(&pixels.data, 8, 6, image::ExtendedColorType::Rgba8)
            .unwrap();
        let riff = |kind: &[u8; 4], payload: &[u8]| {
            let mut chunk = [
                kind.as_slice(),
                &(payload.len() as u32).to_le_bytes(),
                payload,
            ]
            .concat();
            if payload.len() % 2 == 1 {
                chunk.push(0);
            }
            chunk
        };
        let exif = [b"Exif\0\0".as_slice(), metadata.exif.as_deref().unwrap()].concat();
        let mut bytes = base[..12].to_vec();
        bytes.extend(riff(b"VP8X", &[0x3c, 0, 0, 0, 7, 0, 0, 5, 0, 0]));
        bytes.extend(riff(b"ICCP", metadata.icc.as_deref().unwrap()));
        bytes.extend_from_slice(&base[12..]);
        bytes.extend(riff(b"EXIF", &exif));
        bytes.extend(riff(b"XMP ", XMP));
        let length = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        fixtures.push(("webp", bytes));
    }
    fixtures
}

/// Place a TIFF's entire IFD and ICC/XMP values at an arbitrary file offset.
/// Pixel/strip offsets stay absolute. DNG adds its real DNGVersion tag.
pub(super) fn relocate_tiff(bytes: &[u8], offset: usize, dng: bool) -> Vec<u8> {
    let u16_at = |at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
    let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    assert_eq!(&bytes[..4], b"II*\0");
    let old = u32_at(4) as usize;
    let count = u16_at(old) as usize;
    let mut entries: Vec<_> = (0..count)
        .map(|i| bytes[old + 2 + i * 12..old + 14 + i * 12].to_vec())
        .collect();
    if !entries
        .iter()
        .any(|e| u16::from_le_bytes(e[..2].try_into().unwrap()) == 700)
    {
        entries.push(
            [
                700u16.to_le_bytes().as_slice(),
                &7u16.to_le_bytes(),
                &(XMP.len() as u32).to_le_bytes(),
                &[0; 4],
            ]
            .concat(),
        );
    }
    if dng {
        entries.push(
            [
                50706u16.to_le_bytes().as_slice(),
                &1u16.to_le_bytes(),
                &4u32.to_le_bytes(),
                &[1, 4, 0, 0],
            ]
            .concat(),
        );
    }
    entries.sort_by_key(|entry| u16::from_le_bytes(entry[..2].try_into().unwrap()));
    let data_start = offset + 2 + entries.len() * 12 + 4;
    let mut blobs = Vec::new();
    for entry in &mut entries {
        let tag = u16::from_le_bytes(entry[..2].try_into().unwrap());
        let count = u32::from_le_bytes(entry[4..8].try_into().unwrap()) as usize;
        if matches!(tag, 34675 | 700) && count > 4 {
            let old_value = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            entry[8..12].copy_from_slice(&((data_start + blobs.len()) as u32).to_le_bytes());
            let data = if tag == 700 && old_value == 0 {
                XMP
            } else {
                &bytes[old_value..old_value + count]
            };
            blobs.extend_from_slice(data);
        }
    }
    let mut out = bytes.to_vec();
    out.resize(offset, 0);
    out[4..8].copy_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend(entries.into_iter().flatten());
    out.extend_from_slice(&[0; 4]);
    out.extend(blobs);
    out
}

pub(super) fn assert_parity(bytes: &[u8], name: &str) {
    let expected = crate::raster::legacy_probe(bytes).map_err(|e| e.to_string());
    assert_eq!(
        probe_raster_metadata(bytes).map_err(|e| e.to_string()),
        expected,
        "{name}: byte probe against legacy"
    );
    assert_eq!(
        probe_raster_metadata_reader(&mut Cursor::new(bytes)).map_err(|e| e.to_string()),
        expected,
        "{name}: probe"
    );
    assert_eq!(
        read_sidecars_reader(&mut Cursor::new(bytes)).unwrap(),
        read_sidecars(bytes),
        "{name}: blocks"
    );
    assert_eq!(
        analyze_reader(&mut Cursor::new(bytes), METADATA).map_err(|e| e.to_string()),
        analyze(bytes, METADATA).map_err(|e| e.to_string()),
        "{name}: JSON"
    );
}

#[test]
fn metadata_reader_matches_bytes_and_real_files_for_every_container() {
    for (name, bytes) in fixtures() {
        assert_eq!(probe_raster_metadata(&bytes).unwrap().format, name);
        let sidecars = read_sidecars(&bytes);
        assert_eq!(sidecars.xmp.as_deref(), Some(XMP), "{name}");
        if !matches!(name, "avif") {
            assert!(sidecars.icc.is_some(), "{name}");
        }
        if !matches!(name, "tiff" | "dng") {
            assert!(sidecars.exif.is_some(), "{name}");
        }
        assert_parity(&bytes, name);
        let file = TestFile::new(&bytes);
        let mut reader = BufReader::new(file.open());
        // Also prove that callers don't need to rewind between APIs.
        reader.seek(SeekFrom::End(0)).unwrap();
        assert_eq!(
            probe_raster_metadata_reader(&mut reader).unwrap(),
            probe_raster_metadata(&bytes).unwrap(),
            "{name}"
        );
        assert_eq!(
            read_sidecars_reader(&mut reader).unwrap(),
            sidecars,
            "{name}"
        );
        assert_eq!(
            analyze_reader(&mut reader, METADATA).unwrap(),
            analyze(&bytes, METADATA).unwrap(),
            "{name}"
        );
        assert_eq!(std::fs::read(file.0.path()).unwrap(), bytes);
    }
}

#[test]
fn metadata_reader_preserves_truncation_and_corrupt_input_behavior() {
    for (name, bytes) in fixtures() {
        for cut in 0..bytes.len() {
            assert_parity(&bytes[..cut], &format!("{name}@{cut}"));
        }
        for at in (0..bytes.len()).step_by(17) {
            let mut corrupt = bytes.clone();
            corrupt[at] ^= 0xff;
            assert_parity(&corrupt, &format!("{name} corruption@{at}"));
        }
    }
    for bytes in [
        b"".as_slice(),
        b"not an image",
        &[0xff; 64],
        b"II*\0\xff\xff\xff\xff",
    ] {
        assert_parity(bytes, "garbage");
    }
}

#[test]
fn metadata_reader_finds_tiff_and_dng_metadata_at_end_without_reading_pixels() {
    let fixture = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "tiff")
        .unwrap()
        .1;
    for dng in [false, true] {
        let bytes = relocate_tiff(&fixture, 8 * 1024 * 1024, dng);
        let file = TestFile::new(&bytes);
        let mut reader = BufReader::new(Counted::new(file.open()));
        assert_eq!(
            analyze_reader(&mut reader, METADATA).unwrap(),
            analyze(&bytes, METADATA).unwrap()
        );
        let count = reader.get_ref().bytes_read;
        assert!(count < 256 * 1024, "read {count} of {} bytes", bytes.len());
    }
}

#[test]
fn metadata_reader_skips_large_jpeg_png_and_webp_payloads() {
    const PADDING: usize = 2 * 1024 * 1024;
    for (name, original) in fixtures()
        .into_iter()
        .filter(|(name, _)| matches!(*name, "jpeg" | "png" | "webp"))
    {
        let bytes = match name {
            "jpeg" => {
                let end = original.len() - 2;
                [
                    original[..end].to_vec(),
                    vec![0; PADDING],
                    original[end..].to_vec(),
                ]
                .concat()
            }
            "png" => {
                let at = original.windows(4).position(|w| w == b"IDAT").unwrap() - 4;
                let length = u32::from_be_bytes(original[at..at + 4].try_into().unwrap()) as usize;
                let end = at + 8 + length;
                let mut bytes = [
                    original[..end].to_vec(),
                    vec![0; PADDING],
                    original[end..].to_vec(),
                ]
                .concat();
                bytes[at..at + 4].copy_from_slice(&((length + PADDING) as u32).to_be_bytes());
                bytes
            }
            "webp" => {
                let mut at = 12;
                while !matches!(&original[at..at + 4], b"VP8L" | b"VP8 ") {
                    let length =
                        u32::from_le_bytes(original[at + 4..at + 8].try_into().unwrap()) as usize;
                    at += 8 + length + (length & 1);
                }
                let length =
                    u32::from_le_bytes(original[at + 4..at + 8].try_into().unwrap()) as usize;
                let end = at + 8 + length;
                let mut bytes = [
                    original[..end].to_vec(),
                    vec![0; PADDING],
                    original[end..].to_vec(),
                ]
                .concat();
                bytes[at + 4..at + 8].copy_from_slice(&((length + PADDING) as u32).to_le_bytes());
                let riff_size = (bytes.len() - 8) as u32;
                bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
                bytes
            }
            _ => unreachable!(),
        };
        let file = TestFile::new(&bytes);
        let mut reader = BufReader::new(Counted::new(file.open()));
        assert_eq!(
            analyze_reader(&mut reader, METADATA).unwrap(),
            analyze(&bytes, METADATA).unwrap(),
            "{name}"
        );
        let count = reader.get_ref().bytes_read;
        assert!(
            count < 256 * 1024,
            "{name}: read {count} of {} bytes",
            bytes.len()
        );
    }
}

#[test]
fn metadata_reader_stats_still_decode_and_requests_keep_the_v1_contract() {
    let bytes = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "png")
        .unwrap()
        .1;
    for request in [
        r#"{"v":1,"what":["stats"]}"#,
        r#"{"v":1,"what":["stats","metadata"]}"#,
        r#"{"v":1,"what":["metadata","stats"]}"#,
        r#"{"v":1,"what":[]}"#,
        r#"{"v":2,"what":[]}"#,
        r#"{"v":1,"what":["bad"]}"#,
        "{}",
        "broken",
    ] {
        assert_eq!(
            analyze_reader(&mut Cursor::new(&bytes), request).map_err(|e| e.to_string()),
            analyze(&bytes, request).map_err(|e| e.to_string()),
            "{request}"
        );
    }
}

#[test]
fn metadata_reader_reports_actual_io_failures() {
    struct Fails(Cursor<Vec<u8>>);
    impl Read for Fails {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("read failed"))
        }
    }
    impl Seek for Fails {
        fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
            self.0.seek(from)
        }
    }
    let mut reader = BufReader::new(Fails(Cursor::new(vec![0; 32])));
    assert!(read_sidecars_reader(&mut reader)
        .unwrap_err()
        .to_string()
        .contains("read failed"));
    assert!(probe_raster_metadata_reader(&mut reader)
        .unwrap_err()
        .to_string()
        .contains("read failed"));
    struct FailsLater(Cursor<Vec<u8>>);
    impl Read for FailsLater {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.0.position() >= 32 {
                return Err(io::Error::other("later read failed"));
            }
            let count = out.len().min(32 - self.0.position() as usize);
            self.0.read(&mut out[..count])
        }
    }
    impl Seek for FailsLater {
        fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
            self.0.seek(from)
        }
    }
    for (name, bytes) in fixtures()
        .into_iter()
        .filter(|(name, _)| matches!(*name, "jpeg" | "png"))
    {
        let mut reader = BufReader::with_capacity(16, FailsLater(Cursor::new(bytes)));
        assert!(
            probe_raster_metadata_reader(&mut reader)
                .unwrap_err()
                .to_string()
                .contains("later read failed"),
            "{name}"
        );
    }
}

#[test]
fn metadata_reader_preserves_greyscale_alpha_and_sample_depth() {
    for (color, channels, depth) in [
        (png::ColorType::Grayscale, 1, png::BitDepth::Eight),
        (png::ColorType::GrayscaleAlpha, 2, png::BitDepth::Sixteen),
        (png::ColorType::Rgb, 3, png::BitDepth::Sixteen),
        (png::ColorType::Rgba, 4, png::BitDepth::Sixteen),
    ] {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 4, 2);
            encoder.set_color(color);
            encoder.set_depth(depth);
            let mut writer = encoder.write_header().unwrap();
            let sample_bytes = if depth == png::BitDepth::Eight { 1 } else { 2 };
            writer
                .write_image_data(&vec![100; 8 * channels * sample_bytes])
                .unwrap();
        }
        assert_eq!(
            probe_raster_metadata_reader(&mut Cursor::new(&bytes))
                .unwrap()
                .channels as usize,
            channels
        );
        assert_parity(&bytes, "PNG color/depth");
    }
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 90)
        .encode(&[100; 8], 4, 2, jpeg_encoder::ColorType::Luma)
        .unwrap();
    assert_eq!(
        probe_raster_metadata_reader(&mut Cursor::new(&jpeg))
            .unwrap()
            .channels,
        1
    );
    assert_parity(&jpeg, "grayscale JPEG");
    let mut tiff = Cursor::new(Vec::new());
    tiff::encoder::TiffEncoder::new(&mut tiff)
        .unwrap()
        .write_image::<tiff::encoder::colortype::Gray16>(4, 2, &[1000; 8])
        .unwrap();
    let bytes = tiff.into_inner();
    assert_parity(&bytes, "16-bit grayscale TIFF");
    assert_eq!(
        probe_raster_metadata_reader(&mut Cursor::new(&bytes))
            .unwrap()
            .channels,
        1
    );
}

#[cfg(feature = "avif")]
#[path = "raster_metadata_reader_avif_tests.rs"]
mod avif;
