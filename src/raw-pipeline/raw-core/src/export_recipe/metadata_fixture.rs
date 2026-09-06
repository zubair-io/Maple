//! Synthetic source metadata for the recipe strip-policy regression. Pixels
//! and DNG offsets are preserved; only a replacement root IFD is appended.

use crate::test_support::synth_dng::Ifd;
use rawler::formats::tiff::{reader::TiffReader, GenericTiffReader, Value};
use std::io::Cursor;

const CAPTURED: &str = "2026:09:06 10:11:12";
const ARTIST: &str = "Maple synthetic metadata sentinel";
const XMP: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="Maple synthetic XMP sentinel"/></rdf:RDF></x:xmpmeta>"#;

pub(super) fn with_source_metadata(mut bytes: Vec<u8>) -> Vec<u8> {
    assert_eq!(&bytes[..4], b"II\x2a\0");
    let old_root = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut entries = directory_entries(&bytes, old_root);

    let mut exif = Ifd::new();
    exif.add_ascii(36867, CAPTURED); // DateTimeOriginal
    exif.add_short(34855, 400); // ISO
    let exif_offset = bytes.len() as u32;
    exif.serialise_into(&mut bytes, exif_offset);

    let mut gps = Ifd::new();
    gps.add_bytes(0, vec![2, 3, 0, 0]); // GPSVersionID
    gps.add_ascii(1, "N");
    gps.add_rationals(2, vec![(51, 1), (30, 1), (0, 1)]);
    gps.add_ascii(3, "W");
    gps.add_rationals(4, vec![(0, 1), (7, 1), (30, 1)]);
    let gps_offset = bytes.len() as u32;
    gps.serialise_into(&mut bytes, gps_offset);

    let mut metadata = Ifd::new();
    metadata.add_long(34665, exif_offset);
    metadata.add_long(34853, gps_offset);
    metadata.add_ascii(315, ARTIST);
    metadata.add_bytes(700, XMP.to_vec());
    let metadata_offset = bytes.len();
    metadata.serialise_into(&mut bytes, metadata_offset as u32);
    entries.extend(directory_entries(&bytes, metadata_offset));
    entries.sort_by_key(|entry| u16::from_le_bytes(entry[..2].try_into().unwrap()));
    assert!(entries.windows(2).all(|pair| pair[0][..2] != pair[1][..2]));

    // Keep every original absolute payload/strip offset intact. Both old and
    // newly serialized overflow blocks stay where their entries point.
    let root = bytes.len() as u32;
    bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for entry in entries {
        bytes.extend_from_slice(&entry);
    }
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&root.to_le_bytes());
    bytes
}

fn directory_entries(bytes: &[u8], offset: usize) -> Vec<Vec<u8>> {
    let count = u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
    bytes[offset + 2..offset + 2 + count * 12]
        .chunks_exact(12)
        .map(<[u8]>::to_vec)
        .collect()
}

pub(super) fn assert_source_metadata(bytes: &[u8]) {
    let exif = crate::api::read_exif(bytes, "dng").unwrap();
    assert_eq!(exif.captured_at.as_deref(), Some(CAPTURED));
    assert_eq!(exif.iso, Some(400));
    let gps = exif
        .gps
        .expect("source GPS must exist before testing stripping");
    assert_eq!(gps.lat_deg, 51.5);
    assert_eq!(gps.lon_deg, -0.125);
    let tiff = GenericTiffReader::new_with_buffer(bytes, 0, 0, None).unwrap();
    let root = tiff.root_ifd();
    let exif = rawler::exif::Exif::new(root).unwrap();
    assert_eq!(exif.artist.as_deref(), Some(ARTIST));
    assert_eq!(
        &root.get_entry(700u16).unwrap().value,
        &Value::Byte(XMP.to_vec())
    );
}

pub(super) fn assert_stripped(bytes: &[u8], format: &str) {
    // Also reject metadata carriers which ImageDecoder does not expose,
    // including JPEG comments and PNG compressed text (which could hide XMP).
    if format == "jpeg" {
        assert_eq!(&bytes[..2], b"\xff\xd8");
        let mut at = 2;
        while at < bytes.len() {
            assert_eq!(bytes[at], 0xff);
            let marker = bytes[at + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            assert!(
                ![0xe1, 0xed, 0xfe].contains(&marker),
                "source metadata carrier"
            );
            let len = u16::from_be_bytes(bytes[at + 2..at + 4].try_into().unwrap()) as usize;
            at += 2 + len;
        }
    } else if format == "png" {
        let decoder = png::Decoder::new(Cursor::new(bytes));
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert!(info.uncompressed_latin1_text.is_empty());
        assert!(info.compressed_latin1_text.is_empty());
        assert!(info.utf8_text.is_empty());
        assert!(info.exif_metadata.is_none());
    }
    for sentinel in [CAPTURED.as_bytes(), ARTIST.as_bytes(), XMP] {
        assert!(!bytes.windows(sentinel.len()).any(|chunk| chunk == sentinel));
    }
}
