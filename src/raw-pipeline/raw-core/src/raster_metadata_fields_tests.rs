//! Committed synthetic Sharp 0.34.5 oracle fixtures, including seekable parity.

use crate::raster_analyze::{analyze, analyze_reader};
use serde_json::Value;
use std::io::{BufReader, Cursor};
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raster-metadata")
}

#[test]
fn metadata_fields_match_committed_sharp_oracle_and_seekable_files() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../../test-fixtures/raster-metadata/expected.json"
    ))
    .unwrap();
    for (name, expected) in manifest.as_object().unwrap() {
        #[cfg(not(feature = "avif"))]
        if name.ends_with(".avif") {
            continue;
        }
        let path = fixtures().join(name);
        let bytes = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let request = r#"{"v":1,"what":["metadata"]}"#;
        let json = analyze(&bytes, request).unwrap();
        let actual: Value = serde_json::from_str(&json).unwrap();
        for (field, value) in expected.as_object().unwrap() {
            assert_eq!(&actual["metadata"][field], value, "{name} / {field}");
        }
        let mut reader = BufReader::new(std::fs::File::open(&path).unwrap());
        assert_eq!(
            analyze_reader(&mut reader, request).unwrap(),
            json,
            "{name}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
    }
}

#[test]
fn metadata_fields_are_total_on_truncated_and_corrupt_headers() {
    for name in [
        "progressive-444.jpg",
        "palette-4-interlaced.png",
        "gray-alpha-16.tiff",
        "three-pages.gif",
        "three-pages.webp",
        "avif-10.avif",
    ] {
        let bytes = std::fs::read(fixtures().join(name)).unwrap();
        let format = match name.rsplit('.').next().unwrap() {
            "jpg" => "jpeg",
            "png" => "png",
            "tiff" => "tiff",
            "gif" => "gif",
            "webp" => "webp",
            _ => "avif",
        };
        for end in 0..=bytes.len() {
            let mut reader = Cursor::new(&bytes[..end]);
            crate::raster_metadata_fields::read(&mut reader, format).unwrap();
        }
        for at in (0..bytes.len()).step_by(11) {
            let mut corrupt = bytes.clone();
            corrupt[at] ^= 0xff;
            crate::raster_metadata_fields::read(&mut Cursor::new(&corrupt), format).unwrap();
        }
    }
}

#[test]
fn cyclic_tiff_page_chain_terminates_without_duplicate_pages() {
    let mut bytes = std::fs::read(fixtures().join("three-pages.tiff")).unwrap();
    // The synthetic oracle TIFF is little-endian; link its first IFD back
    // to itself without touching any pixels or other fields.
    assert_eq!(&bytes[..2], b"II");
    let first = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[first..first + 2].try_into().unwrap()) as usize;
    let next = first + 2 + count * 12;
    bytes[next..next + 4].copy_from_slice(&(first as u32).to_le_bytes());
    let fields = crate::raster_metadata_fields::read(&mut Cursor::new(bytes), "tiff").unwrap();
    assert_eq!(fields.pages, Some(1));
}
