//! Fixtures for `raster_meta`'s round-trip and truncation tests (#3507).
//!
//! There is no `raster_encode_jpeg`/`_png`/`_tiff` module in this crate that
//! writes EXIF/ICC/XMP alongside pixels, so every fixture here is a baseline
//! container from the crate's own bare encoder (`crate::jpeg::encode`, the
//! `png` crate directly, `image`'s WebP encoder, or — for TIFF, which has no
//! metadata-aware encoder at all — a hand-built IFD0) with the metadata
//! segments/chunks hand-spliced in. No binary fixture files are committed.

use super::*;
use crate::raster::RasterImage;

const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
const XMP_PACKET: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#;

fn icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3)
}

fn ramp() -> RasterImage {
    RasterImage::new_rgb(8, 8, (0..8 * 8 * 3).map(|i| (i % 251) as u8).collect())
}

/// One JPEG marker segment: `FF <marker> <len-hi> <len-lo> <payload>`.
fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let length = (payload.len() + 2) as u16;
    let mut seg = vec![0xFF, marker];
    seg.extend_from_slice(&length.to_be_bytes());
    seg.extend_from_slice(payload);
    seg
}

/// A baseline JPEG from the crate's own encoder, with APP1 EXIF, APP1 XMP
/// and APP2 ICC segments hand-spliced in right after the SOI marker.
fn jpeg_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let img = ramp();
    let base = crate::jpeg::encode(img.width, img.height, &img.data, 90).unwrap();
    let mut out = base[..2].to_vec();
    if let Some(exif) = exif {
        let mut payload = EXIF_INTRO.to_vec();
        payload.extend_from_slice(exif);
        out.extend(jpeg_segment(0xE1, &payload));
    }
    if let Some(xmp) = xmp {
        let mut payload = XMP_INTRO.to_vec();
        payload.extend_from_slice(xmp);
        out.extend(jpeg_segment(0xE1, &payload));
    }
    if let Some(icc) = icc {
        let mut payload = ICC_INTRO.to_vec();
        payload.push(1); // sequence number
        payload.push(1); // total chunk count
        payload.extend_from_slice(icc);
        out.extend(jpeg_segment(0xE2, &payload));
    }
    out.extend_from_slice(&base[2..]);
    out
}

/// A baseline PNG from the `png` crate's own writer, with `iCCP`, `eXIf` and
/// `iTXt` (XMP) chunks hand-spliced in via `Writer::write_chunk` before the
/// image data.
fn png_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let img = ramp();
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, img.width, img.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        if let Some(icc) = icc {
            let mut payload = b"maple\0".to_vec();
            payload.push(0); // compression method: deflate, always 0
            payload.extend(miniz_oxide::deflate::compress_to_vec_zlib(icc, 6));
            writer.write_chunk(png::chunk::iCCP, &payload).unwrap();
        }
        if let Some(exif) = exif {
            writer.write_chunk(png::chunk::eXIf, exif).unwrap();
        }
        if let Some(xmp) = xmp {
            let mut payload = PNG_XMP_KEYWORD.to_vec();
            payload.push(0); // compression flag: uncompressed
            payload.push(0); // compression method
            payload.push(0); // language tag: empty, NUL-terminated
            payload.push(0); // translated keyword: empty, NUL-terminated
            payload.extend_from_slice(xmp);
            writer.write_chunk(png::chunk::iTXt, &payload).unwrap();
        }
        writer.write_image_data(&img.data).unwrap();
    }
    out
}

/// A minimal hand-built little-endian TIFF: an 8-byte header, one IFD0 entry
/// per metadata block given, and the value blobs appended right after the
/// IFD. There are no pixel/strip tags — `read_sidecars` never decodes
/// pixels, it only walks IFD0 for the ICC (34675) and XMP (700) tags.
fn tiff_fixture(icc: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let mut entries: Vec<(u16, &[u8])> = Vec::new();
    if let Some(icc) = icc {
        entries.push((34675, icc));
    }
    if let Some(xmp) = xmp {
        entries.push((700, xmp));
    }

    let ifd_offset = 8usize;
    let ifd_size = 2 + entries.len() * 12 + 4;
    let data_start = ifd_offset + ifd_size;

    let mut ifd = Vec::new();
    ifd.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    let mut blob = Vec::new();
    for (tag, data) in &entries {
        ifd.extend_from_slice(&tag.to_le_bytes());
        ifd.extend_from_slice(&7u16.to_le_bytes()); // type 7 = UNDEFINED
        ifd.extend_from_slice(&(data.len() as u32).to_le_bytes());
        let value_offset = (data_start + blob.len()) as u32;
        ifd.extend_from_slice(&value_offset.to_le_bytes());
        blob.extend_from_slice(data);
    }
    ifd.extend_from_slice(&0u32.to_le_bytes()); // no next IFD

    let mut out = b"II\x2a\x00".to_vec();
    out.extend_from_slice(&(ifd_offset as u32).to_le_bytes());
    out.extend(ifd);
    out.extend(blob);
    out
}

