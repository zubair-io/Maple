//! PNG-specific tests for [`super`] (#3507): `eXIf`/`iCCP`/`iTXt` chunk
//! reads, both `iTXt` XMP forms (plain and zlib-compressed), and `pHYs`
//! density.
//!
//! Sibling of `raster_meta_tests.rs` (which owns the fixture builders this
//! file calls into via `super::tests::*`), `raster_meta_jpeg_tests.rs` and
//! `raster_meta_tiff_webp_tests.rs`; split out under the 400-line soft
//! budget. Contents moved verbatim from the original `raster_meta_tests.rs`.

use super::tests::*;
use super::*;

#[test]
fn reads_all_three_blocks_back_out_of_a_png() {
    let bytes = png_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
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

#[test]
fn png_phys_density_converts_metres_to_dpi() {
    let mut payload = 2835u32.to_be_bytes().to_vec();
    payload.extend_from_slice(&2835u32.to_be_bytes()); // Y (unread)
    payload.push(1); // unit specifier: metre
    let bytes = png_fixture_raw(&[(png::chunk::pHYs, payload)]);
    // Reported as the rounded whole number sharp reports (#3507 final fix
    // wave, item 7): 2835 px/m is 72.009 dpi, and sharp says 72.
    assert_eq!(read_sidecars(&bytes).density, Some(72.0));
}

#[test]
fn the_libvips_default_png_density_is_suppressed_like_sharp() {
    // Every sharp-written PNG carries `pHYs` = 1000 px/m, which is libvips'
    // own 1 px/mm default and exactly 25.4 dpi. sharp reports no density
    // for it (its threshold is `xres > 1.0` px/mm); Maple used to report
    // 25.4 — measured on 8 of 8 PNG fixtures.
    let mut payload = 1000u32.to_be_bytes().to_vec();
    payload.extend_from_slice(&1000u32.to_be_bytes());
    payload.push(1); // unit specifier: metre
    let bytes = png_fixture_raw(&[(png::chunk::pHYs, payload)]);
    assert_eq!(read_sidecars(&bytes).density, None);
}

#[test]
fn a_png_exif_resolution_wins_over_phys() {
    // libvips reads the EXIF resolution after the `pHYs` one and
    // overwrites it — measured: a PNG carrying a 300 dpi `pHYs` and a
    // 25.4 dpi `eXIf` reads back through sharp as no density at all.
    let mut phys = 11811u32.to_be_bytes().to_vec(); // 300 dpi
    phys.extend_from_slice(&11811u32.to_be_bytes());
    phys.push(1);
    let exif = crate::raster_meta::set_exif_resolution(&[], 96.0);
    let bytes = png_fixture_raw(&[(png::chunk::pHYs, phys), (png::chunk::eXIf, exif)]);
    assert_eq!(read_sidecars(&bytes).density, Some(96.0));
}

#[test]
fn reads_a_text_chunk_xmp_packet() {
    // libvips writes PNG XMP as an uncompressed `tEXt` chunk under the
    // `XML:com.adobe.xmp` keyword rather than the `iTXt` this crate's own
    // encoder writes, so a sharp-written PNG's XMP was invisible before
    // (#3507 final fix wave, item 3 — measured: sharp reported 313 bytes on
    // a `withXmp()` PNG where Maple reported none).
    let mut payload = PNG_XMP_KEYWORD.to_vec();
    payload.extend_from_slice(XMP_PACKET);
    let bytes = png_fixture_raw(&[(png::chunk::tEXt, payload)]);
    assert_eq!(read_sidecars(&bytes).xmp.as_deref(), Some(XMP_PACKET));
}

#[test]
fn a_png_exif_chunk_is_handed_back_uintroduced() {
    // PNG's `eXIf` stores the TIFF header bare, and sharp hands it back
    // bare (measured: 180 bytes starting `II*` where the same source's
    // JPEG gives 186 starting `Exif\0\0`).
    let bytes = png_fixture(None, Some(EXIF_TIFF), None);
    let found = read_sidecars(&bytes);
    assert!(!found.exif_intro);
    assert_eq!(found.exif_as_stored().as_deref(), Some(EXIF_TIFF));
}

#[test]
fn an_introduced_png_exif_chunk_is_canonicalised() {
    // Not a form libvips writes, but a non-conforming writer's is not
    // allowed to reach an encoder introduced.
    let introduced = [EXIF_INTRO, EXIF_TIFF].concat();
    let bytes = png_fixture_raw(&[(png::chunk::eXIf, introduced)]);
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert!(found.exif_intro);
}
