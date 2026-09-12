//! Shared fixtures for `raster_meta`'s round-trip and truncation tests
//! (#3507) plus the container-agnostic cases (no metadata, garbage input,
//! the truncation sweep).
//!
//! There is no `raster_encode_jpeg`/`_png`/`_tiff` module in this crate that
//! writes EXIF/ICC/XMP alongside pixels, so every fixture here is a baseline
//! container from the crate's own bare encoder (`crate::jpeg::encode`, the
//! `png` crate directly, `image`'s WebP encoder, or — for TIFF, which has no
//! metadata-aware encoder at all — a hand-built IFD0) with the metadata
//! segments/chunks hand-spliced in. No binary fixture files are committed.
//!
//! The per-container tests live in the sibling files `raster_meta_jpeg_tests.rs`,
//! `raster_meta_png_tests.rs` and `raster_meta_tiff_webp_tests.rs` — split out
//! once this file grew past the 400-line soft budget (CONTRIBUTING.md
//! § "File-size budget"), same `#[path]` sibling pattern `stages/hsl.rs`
//! uses. Every builder below is `pub(super)` so those siblings can reach it
//! as `super::tests::name(..)` — they are all descendants of the same
//! `raster_meta` module this file's `use super::*` pulls from, so a
//! `pub(super)` item here is visible from any of them.

use super::*;
use crate::raster::RasterImage;

pub(super) const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
pub(super) const XMP_PACKET: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#;

pub(super) fn icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3)
}

pub(super) fn ramp() -> RasterImage {
    RasterImage::new_rgb(8, 8, (0..8 * 8 * 3).map(|i| (i % 251) as u8).collect())
}

/// One JPEG marker segment: `FF <marker> <len-hi> <len-lo> <payload>`.
pub(super) fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let length = (payload.len() + 2) as u16;
    let mut seg = vec![0xFF, marker];
    seg.extend_from_slice(&length.to_be_bytes());
    seg.extend_from_slice(payload);
    seg
}

/// A baseline JPEG from the crate's own encoder, with `extra` raw marker
/// segment bytes spliced in right after the SOI marker.
pub(super) fn jpeg_with_extra(extra: &[u8]) -> Vec<u8> {
    let img = ramp();
    let base = crate::jpeg::encode(img.width, img.height, &img.data, 90).unwrap();
    let mut out = base[..2].to_vec();
    out.extend_from_slice(extra);
    out.extend_from_slice(&base[2..]);
    out
}

/// One numbered APP2 ICC chunk segment: `ICC_PROFILE\0` + sequence + total
/// count + this chunk's slice of the profile.
pub(super) fn icc_app2_segment(sequence: u8, count: u8, data: &[u8]) -> Vec<u8> {
    let mut payload = ICC_INTRO.to_vec();
    payload.push(sequence);
    payload.push(count);
    payload.extend_from_slice(data);
    jpeg_segment(0xE2, &payload)
}

/// A baseline JPEG with APP1 EXIF, APP1 XMP and a single-chunk APP2 ICC
/// segment hand-spliced in right after the SOI marker.
pub(super) fn jpeg_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
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
pub(super) fn png_fixture_raw(chunks: &[(png::chunk::ChunkType, Vec<u8>)]) -> Vec<u8> {
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
pub(super) fn png_itxt_xmp_payload(xmp: &[u8]) -> Vec<u8> {
    let mut payload = PNG_XMP_KEYWORD.to_vec();
    payload.push(0); // compression flag: uncompressed
    payload.push(0); // compression method
    payload.push(0); // language tag: empty, NUL-terminated
    payload.push(0); // translated keyword: empty, NUL-terminated
    payload.extend_from_slice(xmp);
    payload
}

pub(super) fn png_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
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
pub(super) fn tiff_fixture(icc: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
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
pub(super) fn riff_chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
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
pub(super) fn webp_fixture(icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Vec<u8> {
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

/// A minimal JPEG carrying only an APP0 JFIF segment, terminated with EOI —
/// enough for `read_jpeg` to reach the density field without needing a real
/// encoded image.
pub(super) fn jpeg_with_jfif_density(units: u8, density: u16) -> Vec<u8> {
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
fn a_container_with_no_metadata_reports_none() {
    let img = ramp();
    let bytes = crate::png::encode(img.width, img.height, &img.data).unwrap();
    assert_eq!(
        read_sidecars(&bytes),
        RasterSidecars {
            // A PNG with no `pHYs` is 72 dpi, libvips' own default for the
            // container (#3507 final fix wave, item 7) — every other field
            // is genuinely absent.
            density: Some(72.0),
            ..Default::default()
        }
    );
}

#[test]
fn garbage_never_panics_and_reports_no_blocks() {
    for input in [
        &b""[..],
        b"\xFF\xD8",
        b"\x89PNG\r\n\x1a\n",
        b"RIFFsomething",
    ] {
        let found = read_sidecars(input);
        assert_eq!(
            (found.exif, found.icc, found.xmp),
            (None, None, None),
            "no block may be invented from {input:?}"
        );
        // `density` is the exception: a JPEG or PNG that states no
        // resolution is 72 dpi by libvips' own default (#3507 final fix
        // wave, item 7), and the stubs above are a JPEG and a PNG as far
        // as their magic goes. Nothing reaches `metadata()` this way — a
        // file this damaged fails the dimension probe first.
        let has_default = input.starts_with(&[0xFF, 0xD8]) || input.starts_with(b"\x89PNG");
        assert_eq!(found.density, has_default.then_some(72.0));
    }
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

/// A minimal IFD0 with a single Orientation entry set to `value` — the same
/// 10-byte shape `EXIF_TIFF` uses at orientation 1.
fn exif_with_orientation(value: u16) -> Vec<u8> {
    let mut tiff = vec![0u8; 26];
    tiff[..2].copy_from_slice(b"II");
    tiff[2..4].copy_from_slice(&42u16.to_le_bytes());
    tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
    tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
    tiff[10..12].copy_from_slice(&0x0112u16.to_le_bytes());
    tiff[12..14].copy_from_slice(&3u16.to_le_bytes());
    tiff[14..18].copy_from_slice(&1u32.to_le_bytes());
    tiff[18..20].copy_from_slice(&value.to_le_bytes());
    tiff
}

#[test]
fn set_exif_orientation_rewrites_an_existing_tag() {
    let block = set_exif_orientation(&exif_with_orientation(1), 6);
    assert_eq!(crate::raster::exif_orientation_from_block(&block), Some(6));
}

#[test]
fn set_exif_orientation_creates_a_block_when_there_is_none() {
    let block = set_exif_orientation(&[], 3);
    assert_eq!(crate::raster::exif_orientation_from_block(&block), Some(3));
}

#[test]
fn set_exif_orientation_leaves_other_tags_alone() {
    let original = exif_with_orientation(1);
    let block = set_exif_orientation(&original, 8);
    assert_eq!(block.len(), original.len(), "the block must not grow");
    assert_eq!(
        &block[..8],
        &original[..8],
        "the TIFF header must be intact"
    );
}
