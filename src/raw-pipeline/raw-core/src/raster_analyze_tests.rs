//! Tests for [`super`] (#3507, Task G4): the `analyze` request/reply shape,
//! its metadata/stats content, and its error paths. Split from
//! `raster_analyze.rs` per the file-size budget.
//!
//! Fixtures are hand-built (no binary files committed), mirroring
//! `raster_meta_tests.rs`'s approach but not reusing its `pub(super)`
//! helpers directly: those are scoped to the `raster_meta` module tree,
//! and this module needs an RGBA (alpha-carrying) PNG the `raster_meta`
//! fixtures don't build.

use super::*;

const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
const XMP_PACKET: &[u8] = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#;

fn png_itxt_xmp_payload(xmp: &[u8]) -> Vec<u8> {
    let mut payload = b"XML:com.adobe.xmp\0".to_vec();
    payload.push(0); // compression flag: uncompressed
    payload.push(0); // compression method
    payload.push(0); // language tag: empty, NUL-terminated
    payload.push(0); // translated keyword: empty, NUL-terminated
    payload.extend_from_slice(xmp);
    payload
}

/// A 4x2 RGBA PNG (half fully-opaque, half half-transparent) carrying an
/// ICC profile, an EXIF block and an XMP packet, spliced in via the `png`
/// crate's own `Writer::write_chunk` (which computes the CRC) — same
/// mechanism `raster_meta_png_tests.rs` uses, but RGBA so `hasAlpha`/
/// `isOpaque` have something real to report.
fn png_with_metadata() -> Vec<u8> {
    let (width, height) = (4u32, 2u32);
    let data: Vec<u8> = (0..width * height)
        .flat_map(|i| [10 * i as u8, 20, 30, if i < 4 { 255 } else { 128 }])
        .collect();
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut iccp_payload = b"maple\0".to_vec();
        iccp_payload.push(0); // compression method: deflate, always 0
        iccp_payload.extend(miniz_oxide::deflate::compress_to_vec_zlib(&icc, 6));
        writer.write_chunk(png::chunk::iCCP, &iccp_payload).unwrap();
        writer.write_chunk(png::chunk::eXIf, EXIF_TIFF).unwrap();
        writer
            .write_chunk(png::chunk::iTXt, &png_itxt_xmp_payload(XMP_PACKET))
            .unwrap();
        writer.write_image_data(&data).unwrap();
    }
    out
}

/// A baseline opaque JPEG with a hand-spliced APP1 EXIF and a single-chunk
/// APP2 ICC segment right after the SOI marker — same shape
/// `raster_meta_jpeg_tests.rs` exercises, kept local since those builders
/// are `pub(super)` to `raster_meta`.
fn jpeg_with_exif_and_icc() -> Vec<u8> {
    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let length = (payload.len() + 2) as u16;
        let mut seg = vec![0xFF, marker];
        seg.extend_from_slice(&length.to_be_bytes());
        seg.extend_from_slice(payload);
        seg
    }

    let base = crate::jpeg::encode(4, 2, &vec![128u8; 4 * 2 * 3], 90).unwrap();
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);

    let mut exif_payload = b"Exif\0\0".to_vec();
    exif_payload.extend_from_slice(EXIF_TIFF);

    let mut icc_payload = b"ICC_PROFILE\0".to_vec();
    icc_payload.push(1); // sequence number
    icc_payload.push(1); // chunk count
    icc_payload.extend_from_slice(&icc);

    let mut out = base[..2].to_vec();
    out.extend(jpeg_segment(0xE1, &exif_payload));
    out.extend(jpeg_segment(0xE2, &icc_payload));
    out.extend_from_slice(&base[2..]);
    out
}

fn parse(json: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap()
}

