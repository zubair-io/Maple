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

/// A baseline JPEG from the crate's own encoder, with `extra` raw marker
/// segment bytes spliced in right after the SOI marker.
fn jpeg_with_extra(extra: &[u8]) -> Vec<u8> {
    let img = ramp();
    let base = crate::jpeg::encode(img.width, img.height, &img.data, 90).unwrap();
    let mut out = base[..2].to_vec();
    out.extend_from_slice(extra);
    out.extend_from_slice(&base[2..]);
    out
}

/// One numbered APP2 ICC chunk segment: `ICC_PROFILE\0` + sequence + total
/// count + this chunk's slice of the profile.
fn icc_app2_segment(sequence: u8, count: u8, data: &[u8]) -> Vec<u8> {
    let mut payload = ICC_INTRO.to_vec();
    payload.push(sequence);
    payload.push(count);
    payload.extend_from_slice(data);
    jpeg_segment(0xE2, &payload)
}

/// A baseline JPEG with APP1 EXIF, APP1 XMP and a single-chunk APP2 ICC
/// segment hand-spliced in right after the SOI marker.
fn jpeg_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let mut extra = Vec::new();
    if let Some(exif) = exif {
        let mut payload = EXIF_INTRO.to_vec();
        payload.extend_from_slice(exif);
        extra.extend(jpeg_segment(0xE1, &payload));
    }
    if let Some(xmp) = xmp {
        let mut payload = XMP_INTRO.to_vec();
        payload.extend_from_slice(xmp);
        extra.extend(jpeg_segment(0xE1, &payload));
    }
    if let Some(icc) = icc {
        extra.extend(icc_app2_segment(1, 1, icc));
    }
    jpeg_with_extra(&extra)
}

/// A baseline PNG from the `png` crate's own writer, with `chunks` (type,
/// payload) spliced in via the public `Writer::write_chunk` (which computes
/// the CRC) before the image data.
fn png_fixture_raw(chunks: &[(png::chunk::ChunkType, Vec<u8>)]) -> Vec<u8> {
    let img = ramp();
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, img.width, img.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        for (kind, payload) in chunks {
            writer.write_chunk(*kind, payload).unwrap();
        }
        writer.write_image_data(&img.data).unwrap();
    }
    out
}

/// An uncompressed (compression flag 0) `iTXt` XMP chunk payload.
fn png_itxt_xmp_payload(xmp: &[u8]) -> Vec<u8> {
    let mut payload = PNG_XMP_KEYWORD.to_vec();
    payload.push(0); // compression flag: uncompressed
    payload.push(0); // compression method
    payload.push(0); // language tag: empty, NUL-terminated
    payload.push(0); // translated keyword: empty, NUL-terminated
    payload.extend_from_slice(xmp);
    payload
}

fn png_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
    let mut chunks: Vec<(png::chunk::ChunkType, Vec<u8>)> = Vec::new();
    if let Some(icc) = icc {
        let mut payload = b"maple\0".to_vec();
        payload.push(0); // compression method: deflate, always 0
        payload.extend(miniz_oxide::deflate::compress_to_vec_zlib(icc, 6));
        chunks.push((png::chunk::iCCP, payload));
    }
    if let Some(exif) = exif {
        chunks.push((png::chunk::eXIf, exif.to_vec()));
    }
    if let Some(xmp) = xmp {
        chunks.push((png::chunk::iTXt, png_itxt_xmp_payload(xmp)));
    }
    png_fixture_raw(&chunks)
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
fn a_tiff_icc_tag_with_a_non_byte_sized_type_is_ignored() {
    // tag 34675, type 3 (SHORT). The declared count would mean `count * 2`
    // bytes, not `count` bytes, so this must not be read as if it were.
    let mut ifd = Vec::new();
    ifd.extend_from_slice(&1u16.to_le_bytes()); // one entry
    ifd.extend_from_slice(&34675u16.to_le_bytes());
    ifd.extend_from_slice(&3u16.to_le_bytes()); // type = SHORT
    ifd.extend_from_slice(&1u32.to_le_bytes()); // count
    ifd.extend_from_slice(&0u32.to_le_bytes()); // value/offset, never read
    ifd.extend_from_slice(&0u32.to_le_bytes()); // no next IFD

    let mut bytes = b"II\x2a\x00".to_vec();
    bytes.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
    bytes.extend(ifd);

    assert_eq!(read_sidecars(&bytes).icc, None);
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

#[test]
fn skips_fill_bytes_and_standalone_markers_before_finding_exif() {
    // SOI, a standalone RST0 marker (no length field), three 0xFF fill
    // bytes, then the real APP1 EXIF marker code.
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xD0, 0xFF, 0xFF];
    let mut exif_payload = EXIF_INTRO.to_vec();
    exif_payload.extend_from_slice(EXIF_TIFF);
    bytes.extend(jpeg_segment(0xE1, &exif_payload));
    bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
    assert_eq!(read_sidecars(&bytes).exif.as_deref(), Some(EXIF_TIFF));
}

