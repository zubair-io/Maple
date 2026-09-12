//! Unit tests for [`super`] — edited-image export encoding (JPEG/PNG/TIFF16/
//! AVIF/WebP, ICC tagging, raster passthrough). Split out of `export.rs`
//! under the 570-line file-size budget (#3503 Task D6 pushed it to 578);
//! same `#[path]` sibling pattern `view/encode.rs` and `stages/blur.rs` use.
//! Contents moved verbatim, `super` is `export`.

use super::*;

fn ramp_u8(width: u32, height: u32) -> Vec<u8> {
    (0..(width as usize * height as usize * 3))
        .map(|i| (i % 256) as u8)
        .collect()
}

#[test]
fn format_wire_spellings_round_trip() {
    assert_eq!(ExportFormat::from_str("jpeg"), Some(ExportFormat::Jpeg));
    assert_eq!(ExportFormat::from_str("tiff"), Some(ExportFormat::Tiff16));
    assert_eq!(ExportFormat::from_str("png"), Some(ExportFormat::Png));
    assert_eq!(ExportFormat::from_str("heic"), None);
    assert_eq!(ExportFormat::from_str(""), None);
}

#[test]
fn tiff_is_the_only_sixteen_bit_container() {
    assert_eq!(ExportFormat::Tiff16.depth(), ExportDepth::Sixteen);
    assert_eq!(ExportFormat::Jpeg.depth(), ExportDepth::Eight);
    assert_eq!(ExportFormat::Png.depth(), ExportDepth::Eight);
}

#[test]
fn jpeg_encodes_with_a_soi_marker_and_embeds_the_profile() {
    let rgb = ramp_u8(8, 8);
    let profile = icc::profile_for(TargetPrimaries::P3);
    let bytes = encode_jpeg(8, 8, &rgb, 92, profile).unwrap();
    assert_eq!(&bytes[..2], &[0xFF, 0xD8], "not a JPEG");
    // The ICC APP2 payload is introduced by this exact identifier.
    assert!(
        bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
        "no ICC profile embedded in the JPEG"
    );
}

#[test]
fn png_encodes_with_a_signature_and_an_iccp_chunk() {
    let rgb = ramp_u8(8, 8);
    let profile = icc::profile_for(TargetPrimaries::P3);
    let bytes = encode_png(8, 8, &rgb, profile).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
    assert!(
        bytes.windows(4).any(|w| w == b"iCCP"),
        "no ICC profile chunk in the PNG"
    );
}

#[test]
fn tiff16_encodes_with_a_tiff_magic_and_full_width_samples() {
    let rgb: Vec<u16> = (0..8 * 8 * 3).map(|i| (i * 257) as u16).collect();
    let profile = icc::profile_for(TargetPrimaries::Srgb);
    let bytes = encode_tiff16(8, 8, &rgb, profile).unwrap();
    let little_endian = &bytes[..4] == b"II*\0";
    let big_endian = &bytes[..4] == b"MM\0*";
    assert!(little_endian || big_endian, "not a TIFF");
    // 16-bit RGB for 64 pixels is 384 bytes of pixel data alone; a buffer
    // anywhere near 192 would mean the samples were narrowed to 8-bit.
    assert!(bytes.len() > 384, "TIFF too small to hold 16-bit samples");
}

#[test]
fn quality_outside_the_valid_range_is_clamped_not_rejected() {
    let rgb = ramp_u8(4, 4);
    let profile = icc::profile_for(TargetPrimaries::Srgb);
    assert!(encode_jpeg(4, 4, &rgb, 0, profile.clone()).is_ok());
    assert!(encode_jpeg(4, 4, &rgb, 200, profile).is_ok());
}

#[test]
fn a_buffer_that_disagrees_with_the_dimensions_is_rejected() {
    let profile = icc::profile_for(TargetPrimaries::Srgb);
    assert!(encode_jpeg(8, 8, &[0u8; 10], 92, profile.clone()).is_err());
    assert!(encode_png(8, 8, &[0u8; 10], profile.clone()).is_err());
    assert!(encode_tiff16(8, 8, &[0u16; 10], profile).is_err());
}

