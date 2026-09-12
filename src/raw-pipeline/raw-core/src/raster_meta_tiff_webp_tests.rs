//! TIFF and WebP tests for [`super`] (#3507). Each container's coverage is
//! small enough on its own that splitting them further would leave two
//! near-empty files, so they share this sibling.
//!
//! Sibling of `raster_meta_tests.rs` (which owns the fixture builders this
//! file calls into via `super::tests::*`), `raster_meta_jpeg_tests.rs` and
//! `raster_meta_png_tests.rs`; split out under the 400-line soft budget.
//! Contents moved verbatim from the original `raster_meta_tests.rs`.

use super::tests::*;
use super::*;

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
    // No EXIF block for a TIFF — its IFD0 is its EXIF, and sharp reports
    // none (#3507 final fix wave, item 5). Returning the whole file here
    // cost 431 ms and a 48 MB buffer on a 48 MB TIFF, against sharp's 1 ms.
    assert_eq!(found.exif, None);
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
fn an_introduced_webp_exif_chunk_is_canonicalised_and_handed_back_as_stored() {
    // libvips writes the `Exif\0\0` introducer into the WebP `EXIF` chunk
    // (measured: 186 bytes starting `Exif\0\0` in a sharp-written WebP),
    // while this crate's own encoder writes the bare TIFF header the WebP
    // container spec asks for. Internally both are the bare block; what
    // `metadata()` returns is whichever form was stored, matching sharp
    // (#3507 final fix wave, item 3 — before this, a WebP→JPEG
    // `keepMetadata()` wrote `Exif\0\0Exif\0\0II*`, which sharp read as
    // `orientation: undefined`).
    let introduced = [EXIF_INTRO, EXIF_TIFF].concat();
    let bytes = webp_fixture(None, Some(&introduced), None);
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert!(found.exif_intro);
    assert_eq!(
        found.exif_as_stored().as_deref(),
        Some(introduced.as_slice())
    );
}

#[test]
fn a_bare_webp_exif_chunk_stays_bare() {
    let bytes = webp_fixture(None, Some(EXIF_TIFF), None);
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert!(!found.exif_intro);
    assert_eq!(found.exif_as_stored().as_deref(), Some(EXIF_TIFF));
}
