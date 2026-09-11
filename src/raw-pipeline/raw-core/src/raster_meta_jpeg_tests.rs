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
    let bytes = jpeg_with_jfif_density(2, 28);
    let density = read_sidecars(&bytes).density.expect("density");
    assert!((density - 71.12).abs() < 0.01, "got {density}");
}