#[test]
fn metadata_reports_the_header_and_the_blocks() {
    let reply = parse(&analyze(&png_with_metadata(), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    let meta = &reply["metadata"];
    assert_eq!(meta["width"], 4);
    assert_eq!(meta["height"], 2);
    assert_eq!(meta["format"], "png");
    assert_eq!(meta["channels"], 4);
    assert_eq!(meta["hasAlpha"], true);
    assert_eq!(meta["hasProfile"], true);
    assert_eq!(meta["space"], "srgb");
    assert!(
        meta["icc"].as_str().unwrap().len() > 16,
        "icc should be base64"
    );
    assert!(meta["exif"].as_str().is_some());
    assert!(meta["xmp"].as_str().is_some());
}

#[test]
fn metadata_alone_does_not_carry_a_stats_key() {
    let reply = parse(&analyze(&png_with_metadata(), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    assert!(reply.get("stats").is_none());
}

#[test]
fn stats_reports_every_channel_plus_the_whole_image_numbers() {
    let reply = parse(&analyze(&png_with_metadata(), r#"{"v":1,"what":["stats"]}"#).unwrap());
    let stats = &reply["stats"];
    assert_eq!(stats["channels"].as_array().unwrap().len(), 4);
    assert_eq!(stats["isOpaque"], false);
    assert!(stats["entropy"].as_f64().unwrap() > 0.0);
    assert!(stats["dominant"]["r"].as_u64().is_some());
    let red = &stats["channels"][0];
    for key in [
        "min",
        "max",
        "sum",
        "squaresSum",
        "mean",
        "stdev",
        "minX",
        "maxY",
    ] {
        assert!(red.get(key).is_some(), "channel stats missing {key}");
    }
}

#[test]
fn both_can_be_asked_for_at_once() {
    let reply = parse(
        &analyze(
            &png_with_metadata(),
            r#"{"v":1,"what":["metadata","stats"]}"#,
        )
        .unwrap(),
    );
    assert!(reply.get("metadata").is_some() && reply.get("stats").is_some());
}

#[test]
fn a_bad_request_is_rejected() {
    assert!(analyze(&png_with_metadata(), "{not json").is_err());
    assert!(analyze(&png_with_metadata(), r#"{"v":9,"what":["metadata"]}"#).is_err());
    assert!(analyze(&png_with_metadata(), r#"{"v":1,"what":["vibes"]}"#).is_err());
}

#[test]
fn an_unknown_request_field_is_rejected() {
    // `#[serde(deny_unknown_fields)]`: a stray field must fail parsing, not
    // be silently ignored.
    let bytes = png_with_metadata();
    assert!(analyze(&bytes, r#"{"v":1,"what":["metadata"],"extra":true}"#).is_err());
}

#[test]
fn base64_matches_the_reference_vectors() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    assert_eq!(base64(&[0xFF, 0xFE, 0xFD]), "//79");
}

#[test]
fn metadata_reads_exif_and_icc_from_a_jpeg() {
    let reply =
        parse(&analyze(&jpeg_with_exif_and_icc(), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    let meta = &reply["metadata"];
    assert_eq!(meta["format"], "jpeg");
    assert_eq!(meta["channels"], 3);
    assert_eq!(meta["hasAlpha"], false);
    assert_eq!(meta["hasProfile"], true);
    // `read_sidecars` strips the `Exif\0\0` intro, so the block that comes
    // back (and gets base64-encoded here) is exactly `EXIF_TIFF`.
    assert_eq!(meta["exif"].as_str(), Some(base64(EXIF_TIFF).as_str()));
}

#[test]
fn a_corrupt_buffer_is_rejected_not_panicked() {
    assert!(analyze(b"not an image", r#"{"v":1,"what":["metadata"]}"#).is_err());
    assert!(analyze(&[], r#"{"v":1,"what":["stats"]}"#).is_err());
}

#[cfg(feature = "avif")]
#[test]
fn metadata_and_stats_both_work_on_a_real_avif() {
    let rgb: Vec<u8> = std::iter::repeat([200u8, 24, 24])
        .take(4 * 2)
        .flatten()
        .collect();
    let bytes = crate::avif::encode(4, 2, &rgb, 80).unwrap();
    let reply = parse(&analyze(&bytes, r#"{"v":1,"what":["metadata","stats"]}"#).unwrap());
    assert_eq!(reply["metadata"]["format"], "avif");
    assert_eq!(reply["metadata"]["width"], 4);
    assert_eq!(reply["metadata"]["height"], 2);
    assert_eq!(reply["stats"]["channels"].as_array().unwrap().len(), 3);
}