/// One padded RIFF chunk: `<fourcc><len (LE u32)><payload>[pad]`.
fn riff_chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut chunk = fourcc.to_vec();
    chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    chunk.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        chunk.push(0);
    }
    chunk
}

/// A baseline lossless WebP from `image`'s own encoder, with `ICCP`, `EXIF`
/// and `XMP ` RIFF chunks hand-spliced in after the `WEBP` FourCC, and the
/// top-level RIFF size field corrected to match.
fn webp_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let img = ramp();
    let mut base: Vec<u8> = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut base)
        .encode(
            &img.data,
            img.width,
            img.height,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();

    let mut extra = Vec::new();
    if let Some(icc) = icc {
        extra.extend(riff_chunk(b"ICCP", icc));
    }
    if let Some(exif) = exif {
        extra.extend(riff_chunk(b"EXIF", exif));
    }
    if let Some(xmp) = xmp {
        extra.extend(riff_chunk(b"XMP ", xmp));
    }

    let mut out = base[..12].to_vec(); // "RIFF" + size(4) + "WEBP"
    out.extend(extra);
    out.extend_from_slice(&base[12..]);
    let riff_size = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_size.to_le_bytes());
    out
}

#[test]
fn reads_all_three_blocks_back_out_of_a_jpeg() {
    let bytes = jpeg_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
}

#[test]
fn reads_all_three_blocks_back_out_of_a_png() {
    let bytes = png_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
}

#[test]
fn reads_all_three_blocks_back_out_of_a_webp() {
    let bytes = webp_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
}

#[test]
fn reads_the_icc_profile_back_out_of_a_tiff() {
    let bytes = tiff_fixture(Some(&icc()), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
    // The whole file stands in as the EXIF block for a TIFF.
    assert_eq!(found.exif.as_deref(), Some(bytes.as_slice()));
}

#[test]
fn a_container_with_no_metadata_reports_none() {
    let img = ramp();
    let bytes = crate::png::encode(img.width, img.height, &img.data).unwrap();
    assert_eq!(read_sidecars(&bytes), RasterSidecars::default());
}

#[test]
fn garbage_never_panics_and_reports_nothing() {
    for input in [
        &b""[..],
        b"\xFF\xD8",
        b"\x89PNG\r\n\x1a\n",
        b"RIFFsomething",
    ] {
        assert_eq!(read_sidecars(input), RasterSidecars::default());
    }
}

#[test]
fn a_truncated_jpeg_segment_length_does_not_read_past_the_buffer() {
    // An APP1 claiming 60000 bytes in a 40-byte file.
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE1, 0xEA, 0x60];
    bytes.extend_from_slice(b"Exif\0\0II\x2a\x00\x08\x00\x00\x00");
    assert_eq!(read_sidecars(&bytes).exif, None);
}

/// Every prefix of every metadata-bearing fixture must return, never panic.
/// Companion to the single-byte AVIF corruption sweep in
/// `raw-core/tests/avif_corruption.rs`, but truncation rather than mutation
/// — the realistic damage shape for a container cut off mid network-read or
/// mid disk-write — and it is exactly the shape that caught the PNG `iCCP`
/// off-by-one `read_png` now guards against with `get(nul + 2..)`.
#[test]
fn truncating_any_fixture_at_any_length_never_panics() {
    let fixtures: [(&str, Vec<u8>); 4] = [
        (
            "jpeg",
            jpeg_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET)),
        ),
        (
            "png",
            png_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET)),
        ),
        ("tiff", tiff_fixture(Some(&icc()), Some(XMP_PACKET))),
        (
            "webp",
            webp_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET)),
        ),
    ];
    for (name, bytes) in &fixtures {
        for len in 0..=bytes.len() {
            let outcome = std::panic::catch_unwind(|| read_sidecars(&bytes[..len]));
            assert!(
                outcome.is_ok(),
                "{name} fixture panicked at truncation length {len}"
            );
        }
    }
}
