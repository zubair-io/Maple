use super::*;
use crate::raster::decode_raster;

#[test]
fn sharp_jpeg_tiffs_match_independent_pixel_oracles() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/jpeg-tiff");
    for (name, width, height, orientation) in [
        ("strips", 73, 273, 1),
        ("tiles", 67, 45, 1),
        ("bigtiff", 67, 45, 1),
        ("quality40", 31, 27, 1),
        ("quality95", 31, 27, 1),
        ("orientation6", 31, 27, 6),
    ] {
        let bytes = std::fs::read(root.join(format!("{name}.tiff"))).unwrap();
        let expected = std::fs::read(root.join(format!("{name}.rgb"))).unwrap();
        for hint in [None, Some("tiff"), Some("tif")] {
            let actual = decode_raster(&bytes, hint)
                .unwrap_or_else(|error| panic!("{name} {hint:?}: {error}"));
            assert_eq!(
                (actual.width, actual.height, actual.channels),
                (width, height, 3),
                "{name}"
            );
            assert_eq!(
                actual.orientation,
                ExifOrientation::from_u16(orientation),
                "{name}"
            );
            assert_eq!(actual.data.len(), expected.len());
            let differences: Vec<_> = actual
                .data
                .iter()
                .zip(&expected)
                .map(|(a, b)| a.abs_diff(*b))
                .collect();
            let max = *differences.iter().max().unwrap();
            let mean =
                differences.iter().map(|v| f64::from(*v)).sum::<f64>() / differences.len() as f64;
            assert!(max <= 4 && mean <= 0.5, "{name}: max={max}, mean={mean}");
        }
    }
}

fn complete_jpeg_tiff() -> Vec<u8> {
    let jpeg = crate::jpeg::encode(24, 16, &[120, 60, 200].repeat(24 * 16), 90).unwrap();
    let tags = [
        (256u16, 4u16, 1u32, 24u32),
        (257, 4, 1, 16),
        (258, 3, 1, 8),
        (259, 3, 1, 7),
        (262, 3, 1, 6),
        (273, 4, 1, 8 + 2 + 8 * 12 + 4),
        (277, 3, 1, 3),
        (279, 4, 1, jpeg.len() as u32),
    ];
    let mut tiff = b"II\x2a\0\x08\0\0\0".to_vec();
    tiff.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    for (tag, kind, count, value) in tags {
        tiff.extend_from_slice(&tag.to_le_bytes());
        tiff.extend_from_slice(&kind.to_le_bytes());
        tiff.extend_from_slice(&count.to_le_bytes());
        tiff.extend_from_slice(&value.to_le_bytes());
    }
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend(jpeg);
    tiff
}

#[test]
fn decodes_complete_jpeg_without_shared_tables() {
    let decoded = decode_raster(&complete_jpeg_tiff(), None).unwrap();
    assert_eq!((decoded.width, decoded.height), (24, 16));
    assert!(decoded.data.chunks_exact(3).all(|p| p
        .iter()
        .zip([120u8, 60, 200])
        .all(|(a, b)| a.abs_diff(b) <= 2)));
}

fn patch_tag(bytes: &mut [u8], tag: u16, value: u32) {
    let offset = tag_entry(bytes, tag) + 8;
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn tag_entry(bytes: &[u8], tag: u16) -> usize {
    assert_eq!(&bytes[..4], b"II\x2a\0");
    let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
    let start = ifd + 2;
    let entry = bytes[start..start + count * 12]
        .chunks_exact(12)
        .position(|entry| u16::from_le_bytes(entry[..2].try_into().unwrap()) == tag)
        .unwrap();
    start + entry * 12
}

#[test]
fn rejects_malformed_shared_tables_and_tile_layouts_without_panicking() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/jpeg-tiff");
    let original = std::fs::read(root.join("tiles.tiff")).unwrap();
    let entry = tag_entry(&original, 347);
    let offset = u32::from_le_bytes(original[entry + 8..entry + 12].try_into().unwrap()) as usize;
    for count in [0u32, 1, 2, 3] {
        let mut invalid = original.clone();
        invalid[entry + 4..entry + 8].copy_from_slice(&count.to_le_bytes());
        assert!(decode_raster(&invalid, None).is_err());
    }
    let mut invalid = original.clone();
    invalid[offset] = 0;
    assert!(decode_raster(&invalid, None)
        .unwrap_err()
        .to_string()
        .contains("JPEG-compressed TIFF"));
    let mut invalid = original.clone();
    invalid[entry..entry + 2].copy_from_slice(&65000u16.to_le_bytes());
    assert!(decode_raster(&invalid, None).is_err());
    let mut invalid = original.clone();
    patch_tag(&mut invalid, 322, u32::MAX);
    patch_tag(&mut invalid, 323, u32::MAX);
    assert!(decode_raster(&invalid, None).is_err());
    let mut invalid = original.clone();
    let offsets = tag_entry(&invalid, 324);
    invalid[offsets + 4..offsets + 8].copy_from_slice(&1u32.to_le_bytes());
    assert!(decode_raster(&invalid, None).is_err());
}

#[test]
fn rejects_invalid_chunk_extents_and_mismatched_jpeg_headers() {
    let original = complete_jpeg_tiff();
    for (tag, value) in [(273, u32::MAX), (279, u32::MAX), (256, 23), (257, 17)] {
        let mut invalid = original.clone();
        patch_tag(&mut invalid, tag, value);
        assert!(
            decode_raster(&invalid, None).is_err(),
            "tag={tag}, value={value}"
        );
    }
    for end in [4, 30, original.len() - 40] {
        assert!(decode_raster(&original[..end], None).is_err());
    }
}

#[test]
fn rejects_pixel_and_chunk_memory_bombs_before_decoding() {
    let original = complete_jpeg_tiff();
    for (width, height, message) in [
        (20000, 20000, "pixel limit"),
        (10000, 10000, "decode budget"),
    ] {
        let mut invalid = original.clone();
        patch_tag(&mut invalid, 256, width);
        patch_tag(&mut invalid, 257, height);
        let error = decode_raster(&invalid, None).unwrap_err().to_string();
        assert!(error.contains(message), "{error}");
    }
}
