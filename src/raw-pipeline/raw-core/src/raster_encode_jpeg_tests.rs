use super::*;

fn noise(w: u32, h: u32) -> RasterImage {
    // Structured noise: a flat ramp can quantise identically at
    // neighbouring settings and hide a real difference.
    let data = (0..(w as usize * h as usize * 3))
        .map(|i| ((i * 2_654_435_761usize) >> 13) as u8)
        .collect();
    RasterImage::new_rgb(w, h, data)
}

fn opts() -> JpegOptions {
    JpegOptions {
        quality: 80,
        progressive: false,
        chroma_subsampling: ChromaSubsampling::Yuv420,
        optimise_coding: true,
    }
}

/// Scan for a JPEG marker byte in the header area.
fn has_marker(bytes: &[u8], marker: u8) -> bool {
    bytes.windows(2).any(|w| w[0] == 0xFF && w[1] == marker)
}

/// Walk a JPEG's marker segments up to (not including) the first scan,
/// returning `(marker byte, payload)` pairs. `payload` is the segment body
/// after the 2-byte length field, matching what `jpeg_encoder`'s
/// `write_segment` receives as `data`. Markers with no length field (SOI,
/// EOI, the restart markers, TEM) are skipped rather than returned.
fn walk_markers(bytes: &[u8]) -> Vec<(u8, &[u8])> {
    let mut segments = Vec::new();
    let mut i = 2; // past SOI (FF D8)
    while i + 1 < bytes.len() {
        assert_eq!(bytes[i], 0xFF, "expected a marker at offset {i}");
        let marker = bytes[i + 1];
        let no_length_field =
            marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker);
        if no_length_field {
            i += 2;
            continue;
        }
        if marker == 0xDA {
            break; // start of scan: everything after is entropy-coded data
        }
        let length = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        let payload = &bytes[i + 4..i + 2 + length];
        segments.push((marker, payload));
        i += 2 + length;
    }
    segments
}

#[test]
fn encodes_a_baseline_jpeg_that_decodes_back() {
    let src = noise(32, 32);
    let bytes = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
    assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    assert!(has_marker(&bytes, 0xC0), "expected a baseline SOF0");
    let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
    assert_eq!((decoded.width, decoded.height), (32, 32));
}

