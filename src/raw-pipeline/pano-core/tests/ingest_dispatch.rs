//! Integration tests for T2.1 — `pano_core::ingest` format dispatch.
//!
//! These tests exercise the format sniffer and the decode dispatcher.  Real
//! decoding is done with synthetic byte buffers where possible; the RAW arm
//! (TIFF magic) is skip-passed when no DNG fixture is present so that CI
//! without the gitignored `test-fixtures/raws/` tree doesn't fail spuriously.

use pano_core::{decode_bytes, decode_input, sniff_format, PanoError, PanoFormat, PanoInput};

// ---------------------------------------------------------------------------
// sniff_format — format detection from magic bytes
// ---------------------------------------------------------------------------

#[test]
fn sniff_format_detects_png() {
    let magic = b"\x89PNG\r\n\x1a\n"; // standard PNG signature
    assert_eq!(sniff_format(magic), PanoFormat::Png);
}

#[test]
fn sniff_format_detects_jpeg() {
    let magic = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];
    assert_eq!(sniff_format(magic), PanoFormat::Jpeg);
}

#[test]
fn sniff_format_detects_tiff_le_as_raw() {
    // Intel byte-order TIFF (DNG, NEF, ARW, CR2 all use little-endian II).
    let magic = &[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
    assert_eq!(sniff_format(magic), PanoFormat::Raw);
}

#[test]
fn sniff_format_detects_tiff_be_as_raw() {
    // Motorola byte-order TIFF (used by some older scanner RAWs).
    let magic = &[0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08];
    assert_eq!(sniff_format(magic), PanoFormat::Raw);
}

#[test]
fn sniff_format_returns_unknown_for_garbage() {
    assert_eq!(
        sniff_format(&[0x00, 0x01, 0x02, 0x03, 0x04]),
        PanoFormat::Unknown
    );
}

#[test]
fn sniff_format_returns_unknown_for_empty() {
    assert_eq!(sniff_format(&[]), PanoFormat::Unknown);
}

#[test]
fn sniff_format_returns_unknown_for_too_short() {
    assert_eq!(sniff_format(&[0xFF, 0xD8]), PanoFormat::Unknown);
}

#[test]
fn sniff_format_detects_heif() {
    // HEIF/HEIC: 4 size bytes, then "ftyp".
    let mut magic = [0u8; 8];
    magic[0..4].copy_from_slice(&[0x00, 0x00, 0x00, 0x18]); // box size = 24
    magic[4..8].copy_from_slice(b"ftyp");
    assert_eq!(sniff_format(&magic), PanoFormat::Heif);
}

// ---------------------------------------------------------------------------
// decode_input — PanoInput::Decoded passthrough
// ---------------------------------------------------------------------------

#[test]
fn decode_input_decoded_passthrough() {
    use bitvec::vec::BitVec;
    use pano_core::types::PanoImage;
    use pano_core::ColorSpace;

    let img = PanoImage {
        pixels: vec![0.1, 0.2, 0.3],
        width: 1,
        height: 1,
        color: ColorSpace::rec2020_d65_linear(),
        validity: BitVec::repeat(true, 1),
    };
    let input = PanoInput::Decoded(img.clone());
    let out = decode_input(&input).expect("Decoded passthrough should not fail");
    assert_eq!(out.width, 1);
    assert_eq!(out.height, 1);
    assert_eq!(&out.pixels, &img.pixels);
}

// ---------------------------------------------------------------------------
// decode_bytes — PNG path via the `image` crate
// ---------------------------------------------------------------------------

/// Build a minimal valid 1×1 white PNG in sRGB to test the PNG decode path.
fn make_tiny_png(r: u8, g: u8, b: u8) -> Vec<u8> {
    use image::{ImageBuffer, Rgb};
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(1, 1, Rgb([r, g, b]));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .expect("PNG encode should not fail");
    buf.into_inner()
}

#[test]
fn decode_bytes_routes_png_through_image_crate() {
    let png_bytes = make_tiny_png(255, 0, 0); // sRGB red
    let pano = decode_bytes(&png_bytes).expect("PNG decode should succeed");
    assert_eq!(pano.width, 1);
    assert_eq!(pano.height, 1);
    assert_eq!(pano.pixels.len(), 3); // R, G, B
                                      // R channel should be noticeably larger than G and B after sRGB linearise
                                      // and sRGB→Rec.2020 matrix.  We don't check exact values because the
                                      // matrix slightly redistributes energy, but R in Rec.2020 space remains
                                      // clearly dominant for a pure sRGB red input.
    assert!(
        pano.pixels[0] > pano.pixels[1] + 0.05,
        "expected R > G+0.05 in Rec.2020 for sRGB red; got R={:.4} G={:.4}",
        pano.pixels[0],
        pano.pixels[1],
    );
    // All pixels valid.
    assert!(pano.validity.iter().all(|b| *b));
}

#[test]
fn decode_bytes_white_png_stays_near_white_in_rec2020() {
    let png_bytes = make_tiny_png(255, 255, 255); // sRGB white
    let pano = decode_bytes(&png_bytes).expect("PNG white decode should succeed");
    // White in sRGB linear = (1,1,1), which through M_SRGB_TO_REC2020 maps
    // to exactly (1,1,1) because both primaries share the D65 white point.
    for ch in pano.pixels.iter().copied() {
        assert!(
            (ch - 1.0).abs() < 0.01,
            "expected near 1.0 for sRGB white in Rec.2020, got {ch:.4}"
        );
    }
}

// ---------------------------------------------------------------------------
// decode_bytes — JPEG path
// ---------------------------------------------------------------------------

/// Build a minimal valid 1×1 JPEG (lossy, so we allow more tolerance).
fn make_tiny_jpeg(r: u8, g: u8, b: u8) -> Vec<u8> {
    use image::{ImageBuffer, Rgb};
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(1, 1, Rgb([r, g, b]));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("JPEG encode should not fail");
    buf.into_inner()
}

#[test]
fn decode_bytes_routes_jpeg_through_image_crate() {
    let jpeg_bytes = make_tiny_jpeg(128, 128, 128);
    let pano = decode_bytes(&jpeg_bytes).expect("JPEG decode should succeed");
    assert_eq!(pano.width, 1);
    assert_eq!(pano.height, 1);
    assert_eq!(pano.pixels.len(), 3);
    // All channels near-equal for a grey input (within JPEG quantisation).
    let r = pano.pixels[0];
    let g = pano.pixels[1];
    let b = pano.pixels[2];
    assert!(
        (r - g).abs() < 0.05 && (r - b).abs() < 0.05,
        "expected neutral grey, got R={r:.4} G={g:.4} B={b:.4}"
    );
}

#[test]
fn decode_bytes_returns_error_on_invalid_jpeg_bytes() {
    // JPEG magic + garbage payload — must fail gracefully.
    let mut bad_jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
    bad_jpeg.extend_from_slice(&[0x00; 64]); // garbage beyond magic
    match decode_bytes(&bad_jpeg) {
        Err(PanoError::Decode(_)) => {}
        other => panic!("expected PanoError::Decode, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// decode_bytes — RAW/TIFF path (skip-pass without fixture)
// ---------------------------------------------------------------------------

#[test]
fn decode_bytes_routes_raw_to_raw_core() {
    // Look for the reference DNG at the standard gitignored location.
    // The path is relative to the workspace root (two levels up from this
    // crate's Cargo.toml).
    let fixture = std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/raws/dji-mavic3pro-100mp.dng"
    ));
    if !fixture.exists() {
        eprintln!(
            "decode_bytes_routes_raw_to_raw_core: skipping — fixture not found at {}",
            fixture.display()
        );
        return; // soft skip, like the Rust parity harness
    }

    let bytes = std::fs::read(fixture).expect("fixture read should succeed");
    // Verify the sniffer classifies it as Raw before full decode.
    assert_eq!(
        sniff_format(&bytes),
        PanoFormat::Raw,
        "DNG fixture should sniff as Raw"
    );
    let pano = decode_bytes(&bytes).expect("DNG decode should succeed");
    assert!(pano.width > 0 && pano.height > 0);
    assert_eq!(
        pano.pixels.len(),
        (pano.width as usize) * (pano.height as usize) * 3
    );
}

// ---------------------------------------------------------------------------
// decode_bytes — Unknown / HEIF error paths
// ---------------------------------------------------------------------------

#[test]
fn decode_bytes_returns_error_on_unknown_format() {
    let garbage = b"not any known format at all!!!";
    match decode_bytes(garbage) {
        Err(PanoError::Decode(_)) => {}
        other => panic!("expected PanoError::Decode for unknown format, got {other:?}"),
    }
}

#[test]
fn decode_bytes_returns_error_for_heif_without_feature() {
    // Synthesise a "HEIF" magic byte sequence.
    let mut heif_magic = [0u8; 12];
    heif_magic[0..4].copy_from_slice(&[0x00, 0x00, 0x00, 0x18]);
    heif_magic[4..8].copy_from_slice(b"ftyp");
    heif_magic[8..12].copy_from_slice(b"heic");

    // Whether the `heif` feature is on or off this must return an error
    // (the feature exists but is unimplemented).
    let result = decode_bytes(&heif_magic);
    assert!(
        result.is_err(),
        "HEIF decode should always return an error at this stage"
    );
}
