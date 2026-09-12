//! Tests for [`super`] (#3507): reading the EXIF resolution, and rewriting
//! Orientation/resolution in place or via a freshly built minimal block.

use super::*;

/// A little-endian block whose IFD0 carries Orientation = `value` and
/// nothing else.
fn orientation_only(value: u16) -> Vec<u8> {
    set_exif_orientation(&[], value)
}

/// A block carrying Orientation, X/YResolution and ResolutionUnit — the
/// shape libvips writes, and the one the in-place rewriters need.
fn full_block(orientation: u16, dpi: f64) -> Vec<u8> {
    minimal_block(Some(orientation), Some(dpi))
}

#[test]
fn rewrites_an_orientation_in_place() {
    let block = orientation_only(6);
    let rewritten = set_exif_orientation(&block, 3);
    assert_eq!(rewritten.len(), block.len());
    assert_eq!(
        crate::raster::exif_orientation_from_block(&rewritten),
        Some(3)
    );
}

#[test]
fn tolerates_an_introduced_block_instead_of_discarding_it() {
    // An `Exif\0\0`-introduced block used to match neither `II` nor `MM`
    // at offset 0, so the whole thing was replaced by the minimal stub —
    // measured on a WebP→JPEG `keepMetadata().withMetadata({orientation:
    // 5})`, where a 186-byte block came out 32 bytes and every tag but
    // Orientation was lost (#3507 final fix wave, item 3).
    let plain = full_block(6, 96.0);
    let introduced = [b"Exif\0\0".as_slice(), &plain].concat();
    let rewritten = set_exif_orientation(&introduced, 5);
    assert_eq!(rewritten.len(), plain.len());
    assert_eq!(&rewritten[..2], b"II");
    assert_eq!(
        crate::raster::exif_orientation_from_block(&rewritten),
        Some(5)
    );
    // Every other tag survives.
    assert_eq!(exif_resolution_dpi(&rewritten), Some(96.0));
}

#[test]
fn reads_the_resolution_back_in_dots_per_inch() {
    assert_eq!(exif_resolution_dpi(&full_block(1, 96.0)), Some(96.0));
    assert_eq!(exif_resolution_dpi(&full_block(1, 300.0)), Some(300.0));
    // libvips' own default for an image with no stated density is 1 px/mm,
    // which it writes as 25.4 dpi.
    assert_eq!(exif_resolution_dpi(&full_block(1, 25.4)), Some(25.4));
}

#[test]
fn a_centimetre_resolution_unit_converts_to_inches() {
    let mut block = full_block(1, 100.0);
    // Flip ResolutionUnit from 2 (inch) to 3 (centimetre): the one SHORT
    // entry after the two rationals, whose value field is the last two
    // bytes of the fourth entry.
    let unit_value_at = 8 + 2 + 3 * 12 + 8;
    block[unit_value_at] = 3;
    let dpi = exif_resolution_dpi(&block).expect("resolution");
    assert!((dpi - 254.0).abs() < 1e-9, "got {dpi}");
}

#[test]
fn a_block_with_no_resolution_has_none_to_read() {
    assert_eq!(exif_resolution_dpi(&orientation_only(6)), None);
    assert_eq!(exif_resolution_dpi(&[]), None);
    assert_eq!(exif_resolution_dpi(b"not a tiff header at all"), None);
}

#[test]
fn rewrites_the_resolution_in_place_without_growing_the_block() {
    let block = full_block(6, 96.0);
    let rewritten = set_exif_resolution(&block, 300.0);
    assert_eq!(rewritten.len(), block.len());
    assert_eq!(exif_resolution_dpi(&rewritten), Some(300.0));
    // The orientation is untouched by a density rewrite.
    assert_eq!(
        crate::raster::exif_orientation_from_block(&rewritten),
        Some(6)
    );
}

#[test]
fn a_block_with_no_resolution_tags_is_rebuilt_keeping_its_orientation() {
    // There is no room to insert three IFD entries without reflowing every
    // offset in the block, so a minimal one is built — and it has to carry
    // the orientation the original declared, or a `withMetadata({
    // orientation, density})` pair would lose one of the two.
    let rewritten = set_exif_resolution(&orientation_only(5), 300.0);
    assert_eq!(exif_resolution_dpi(&rewritten), Some(300.0));
    assert_eq!(
        crate::raster::exif_orientation_from_block(&rewritten),
        Some(5)
    );
}

#[test]
fn a_big_endian_block_is_rewritten_big_endian() {
    // Hand-build MM-ordered Orientation + X/YResolution + ResolutionUnit.
    let mut block = b"MM\x00\x2a".to_vec();
    block.extend_from_slice(&8u32.to_be_bytes());
    block.extend_from_slice(&4u16.to_be_bytes());
    let data_at = 8u32 + 2 + 4 * 12 + 4;
    let entry = |tag: u16, kind: u16, value: [u8; 4]| -> Vec<u8> {
        let mut out = tag.to_be_bytes().to_vec();
        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(&value);
        out
    };
    block.extend(entry(TAG_ORIENTATION, TYPE_SHORT, [0, 8, 0, 0]));
    block.extend(entry(
        TAG_X_RESOLUTION,
        TYPE_RATIONAL,
        data_at.to_be_bytes(),
    ));
    block.extend(entry(
        TAG_Y_RESOLUTION,
        TYPE_RATIONAL,
        (data_at + 8).to_be_bytes(),
    ));
    block.extend(entry(TAG_RESOLUTION_UNIT, TYPE_SHORT, [0, 2, 0, 0]));
    block.extend_from_slice(&0u32.to_be_bytes());
    for _ in 0..2 {
        block.extend_from_slice(&72000u32.to_be_bytes());
        block.extend_from_slice(&1000u32.to_be_bytes());
    }

    assert_eq!(exif_resolution_dpi(&block), Some(72.0));
    assert_eq!(crate::raster::exif_orientation_from_block(&block), Some(8));

    let rewritten = set_exif_resolution(&block, 150.0);
    assert_eq!(rewritten.len(), block.len());
    assert_eq!(exif_resolution_dpi(&rewritten), Some(150.0));
    let rewritten = set_exif_orientation(&rewritten, 3);
    assert_eq!(
        crate::raster::exif_orientation_from_block(&rewritten),
        Some(3)
    );
    assert_eq!(exif_resolution_dpi(&rewritten), Some(150.0));
}
