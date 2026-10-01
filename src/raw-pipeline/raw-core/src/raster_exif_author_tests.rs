use super::*;
use rawler::formats::tiff::{reader::TiffReader, GenericTiffReader, Rational, Value};

fn tags(json: &str) -> ExifTags {
    serde_json::from_str(json).unwrap()
}

fn reader(bytes: &[u8]) -> GenericTiffReader {
    GenericTiffReader::new(
        &mut std::io::Cursor::new(bytes),
        0,
        0,
        Some(16),
        &[0x8769, 0x8825, 0xa005],
    )
    .unwrap()
}

#[test]
fn all_five_ifds_are_readable_by_the_independent_tiff_reader() {
    let source = author_exif(&tags(r#"{
      "IFD0":{"Copyright":"Photographer © 2026","Orientation":"6","XResolution":"300/1"},
      "IFD1":{"Software":"thumbnail"},
      "IFD2":{"DateTimeOriginal":"2026:10:01 12:30:00","ExposureTime":"1/125","ExposureBiasValue":"-1/3","ComponentsConfiguration":"1 2 3 0"},
      "IFD3":{"GPSLatitudeRef":"N","GPSLatitude":"51/1 30/1 3230/100"},
      "IFD4":{"InteroperabilityIndex":"R98"}
    }"#), None).unwrap();
    let decoded = reader(&source);
    let root = decoded.root_ifd();
    assert_eq!(
        root.get_entry(0x8298u16)
            .unwrap()
            .value
            .as_string()
            .unwrap(),
        "Photographer © 2026"
    );
    assert_eq!(
        root.get_entry(0x0112u16).unwrap().value,
        Value::Short(vec![6])
    );
    assert_eq!(
        decoded.chains()[1]
            .get_entry(0x0131u16)
            .unwrap()
            .value
            .as_string()
            .unwrap(),
        "thumbnail"
    );
    assert_eq!(
        root.get_entry_recursive(0x829au16).unwrap().value,
        Value::Rational(vec![Rational { n: 1, d: 125 }])
    );
    assert_eq!(
        root.get_entry_recursive(0x9101u16).unwrap().value,
        Value::Undefined(vec![1, 2, 3, 0])
    );
    let gps = &root.sub[&0x8825][0];
    assert_eq!(
        gps.get_entry(2u16).unwrap().value,
        Value::Rational(vec![
            Rational { n: 51, d: 1 },
            Rational { n: 30, d: 1 },
            Rational { n: 3230, d: 100 }
        ])
    );
    let exif = &root.sub[&0x8769][0];
    let offset = match exif.get_entry(0xa005u16).unwrap().value {
        Value::Long(ref offsets) => offsets[0],
        _ => panic!("Interop pointer must be LONG"),
    };
    let interop = rawler::formats::tiff::IFD::new(
        &mut std::io::Cursor::new(&source),
        offset,
        0,
        0,
        rawler::bits::Endian::Little,
        &[],
    )
    .unwrap();
    assert_eq!(
        interop.get_entry(1u16).unwrap().value.as_string().unwrap(),
        "R98"
    );
}

#[test]
fn merge_preserves_unknown_payloads_makernote_offsets_and_original_input_bytes() {
    let mut source = author_exif(&tags(r#"{"IFD0":{"Copyright":"Original","Artist":"opaque root value"},"IFD2":{"MakerNote":"private camera bytes","ExposureTime":"1/250"}}"#), None).unwrap();
    // Foreign unknown tag with an out-of-line payload. Change only its identifier.
    let root = u32::from_le_bytes(source[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(source[root..root + 2].try_into().unwrap()) as usize;
    for at in (root + 2..root + 2 + count * 12).step_by(12) {
        if u16::from_le_bytes(source[at..at + 2].try_into().unwrap()) == 0x013b {
            source[at..at + 2].copy_from_slice(&0xcffeu16.to_le_bytes());
        }
    }
    let snapshot = source.clone();
    let result = author_exif(
        &tags(
            r#"{"IFD0":{"Copyright":"Replacement with a longer value"},"IFD2":{"FNumber":"2.8"}}"#,
        ),
        Some(&source),
    )
    .unwrap();
    assert_eq!(source, snapshot);
    assert_eq!(&result[8..source.len()], &source[8..]);
    let before = reader(&source);
    let after = reader(&result);
    assert_eq!(
        after.root_ifd().get_entry(0xcffeu16).unwrap().value,
        before.root_ifd().get_entry(0xcffeu16).unwrap().value
    );
    assert_eq!(
        after
            .root_ifd()
            .get_entry_recursive(0x927cu16)
            .unwrap()
            .value,
        before
            .root_ifd()
            .get_entry_recursive(0x927cu16)
            .unwrap()
            .value
    );
    assert_eq!(
        after
            .root_ifd()
            .get_entry(0x8298u16)
            .unwrap()
            .value
            .as_string()
            .unwrap(),
        "Replacement with a longer value"
    );
    assert_eq!(
        after
            .root_ifd()
            .get_entry_recursive(0x829du16)
            .unwrap()
            .value,
        Value::Rational(vec![Rational { n: 14, d: 5 }])
    );
}

#[test]
fn merge_uses_the_source_byte_order_and_accepts_prefixed_exif_blocks() {
    let source = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0";
    let prefixed: Vec<u8> = b"Exif\0\0".iter().chain(source).copied().collect();
    let result = author_exif(&tags(r#"{"IFD0":{"Copyright":"Big endian"},"IFD2":{"ExposureTime":"1/60"},"IFD3":{"GPSAltitude":"123/10"}}"#), Some(&prefixed)).unwrap();
    assert!(result.starts_with(b"MM\0\x2a"));
    let decoded = reader(&result);
    assert_eq!(
        decoded.root_ifd().get_entry(0x0112u16).unwrap().value,
        Value::Short(vec![6])
    );
    assert_eq!(
        decoded
            .root_ifd()
            .get_entry_recursive(0x829au16)
            .unwrap()
            .value,
        Value::Rational(vec![Rational { n: 1, d: 60 }])
    );
    assert_eq!(&result[8..source.len()], &source[8..]);
}

#[test]
fn merge_preserves_foreign_ifd_continuations_and_rejects_cycles() {
    let mut source = author_exif(&tags(r#"{"IFD1":{"Software":"thumbnail"}}"#), None).unwrap();
    let order = ByteOrder(true);
    let (directories, _) = read_directories(&source, order).unwrap();
    let tail = append_ifd(&mut source, order, &directories[1], 0).unwrap();
    let root = reader(&source).root_ifd().offset as usize;
    let root_count = order.read16(&source[root..root + 2]) as usize;
    let thumbnail =
        order.read32(&source[root + 2 + root_count * 12..root + 6 + root_count * 12]) as usize;
    let thumbnail_count = order.read16(&source[thumbnail..thumbnail + 2]) as usize;
    let next_at = thumbnail + 2 + thumbnail_count * 12;
    source[next_at..next_at + 4].copy_from_slice(&order.u32(tail));
    let result = author_exif(&tags(r#"{"IFD0":{"Copyright":"new"}}"#), Some(&source)).unwrap();
    let decoded = reader(&result);
    assert_eq!(decoded.chains().len(), 3);
    assert_eq!(decoded.chains()[2].offset, tail);
    assert_eq!(&result[8..source.len()], &source[8..]);
    source[next_at..next_at + 4].copy_from_slice(&order.u32(thumbnail as u32));
    assert!(author_exif(&ExifTags::new(), Some(&source)).is_err());
}

#[test]
fn merge_keeps_an_embedded_jpeg_thumbnail_at_its_original_offset() {
    let mut source = author_exif(&tags(r#"{"IFD1":{"Software":"thumbnail"}}"#), None).unwrap();
    let order = ByteOrder(true);
    let (mut directories, _) = read_directories(&source, order).unwrap();
    let thumbnail = crate::jpeg::encode(2, 2, &[90; 12], 85).unwrap();
    let image_at = source.len() as u32;
    source.extend(&thumbnail);
    link(&mut directories[1], 0x0201, image_at, order);
    link(&mut directories[1], 0x0202, thumbnail.len() as u32, order);
    let ifd1 = append_ifd(&mut source, order, &directories[1], 0).unwrap();
    let root = append_ifd(&mut source, order, &directories[0], ifd1).unwrap();
    source[4..8].copy_from_slice(&order.u32(root));
    let result = author_exif(&tags(r#"{"IFD1":{"Software":"updated"}}"#), Some(&source)).unwrap();
    let (merged, _) = read_directories(&result, order).unwrap();
    assert_eq!(pointer(&merged[1], 0x0201, order).unwrap(), image_at);
    assert_eq!(
        pointer(&merged[1], 0x0202, order).unwrap(),
        thumbnail.len() as u32
    );
    assert_eq!(
        &result[image_at as usize..image_at as usize + thumbnail.len()],
        &thumbnail
    );
    assert_eq!(&result[8..source.len()], &source[8..]);
}

#[test]
fn user_comment_and_xp_author_preserve_unicode_with_their_declared_encodings() {
    let result = author_exif(
        &tags(r#"{"IFD0":{"XPAuthor":"Zoë 📷"},"IFD2":{"UserComment":"Café 📷"}}"#),
        None,
    )
    .unwrap();
    let decoded = reader(&result);
    let xp: Vec<u8> = "Zoë 📷"
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(
        decoded.root_ifd().get_entry(40093u16).unwrap().value,
        Value::Byte(xp)
    );
    let comment: Vec<u8> = b"UNICODE\0"
        .iter()
        .copied()
        .chain("Café 📷".encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    assert_eq!(
        decoded
            .root_ifd()
            .get_entry_recursive(0x9286u16)
            .unwrap()
            .value,
        Value::Undefined(comment)
    );
}

#[test]
fn malformed_sources_and_invalid_authored_values_fail_without_panics() {
    let source = author_exif(
        &tags(r#"{"IFD0":{"Copyright":"Original"},"IFD3":{"GPSLatitude":"1/1 2/1 3/1"}}"#),
        None,
    )
    .unwrap();
    for length in 0..source.len() {
        let result =
            std::panic::catch_unwind(|| author_exif(&ExifTags::new(), Some(&source[..length])));
        assert!(result.is_ok(), "truncation at {length}");
        assert!(result.unwrap().is_err(), "truncation at {length}");
    }
    for json in [
        r#"{"IFD9":{"Copyright":"x"}}"#,
        r#"{"IFD0":{"UnknownTag":"x"}}"#,
        r#"{"IFD0":{"Orientation":"65536"}}"#,
        r#"{"IFD2":{"ExposureTime":"NaN"}}"#,
        r#"{"IFD3":{"GPSLatitude":"1/1 2/1"}}"#,
        r#"{"IFD0":{"ExifIFDPointer":"123"}}"#,
    ] {
        assert!(author_exif(&tags(json), None).is_err(), "{json}");
    }
}