#[test]
fn reassembles_a_two_chunk_icc_profile_in_order() {
    let profile = icc();
    let (a, b) = profile.split_at(profile.len() / 2);
    let mut extra = Vec::new();
    extra.extend(icc_app2_segment(1, 2, a));
    extra.extend(icc_app2_segment(2, 2, b));
    let bytes = jpeg_with_extra(&extra);
    assert_eq!(
        read_sidecars(&bytes).icc.as_deref(),
        Some(profile.as_slice())
    );
}

#[test]
fn reassembles_a_two_chunk_icc_profile_arriving_out_of_order() {
    let profile = icc();
    let (a, b) = profile.split_at(profile.len() / 2);
    let mut extra = Vec::new();
    extra.extend(icc_app2_segment(2, 2, b));
    extra.extend(icc_app2_segment(1, 2, a));
    let bytes = jpeg_with_extra(&extra);
    assert_eq!(
        read_sidecars(&bytes).icc.as_deref(),
        Some(profile.as_slice())
    );
}

#[test]
fn a_missing_icc_chunk_reports_no_profile() {
    let profile = icc();
    let (a, _b) = profile.split_at(profile.len() / 2);
    // Declares 2 total chunks but only chunk 1 is ever present.
    let extra = icc_app2_segment(1, 2, a);
    let bytes = jpeg_with_extra(&extra);
    assert_eq!(read_sidecars(&bytes).icc, None);
}

#[test]
fn a_duplicate_icc_sequence_number_reports_no_profile() {
    let profile = icc();
    let (a, _b) = profile.split_at(profile.len() / 2);
    let mut extra = Vec::new();
    extra.extend(icc_app2_segment(1, 2, a));
    extra.extend(icc_app2_segment(1, 2, a)); // duplicate seq 1, no seq 2 ever
    let bytes = jpeg_with_extra(&extra);
    assert_eq!(read_sidecars(&bytes).icc, None);
}

#[test]
fn reads_a_zlib_compressed_itxt_xmp_packet() {
    let mut payload = PNG_XMP_KEYWORD.to_vec();
    payload.push(1); // compression flag: compressed
    payload.push(0); // compression method: deflate
    payload.push(0); // language tag: empty, NUL-terminated
    payload.push(0); // translated keyword: empty, NUL-terminated
    payload.extend(miniz_oxide::deflate::compress_to_vec_zlib(XMP_PACKET, 6));
    let bytes = png_fixture_raw(&[(png::chunk::iTXt, payload)]);
    assert_eq!(read_sidecars(&bytes).xmp.as_deref(), Some(XMP_PACKET));
}

#[test]
fn reads_an_uncompressed_itxt_xmp_packet() {
    let bytes = png_fixture_raw(&[(png::chunk::iTXt, png_itxt_xmp_payload(XMP_PACKET))]);
    assert_eq!(read_sidecars(&bytes).xmp.as_deref(), Some(XMP_PACKET));
}

/// A minimal JPEG carrying only an APP0 JFIF segment, terminated with EOI —
/// enough for `read_jpeg` to reach the density field without needing a real
/// encoded image.
fn jpeg_with_jfif_density(units: u8, density: u16) -> Vec<u8> {
    let mut payload = b"JFIF\0".to_vec();
    payload.push(1); // version major
    payload.push(1); // version minor
    payload.push(units);
    payload.extend_from_slice(&density.to_be_bytes()); // X density
    payload.extend_from_slice(&density.to_be_bytes()); // Y density (unread)
    payload.push(0); // thumbnail width
    payload.push(0); // thumbnail height
    let mut bytes = vec![0xFF, 0xD8];
    bytes.extend(jpeg_segment(0xE0, &payload));
    bytes.extend_from_slice(&[0xFF, 0xD9]);
    bytes
}

#[test]
fn jfif_density_in_inches_reports_dpi_directly() {
    let bytes = jpeg_with_jfif_density(1, 72);
    assert_eq!(read_sidecars(&bytes).density, Some(72.0));
}

#[test]
fn jfif_density_in_centimetres_converts_to_dpi() {
    let bytes = jpeg_with_jfif_density(2, 28);
    let density = read_sidecars(&bytes).density.expect("density");
    assert!((density - 71.12).abs() < 0.01, "got {density}");
}

#[test]
fn png_phys_density_converts_metres_to_dpi() {
    let mut payload = 2835u32.to_be_bytes().to_vec();
    payload.extend_from_slice(&2835u32.to_be_bytes()); // Y (unread)
    payload.push(1); // unit specifier: metre
    let bytes = png_fixture_raw(&[(png::chunk::pHYs, payload)]);
    let density = read_sidecars(&bytes).density.expect("density");
    assert!((density - 72.009).abs() < 0.01, "got {density}");
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
