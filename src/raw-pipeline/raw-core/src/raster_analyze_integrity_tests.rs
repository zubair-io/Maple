use super::*;

const REQUEST: &str = r#"{"v":1,"what":["integrity"]}"#;
const DNG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/batch-transfer/source.dng"
));

#[test]
fn integrity_decodes_a_png_that_cannot_be_reencoded_as_jpeg() {
    let bytes = crate::png::encode(65_536, 1, &vec![128; 65_536 * 3]).unwrap();
    assert_eq!(analyze(&bytes, REQUEST).unwrap(), r#"{"integrity":true}"#);
}

#[test]
fn integrity_rejects_corrupt_pixels_even_when_metadata_is_valid() {
    let mut bytes = crate::png::encode(8, 4, &vec![128; 8 * 4 * 3]).unwrap();
    let idat = bytes.windows(4).position(|chunk| chunk == b"IDAT").unwrap();
    let length = u32::from_be_bytes(bytes[idat - 4..idat].try_into().unwrap()) as usize;
    bytes[idat + 4..idat + 4 + length].fill(0);
    let metadata = crate::raster::probe_raster_metadata(&bytes).unwrap();
    assert_eq!((metadata.width, metadata.height), (8, 4));
    let error = analyze(&bytes, REQUEST).unwrap_err().to_string();
    assert!(!error.is_empty());
    assert!(!error.contains("request"), "{error}");
}

#[test]
fn integrity_accepts_a_real_dng_with_or_without_an_extension_hint() {
    for request in [
        REQUEST,
        r#"{"v":1,"what":["integrity"],"rawExtension":"DNG"}"#,
    ] {
        assert_eq!(analyze(DNG, request).unwrap(), r#"{"integrity":true}"#);
    }
}

#[test]
fn integrity_reports_the_raw_decoder_failure() {
    let request = r#"{"v":1,"what":["integrity"],"rawExtension":"dng"}"#;
    let error = analyze(&DNG[..128], request).unwrap_err().to_string();
    assert!(error.contains("decode"), "{error}");
    assert!(!error.contains("request"), "{error}");
}

#[cfg(feature = "avif")]
#[test]
fn integrity_fully_decodes_avif_and_rejects_a_truncated_payload() {
    let bytes = crate::avif::encode(24, 16, &vec![128; 24 * 16 * 3], 60).unwrap();
    assert_eq!(analyze(&bytes, REQUEST).unwrap(), r#"{"integrity":true}"#);
    assert!(analyze(&bytes[..bytes.len() / 2], REQUEST).is_err());
}
