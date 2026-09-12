use super::*;

/// A `n`x`n` image using exactly `k` distinct colours, in a repeating
/// pattern so a quantiser cannot get lucky.
fn palette_art(n: u32, k: u32) -> RasterImage {
    let data = (0..n * n)
        .flat_map(|i| {
            let c = (i % k) as u8;
            [c * 40, 255 - c * 40, 128]
        })
        .collect();
    RasterImage::new_rgb(n, n, data)
}

fn opts() -> PngOptions {
    PngOptions {
        compression_level: 6,
        adaptive_filtering: false,
        palette: false,
        colours: 256,
        dither: 1.0,
    }
}

#[test]
fn encodes_a_truecolour_png_that_round_trips() {
    let src = palette_art(16, 5);
    let bytes = encode_png_opts(&src, &opts(), None, None, None).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!(decoded.data, src.data, "truecolour PNG must be lossless");
}

#[test]
fn rgba_round_trips_losslessly() {
    let src = RasterImage::new_rgba(2, 1, vec![10, 20, 30, 255, 40, 50, 60, 0]);
    let bytes = encode_png_opts(&src, &opts(), None, None, None).unwrap();
    let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!((decoded.channels, decoded.data), (4, src.data));
}

#[test]
fn a_higher_compression_level_produces_a_smaller_file() {
    let src = palette_art(64, 7);
    let fast = encode_png_opts(
        &src,
        &PngOptions {
            compression_level: 1,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    let best = encode_png_opts(
        &src,
        &PngOptions {
            compression_level: 9,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(
        best.len() <= fast.len(),
        "level 9 ({}) vs level 1 ({})",
        best.len(),
        fast.len()
    );
}

/// The `png` crate offers three zlib tiers, not ten levels, so sharp's 0-9
/// collapses onto them — and the split has to put sharp's own default of 6 on
/// zlib 6 (`Default`), not on `best()`. It used to sit on `best()`: measured
/// at 1024×1024 (gradient plus noise), the default encode took 7901 ms for
/// 929 732 B where zlib 6 takes 2934 ms for 962 544 B — 2.7× slower for
/// 3.5% fewer bytes, with nobody having asked for it.
///
/// Asserted through file bytes rather than on `compression_for` directly, so
/// the test still means something if the mapping moves behind another API.
#[test]
fn compression_level_six_sits_on_zlibs_default_tier_not_best() {
    let src = palette_art(64, 7);
    let at = |compression_level: u8| {
        encode_png_opts(
            &src,
            &PngOptions {
                compression_level,
                ..opts()
            },
            None,
            None,
            None,
        )
        .unwrap()
    };
    // Tier boundaries: 0 alone, then 1..=6, then 7..=9.
    assert_eq!(
        at(1),
        at(6),
        "levels 1 and 6 must share zlib's default tier"
    );
    assert_eq!(at(7), at(9), "levels 7 and 9 must share zlib's best tier");
    assert_ne!(
        at(6),
        at(7),
        "level 7 must cross into the best tier, level 6 must not"
    );
    assert_ne!(at(0), at(1), "level 0 must be its own fastest tier");
}

#[test]
fn a_palette_png_is_indexed_and_smaller() {
    let src = palette_art(64, 6);
    let truecolour = encode_png_opts(&src, &opts(), None, None, None).unwrap();
    let indexed = encode_png_opts(
        &src,
        &PngOptions {
            palette: true,
            colours: 16,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(indexed.windows(4).any(|w| w == b"PLTE"), "no palette chunk");
    assert!(indexed.len() < truecolour.len());
}

#[test]
fn a_palette_png_is_exact_when_the_image_fits_the_palette() {
    // 6 distinct colours into a 16-entry palette: no loss is possible.
    let src = palette_art(32, 6);
    let bytes = encode_png_opts(
        &src,
        &PngOptions {
            palette: true,
            colours: 16,
            dither: 0.0,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!(decoded.to_rgb_bytes(), src.data);
}

#[test]
fn a_palette_png_keeps_transparency() {
    let data = (0..16u32)
        .flat_map(|i| [200u8, 40, 40, if i % 2 == 0 { 255 } else { 0 }])
        .collect();
    let src = RasterImage::new_rgba(4, 4, data);
    let bytes = encode_png_opts(
        &src,
        &PngOptions {
            palette: true,
            colours: 8,
            dither: 0.0,
            ..opts()
        },
        None,
        None,
        None,
    )
    .unwrap();
    assert!(
        bytes.windows(4).any(|w| w == b"tRNS"),
        "no transparency chunk"
    );
    let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
    assert_eq!(decoded.channels, 4);
    assert_eq!(decoded.data[3], 255);
    assert_eq!(decoded.data[7], 0);
}

#[test]
fn the_metadata_chunks_are_embedded() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#.to_vec();
    let bytes = encode_png_opts(
        &palette_art(8, 3),
        &opts(),
        Some(&icc),
        Some(&exif),
        Some(&xmp),
    )
    .unwrap();
    assert!(bytes.windows(4).any(|w| w == b"iCCP"), "no iCCP chunk");
    assert!(bytes.windows(4).any(|w| w == b"eXIf"), "no eXIf chunk");
    assert!(
        bytes.windows(4).any(|w| w == b"iTXt"),
        "no iTXt chunk for XMP"
    );
}

#[test]
fn an_out_of_range_colour_count_is_rejected() {
    let src = palette_art(8, 3);
    assert!(encode_png_opts(
        &src,
        &PngOptions {
            palette: true,
            colours: 1,
            ..opts()
        },
        None,
        None,
        None
    )
    .is_err());
    assert!(encode_png_opts(
        &src,
        &PngOptions {
            palette: true,
            colours: 300,
            ..opts()
        },
        None,
        None,
        None
    )
    .is_err());
}

#[test]
fn an_invalid_dither_is_rejected() {
    let src = palette_art(8, 3);
    for bad in [f64::NAN, -0.1, 1.1, f64::INFINITY, f64::NEG_INFINITY] {
        let err = encode_png_opts(
            &src,
            &PngOptions {
                dither: bad,
                ..opts()
            },
            None,
            None,
            None,
        )
        .expect_err(&format!("dither {bad} should be rejected"));
        assert!(
            format!("{err}").contains(&bad.to_string()),
            "error should name the rejected value {bad}: {err}"
        );
    }
}

// --- CRC-checked, ordering-checked chunk walk (Fix round 1, finding #1) ---
//
// `the_metadata_chunks_are_embedded` above only substring-searches for
// marker bytes. This independently re-parses the PNG chunk stream byte by
// byte, re-derives every chunk's CRC-32 from scratch (not trusting the
// encoder that produced it), and checks payload bytes and chunk ordering.

/// CRC-32 (the ISO 3309 / zlib / PNG polynomial), implemented from scratch
/// rather than pulled in as a dependency: `crc32fast` is only a transitive
/// dependency of `raw-core` (via `png`/`flate2`/others), not a direct one,
/// so re-checking a chunk's CRC independently of the encoder that wrote it
/// means not trusting that same transitive crate to grade its own work.
fn crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0usize;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

fn crc32(bytes: &[u8]) -> u32 {
    let table = crc32_table();
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc = table[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

struct Chunk<'a> {
    /// Byte offset of this chunk's length field, for ordering checks.
    offset: usize,
    ctype: [u8; 4],
    data: &'a [u8],
}

/// Walk `length:4 type:4 data:length crc:4` chunks from byte 8 (past the
/// PNG signature), verifying every chunk's CRC-32 (over type + data) against
/// its stored value as it goes.
fn walk_chunks(bytes: &[u8]) -> Vec<Chunk<'_>> {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "missing PNG signature");
    let mut chunks = Vec::new();
    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        let ctype: [u8; 4] = bytes[i + 4..i + 8].try_into().unwrap();
        let data = &bytes[i + 8..i + 8 + len];
        let stored_crc = u32::from_be_bytes(bytes[i + 8 + len..i + 12 + len].try_into().unwrap());
        let computed_crc = crc32(&bytes[i + 4..i + 8 + len]); // type + data
        assert_eq!(
            computed_crc,
            stored_crc,
            "bad CRC on {} chunk at offset {i}",
            String::from_utf8_lossy(&ctype)
        );
        chunks.push(Chunk {
            offset: i,
            ctype,
            data,
        });
        i += 12 + len;
    }
    chunks
}

#[test]
fn metadata_chunks_are_crc_clean_and_round_trip_exactly_before_the_first_idat() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#.to_vec();
    let bytes = encode_png_opts(
        &palette_art(8, 3),
        &opts(),
        Some(&icc),
        Some(&exif),
        Some(&xmp),
    )
    .unwrap();

    // Every chunk's CRC is checked as a side effect of walking them.
    let chunks = walk_chunks(&bytes);

    let idat_offset = chunks
        .iter()
        .find(|c| &c.ctype == b"IDAT")
        .map(|c| c.offset)
        .expect("no IDAT chunk");

    let exif_chunk = chunks
        .iter()
        .find(|c| &c.ctype == b"eXIf")
        .expect("no eXIf chunk");
    assert!(exif_chunk.offset < idat_offset, "eXIf must precede IDAT");
    assert_eq!(exif_chunk.data, exif.as_slice(), "eXIf payload mismatch");

    let itxt_chunk = chunks
        .iter()
        .find(|c| &c.ctype == b"iTXt")
        .expect("no iTXt chunk");
    assert!(itxt_chunk.offset < idat_offset, "iTXt must precede IDAT");
    // iTXt layout: keyword\0 compression_flag(1) compression_method(1)
    // language_tag\0 translated_keyword\0 text.
    let kw_end = itxt_chunk.data.iter().position(|&b| b == 0).unwrap();
    assert_eq!(&itxt_chunk.data[..kw_end], XMP_KEYWORD.as_bytes());
    let compression_flag = itxt_chunk.data[kw_end + 1];
    let compression_method = itxt_chunk.data[kw_end + 2];
    assert_eq!(
        (compression_flag, compression_method),
        (0, 0),
        "expected an uncompressed iTXt chunk (flag 0, method 0)"
    );
    let rest = &itxt_chunk.data[kw_end + 3..];
    let lang_end = rest.iter().position(|&b| b == 0).unwrap();
    let rest = &rest[lang_end + 1..];
    let tk_end = rest.iter().position(|&b| b == 0).unwrap();
    let text = &rest[tk_end + 1..];
    assert_eq!(
        text,
        xmp.as_slice(),
        "iTXt text does not match the input XMP bytes"
    );

    let iccp_chunk = chunks
        .iter()
        .find(|c| &c.ctype == b"iCCP")
        .expect("no iCCP chunk");
    assert!(iccp_chunk.offset < idat_offset, "iCCP must precede IDAT");
    // iCCP layout: profile_name\0 compression_method(1) compressed_profile.
    let name_end = iccp_chunk.data.iter().position(|&b| b == 0).unwrap();
    let compression_method = iccp_chunk.data[name_end + 1];
    assert_eq!(compression_method, 0, "unexpected iCCP compression method");
    let compressed = &iccp_chunk.data[name_end + 2..];
    let inflated = miniz_oxide::inflate::decompress_to_vec_zlib(compressed)
        .expect("iCCP payload does not inflate as zlib");
    assert_eq!(
        inflated, icc,
        "iCCP payload does not inflate to the input ICC profile"
    );
}
