//! JPEG-specific tests for [`super`] (#3507): APP1 EXIF/XMP, the numbered
//! APP2 ICC chunk reassembly, marker-stream edge cases (fill bytes,
//! standalone markers, a truncated segment length), and APP0 JFIF density.
//!
//! Sibling of `raster_meta_tests.rs` (which owns the fixture builders this
//! file calls into via `super::tests::*`), `raster_meta_png_tests.rs` and
//! `raster_meta_tiff_webp_tests.rs`; split out under the 400-line soft
//! budget. Contents moved verbatim from the original `raster_meta_tests.rs`.

use super::tests::*;
use super::*;

#[test]
fn reads_all_three_blocks_back_out_of_a_jpeg() {
    let bytes = jpeg_fixture(Some(&icc()), Some(EXIF_TIFF), Some(XMP_PACKET));
    let found = read_sidecars(&bytes);
    assert_eq!(found.exif.as_deref(), Some(EXIF_TIFF));
    assert_eq!(found.icc.as_deref(), Some(icc().as_slice()));
    assert_eq!(found.xmp.as_deref(), Some(XMP_PACKET));
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
fn jfif_density_in_inches_reports_dpi_directly() {
    let bytes = jpeg_with_jfif_density(1, 72);
    assert_eq!(read_sidecars(&bytes).density, Some(72.0));
}

#[test]
fn jfif_density_in_centimetres_converts_to_dpi() {
    // 28 px/cm is 71.12 dpi, reported as the rounded whole number sharp
    // reports — measured: sharp says 71 for a JPEG carrying exactly this
    // JFIF segment (#3507 final fix wave, item 7).
    let bytes = jpeg_with_jfif_density(2, 28);
    assert_eq!(read_sidecars(&bytes).density, Some(71.0));
}

#[test]
fn a_jpeg_with_no_stated_resolution_reports_the_libvips_default() {
    // mozjpeg (what sharp encodes with) writes no JFIF density segment at
    // all, and libvips' JPEG loader assumes 72 dpi — measured: sharp
    // reports 72 for such a file, where Maple reported nothing.
    let bytes = jpeg_with_extra(&[]);
    assert_eq!(read_sidecars(&bytes).density, Some(72.0));
}

#[test]
fn an_exif_resolution_wins_over_the_jfif_one() {
    // libvips reads the EXIF resolution after the JFIF one and overwrites
    // it — measured: `keepMetadata().withMetadata({density:300})` on a
    // JPEG whose kept EXIF says 96 dpi reads back through sharp as 96.
    let exif = crate::raster_meta::set_exif_resolution(&[], 96.0);
    let jfif = {
        let mut payload = b"JFIF\0".to_vec();
        payload.extend_from_slice(&[1, 1, 1]); // version 1.1, units = inch
        payload.extend_from_slice(&300u16.to_be_bytes()); // X density
        payload.extend_from_slice(&300u16.to_be_bytes()); // Y density
        payload.extend_from_slice(&[0, 0]); // no thumbnail
        jpeg_segment(0xE0, &payload)
    };
    let mut extra = jfif;
    extra.extend(jpeg_segment(0xE1, &[EXIF_INTRO, &exif].concat()));
    let bytes = jpeg_with_extra(&extra);
    assert_eq!(read_sidecars(&bytes).density, Some(96.0));
}