/// Lower JPEG quality must actually produce a smaller file — otherwise the
/// quality control in the UI is inert.
#[test]
fn lower_jpeg_quality_produces_a_smaller_file() {
    // Noise compresses differently at different quality settings; a flat
    // ramp can quantize to the same size at neighbouring qualities.
    let rgb: Vec<u8> = (0..64 * 64 * 3)
        .map(|i| ((i * 2654435761usize) >> 13) as u8)
        .collect();
    let profile = icc::profile_for(TargetPrimaries::Srgb);
    let high = encode_jpeg(64, 64, &rgb, 95, profile.clone()).unwrap();
    let low = encode_jpeg(64, 64, &rgb, 40, profile).unwrap();
    assert!(
        low.len() < high.len(),
        "quality 40 ({} bytes) should be smaller than quality 95 ({} bytes)",
        low.len(),
        high.len()
    );
}

/// The two colour-space options must produce different bytes; if the
/// primaries choice were dropped somewhere the files would be identical.
#[test]
fn the_two_colour_spaces_tag_differently() {
    let rgb = ramp_u8(8, 8);
    let srgb = encode_jpeg(8, 8, &rgb, 92, icc::profile_for(TargetPrimaries::Srgb)).unwrap();
    let p3 = encode_jpeg(8, 8, &rgb, 92, icc::profile_for(TargetPrimaries::P3)).unwrap();
    assert_ne!(srgb, p3);
}

#[test]
fn avif_plus_display_p3_is_rejected_as_a_bitmap_encode_error() {
    // The message must NOT open with "unsupported RAW format" — this is a
    // bitmap encode path, where the only RAW in sight is the caller's own
    // pixel buffer (#3503 review I3).
    let err = reject_untagged_avif_p3(ExportFormat::Avif, TargetPrimaries::P3)
        .expect_err("AVIF + P3 must be rejected");
    let text = format!("{err}");
    assert!(
        text.starts_with("bitmap encode unsupported:"),
        "got: {text}"
    );
    assert!(text.contains("Display P3"), "got: {text}");
    // Every other combination still encodes.
    assert!(reject_untagged_avif_p3(ExportFormat::Avif, TargetPrimaries::Srgb).is_ok());
    assert!(reject_untagged_avif_p3(ExportFormat::Jpeg, TargetPrimaries::P3).is_ok());
}

#[test]
fn webp_lossless_encodes_valid_riff_header() {
    let rgb = ramp_u8(8, 8);
    let webp_bytes = encode_webp(8, 8, &rgb, TargetPrimaries::Srgb).unwrap();
    assert_eq!(&webp_bytes[..4], b"RIFF");
    assert_eq!(&webp_bytes[8..12], b"WEBP");
}

/// Pinned against the pre-#3503-fix-round-1 encoder (no `set_icc_profile`
/// call at all for sRGB): `encode_webp(8, 8, ramp_u8(8, 8), Srgb)` used to
/// produce exactly 160 bytes hashing to this blake3 digest. sRGB WebP
/// output must stay untagged and byte-identical — only Display P3 output
/// gains an `ICCP` chunk (below).
#[test]
fn srgb_webp_output_is_byte_identical_to_before_the_icc_fix() {
    let rgb = ramp_u8(8, 8);
    let bytes = encode_webp(8, 8, &rgb, TargetPrimaries::Srgb).unwrap();
    assert_eq!(bytes.len(), 160, "sRGB WebP length drifted");
    assert_eq!(
        blake3::hash(&bytes).to_hex().as_str(),
        "612bac6112c52a10b11db072f595bac8a810a89feea1b2696a404dac933ced44",
        "sRGB WebP bytes drifted from the pre-fix encoder"
    );
    assert!(
        !bytes.windows(4).any(|w| w == b"ICCP"),
        "sRGB WebP must stay untagged"
    );
}

#[test]
fn p3_webp_output_carries_the_display_p3_icc_profile() {
    let rgb = ramp_u8(8, 8);
    let bytes = encode_webp(8, 8, &rgb, TargetPrimaries::P3).unwrap();
    let profile = icc::profile_for(TargetPrimaries::P3);
    assert!(
        bytes.windows(4).any(|w| w == b"ICCP"),
        "Display P3 WebP is missing its ICCP chunk"
    );
    assert!(
        bytes
            .windows(profile.len())
            .any(|w| w == profile.as_slice()),
        "the embedded chunk does not match icc::profile_for(P3)"
    );
}

#[test]
fn encode_raster_supports_all_formats() {
    let raster = crate::raster::RasterImage::new_rgb(4, 4, ramp_u8(4, 4));
    assert!(encode_raster(&raster, ExportFormat::Jpeg, 90).is_ok());
    assert!(encode_raster(&raster, ExportFormat::Png, 90).is_ok());
    assert!(encode_raster(&raster, ExportFormat::Tiff16, 90).is_ok());
    assert!(encode_raster(&raster, ExportFormat::Webp, 90).is_ok());
}
