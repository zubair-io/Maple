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

/// An 8-bit RGB TIFF, written with `image`'s `TiffEncoder` directly at
/// `ExtendedColorType::Rgb8` — this crate's own TIFF *encoder*
/// (`crate::tiff::encode_from_u8`/`raster_recipe_encode::encode_tiff_with_metadata`)
/// always writes 16-bit samples, so an 8-bit TIFF only ever shows up here as
/// somebody else's file; `metadata()` must still read it correctly rather
/// than assuming every TIFF this crate sees is one it wrote itself.
fn tiff_8bit(width: u32, height: u32) -> Vec<u8> {
    use image::codecs::tiff::TiffEncoder;
    use image::ImageEncoder;
    let rgb = vec![128u8; (width * height * 3) as usize];
    let mut out = Vec::new();
    TiffEncoder::new(std::io::Cursor::new(&mut out))
        .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    out
}

/// A 16-bit RGB TIFF, via this crate's own real 16-bit TIFF encoder
/// (`crate::tiff::encode_from_u8`) — the same path `export.rs`'s RAW-develop
/// pipeline uses, not a fixture built just for this test.
fn tiff_16bit(width: u32, height: u32) -> Vec<u8> {
    let rgb = vec![128u8; (width * height * 3) as usize];
    crate::tiff::encode_from_u8(width, height, &rgb).unwrap()
}

/// A 16-bit RGB PNG. The `png` crate's `write_image_data` writes the bytes
/// given verbatim — no bit-depth-aware conversion — so a 16-bit sample must
/// be supplied as its two big-endian bytes, per the PNG spec (`image`'s own
/// PNG *decoder*, which `depth_value` reads back through, does do that
/// conversion on read).
fn png_16bit(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 3 * 2) as usize);
    for _ in 0..(width * height * 3) {
        data.extend_from_slice(&30000u16.to_be_bytes());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Sixteen);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&data).unwrap();
    }
    out
}

#[test]
fn depth_reports_uchar_for_an_8bit_tiff() {
    let reply = parse(&analyze(&tiff_8bit(2, 2), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    assert_eq!(reply["metadata"]["format"], "tiff");
    assert_eq!(reply["metadata"]["depth"], "uchar");
}

#[test]
fn depth_reports_ushort_for_a_16bit_tiff() {
    let reply = parse(&analyze(&tiff_16bit(2, 2), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    assert_eq!(reply["metadata"]["format"], "tiff");
    assert_eq!(reply["metadata"]["depth"], "ushort");
}

#[test]
fn depth_reports_uchar_for_the_8bit_metadata_fixture_png() {
    // `png_with_metadata()` above is an 8-bit RGBA PNG — pins the "not every
    // PNG is 16-bit" side of the same check.
    let reply = parse(&analyze(&png_with_metadata(), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    assert_eq!(reply["metadata"]["depth"], "uchar");
}

#[test]
fn depth_reports_ushort_for_a_16bit_png() {
    let reply = parse(&analyze(&png_16bit(2, 2), r#"{"v":1,"what":["metadata"]}"#).unwrap());
    assert_eq!(reply["metadata"]["format"], "png");
    assert_eq!(reply["metadata"]["depth"], "ushort");
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
    // `read_sidecars` canonicalises to the bare TIFF header internally, but
    // `metadata()` hands the block back in the form its container stored it
    // — introduced, for a JPEG — because that is the form sharp returns
    // (#3507 final fix wave, item 3; measured 186 bytes starting
    // `Exif\0\0II*` against sharp 0.34.5's 186 on the same input, where
    // Maple used to return 180 starting `II*`).
    let stored = [b"Exif\0\0".as_slice(), EXIF_TIFF].concat();
    assert_eq!(meta["exif"].as_str(), Some(base64(&stored).as_str()));
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

#[test]
fn an_oversized_metadata_block_is_reported_absent() {
    // Everything in the reply is base64'd into one JSON document, so a
    // block has to be bounded before it reaches the FFI (#3507 final fix
    // wave, item 5). At the ceiling it still goes out; one byte over, it's
    // reported absent rather than as an error.
    let cap = crate::raster_meta::MAX_SIDECAR_BYTES;
    let block = vec![0u8; cap + 1];
    assert!(capped(Some(&block)).is_none());
    assert!(capped(Some(&block[..cap])).is_some());
    assert!(capped(None).is_none());
}

#[test]
fn metadata_reports_no_exif_for_a_tiff() {
    // sharp returns no `exif` for a TIFF; this used to return the whole
    // file (#3507 final fix wave, item 5).
    let bytes = {
        let mut out = b"II\x2a\x00".to_vec();
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // zero IFD0 entries
        out.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        out
    };
    // A zero-entry TIFF has no image, so go straight at the sidecar reader
    // rather than through `analyze` (which probes dimensions first).
    assert_eq!(crate::raster_meta::read_sidecars(&bytes).exif, None);
}