#[test]
fn progressive_writes_sof2_and_still_decodes() {
    let bytes = encode_jpeg_opts(
        &noise(32, 32),
        &JpegOptions {
            progressive: true,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(has_marker(&bytes, 0xC2), "expected a progressive SOF2");
    let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
    assert_eq!((decoded.width, decoded.height), (32, 32));
}

#[test]
fn four_four_four_is_larger_than_four_two_zero_at_the_same_quality() {
    let src = noise(64, 64);
    let subsampled = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
    let full = encode_jpeg_opts(
        &src,
        &JpegOptions {
            chroma_subsampling: ChromaSubsampling::Yuv444,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(
        full.len() > subsampled.len(),
        "4:4:4 ({}) should be larger than 4:2:0 ({})",
        full.len(),
        subsampled.len()
    );
}

#[test]
fn optimised_huffman_tables_shrink_the_file() {
    let src = noise(64, 64);
    let plain = encode_jpeg_opts(
        &src,
        &JpegOptions {
            optimise_coding: false,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    let optimised = encode_jpeg_opts(&src, &opts(), None, None, None).unwrap();
    assert!(
        optimised.len() < plain.len(),
        "optimised ({}) should beat default tables ({})",
        optimised.len(),
        plain.len()
    );
}

#[test]
fn lower_quality_produces_a_smaller_file() {
    let src = noise(64, 64);
    let high = encode_jpeg_opts(
        &src,
        &JpegOptions {
            quality: 95,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    let low = encode_jpeg_opts(
        &src,
        &JpegOptions {
            quality: 40,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(low.len() < high.len());
}

#[test]
fn the_three_metadata_segments_are_embedded() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let xmp = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/>"#.to_vec();
    let bytes =
        encode_jpeg_opts(&noise(16, 16), &opts(), Some(&icc), Some(&exif), Some(&xmp)).unwrap();
    assert!(
        bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
        "no ICC APP2"
    );
    assert!(bytes.windows(6).any(|w| w == b"Exif\0\0"), "no EXIF APP1");
    assert!(
        bytes
            .windows(29)
            .any(|w| w == b"http://ns.adobe.com/xap/1.0/\0"),
        "no XMP APP1"
    );
}

/// The Exif specification wants its APP1 first in the file, and sharp writes
/// EXIF, then XMP, then the ICC APP2 (measured: `APP1(Exif), APP1(XMP),
/// APP2(ICC_PROFILE), SOF0`). `jpeg-encoder` emits these in call order, so
/// the order is a property of `encode_jpeg_opts`'s three `add_*` calls and
/// needs pinning — it was ICC first until this test existed.
#[test]
fn the_metadata_segments_are_written_exif_then_xmp_then_icc() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let xmp = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/>"#.to_vec();
    let bytes =
        encode_jpeg_opts(&noise(16, 16), &opts(), Some(&icc), Some(&exif), Some(&xmp)).unwrap();
    let kinds: Vec<&str> = walk_markers(&bytes)
        .into_iter()
        .filter_map(|(marker, payload)| match marker {
            0xE1 if payload.starts_with(b"Exif\0\0") => Some("exif"),
            0xE1 if payload.starts_with(b"http://ns.adobe.com/xap/1.0/\0") => Some("xmp"),
            0xE2 if payload.starts_with(b"ICC_PROFILE\0") => Some("icc"),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, vec!["exif", "xmp", "icc"], "APP segment order");
}

#[test]
fn a_four_channel_raster_is_rejected_rather_than_silently_flattened() {
    let rgba = RasterImage::new_rgba(2, 2, vec![0; 16]);
    assert!(encode_jpeg_opts(&rgba, &opts(), None, None, None).is_err());
}

#[test]
fn dimensions_beyond_the_jpeg_limit_are_rejected() {
    // JPEG's SOF carries 16-bit dimensions; 65536 does not fit.
    let wide = RasterImage {
        width: 65_536,
        height: 1,
        channels: 3,
        data: vec![0; 65_536 * 3],
        orientation: crate::image::ExifOrientation::Normal,
    };
    assert!(encode_jpeg_opts(&wide, &opts(), None, None, None).is_err());
}

// --- Deferred from the F1 review: parse-level assertions, not just marker
// presence, for the SOF sampling factors and the metadata segment bytes.

#[test]
fn sof_sampling_factors_are_2_2_for_420_and_1_1_for_444() {
    let src = noise(32, 32);
    for (subsampling, expected_sampling_byte) in [
        (ChromaSubsampling::Yuv420, 0x22u8),
        (ChromaSubsampling::Yuv444, 0x11u8),
    ] {
        let bytes = encode_jpeg_opts(
            &src,
            &JpegOptions {
                chroma_subsampling: subsampling,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap();
        let segments = walk_markers(&bytes);
        let (_, sof) = segments
            .iter()
            .find(|(marker, _)| *marker == 0xC0)
            .expect("expected a baseline SOF0 segment");
        // Layout: precision(1) height(2) width(2) num_components(1), then
        // per component id(1) sampling(1) quant_table(1). The Y component
        // (RGB is always encoded as YCbCr) is component 0.
        let num_components = sof[5];
        assert!(num_components >= 1, "SOF has no components");
        let y_sampling = sof[7];
        assert_eq!(
            y_sampling, expected_sampling_byte,
            "{subsampling:?}: expected Y sampling byte {expected_sampling_byte:#04x}, got {y_sampling:#04x}"
        );
    }
}

#[test]
fn a_70kb_icc_profile_is_split_into_two_app2_chunks_that_reassemble_exactly() {
    // jpeg_encoder chunks ICC profiles at 65535 - 2 - 12 - 2 = 65519 bytes
    // per APP2 segment; 70,000 bytes needs exactly two chunks.
    let icc: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
    let bytes = encode_jpeg_opts(&noise(8, 8), &opts(), Some(&icc), None, None).unwrap();
    let icc_segments: Vec<&[u8]> = walk_markers(&bytes)
        .into_iter()
        .filter(|(marker, payload)| *marker == 0xE2 && payload.starts_with(b"ICC_PROFILE\0"))
        .map(|(_, payload)| payload)
        .collect();
    assert_eq!(icc_segments.len(), 2, "expected two APP2 ICC chunks");

    let mut reassembled = Vec::new();
    for (i, segment) in icc_segments.iter().enumerate() {
        let seq = segment[12];
        let count = segment[13];
        assert_eq!(seq, i as u8 + 1, "chunk {i} has the wrong sequence number");
        assert_eq!(count, 2, "chunk {i} has the wrong chunk count");
        reassembled.extend_from_slice(&segment[14..]);
    }
    assert_eq!(
        reassembled, icc,
        "reassembled ICC profile does not match the input"
    );
}

#[test]
fn exif_and_xmp_payload_bytes_match_the_input_exactly() {
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x03\x00\x00\x01\x0f\x00\x02\x00".to_vec();
    let xmp = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/>"#.to_vec();
    let bytes = encode_jpeg_opts(&noise(16, 16), &opts(), None, Some(&exif), Some(&xmp)).unwrap();

    let app1_segments: Vec<&[u8]> = walk_markers(&bytes)
        .into_iter()
        .filter(|(marker, _)| *marker == 0xE1)
        .map(|(_, payload)| payload)
        .collect();

    let exif_segment = app1_segments
        .iter()
        .find(|payload| payload.starts_with(b"Exif\0\0"))
        .expect("no EXIF APP1 segment");
    assert_eq!(&exif_segment[6..], exif.as_slice());

    let xmp_segment = app1_segments
        .iter()
        .find(|payload| payload.starts_with(XMP_NAMESPACE))
        .expect("no XMP APP1 segment");
    assert_eq!(&xmp_segment[XMP_NAMESPACE.len()..], xmp.as_slice());
}
