//! PNG metadata chunk walker shared by byte and seekable input (#3620).

use super::*;

/// Walk PNG chunks. `iCCP` is a NUL-terminated name, a compression byte, then
/// a zlib stream; `iTXt` is keyword, compression flag/method, language and
/// translated keyword, then the text — see `parse_png_itxt_xmp`.
pub(super) fn read_png<S: MetadataSource + ?Sized>(bytes: &S) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut idx = 8usize;
    loop {
        let Some(length_end) = idx.checked_add(4) else {
            break;
        };
        let Some(length_bytes) = bytes.get(idx..length_end) else {
            break;
        };
        let length = u32::from_be_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ]) as usize;
        let Some(kind_end) = length_end.checked_add(4) else {
            break;
        };
        let Some(kind) = bytes.get(length_end..kind_end) else {
            break;
        };
        let Some(payload_end) = kind_end.checked_add(length) else {
            break;
        };
        if !bytes.contains(kind_end..payload_end) {
            break;
        }
        if !matches!(
            kind.as_ref(),
            b"eXIf" | b"iCCP" | b"iTXt" | b"tEXt" | b"zTXt" | b"pHYs"
        ) {
            if matches!(kind.as_ref(), b"IDAT" | b"IEND") {
                break;
            }
            let Some(next) = payload_end.checked_add(4) else {
                break;
            };
            idx = next;
            continue;
        }
        let Some(payload) = bytes.get(kind_end..payload_end) else {
            break;
        };
        match kind.as_ref() {
            b"eXIf" => {
                // PNG stores the TIFF header bare (and that is what libvips
                // writes), but canonicalise anyway so a non-conforming
                // writer's introduced block doesn't reach an encoder.
                let (tiff, introduced) = canonical_exif(&payload);
                found.exif = Some(tiff.to_vec());
                found.exif_intro = introduced;
            }
            b"iCCP" => {
                if let Some(nul) = payload.iter().position(|&b| b == 0) {
                    // payload[nul + 1] is the compression method (always 0).
                    found.icc = nul
                        .checked_add(2)
                        .and_then(|start| payload.get(start..))
                        .and_then(inflate_bounded);
                }
            }
            b"iTXt" if payload.starts_with(PNG_XMP_KEYWORD) => {
                found.xmp = parse_png_itxt_xmp(&payload[PNG_XMP_KEYWORD.len()..]);
            }
            // libvips writes PNG XMP as an uncompressed `tEXt` chunk under
            // the same keyword, not the `iTXt` this crate's own encoder
            // writes — so a sharp-written PNG's XMP was invisible here
            // (measured: sharp read 313 bytes, Maple none). `tEXt` has no
            // compression or language fields: the text follows the keyword
            // directly.
            b"tEXt" if payload.starts_with(PNG_XMP_KEYWORD) => {
                found.xmp = Some(payload[PNG_XMP_KEYWORD.len()..].to_vec());
            }
            // `zTXt` is `tEXt` with the text zlib-deflated behind a
            // compression-method byte. sharp reads XMP out of one
            // (measured: 313 bytes from a hand-built zTXt PNG), so this
            // does too.
            b"zTXt" if payload.starts_with(PNG_XMP_KEYWORD) => {
                found.xmp = payload
                    .get(PNG_XMP_KEYWORD.len()..)
                    .filter(|rest| rest.first() == Some(&0))
                    .and_then(|rest| rest.get(1..))
                    .and_then(inflate_bounded);
            }
            b"pHYs" if payload.len() >= 9 => {
                // Both via pixels per millimetre, the unit libvips itself
                // carries, so the ubiquitous `pHYs` of 1000 px/m lands on
                // exactly 25.4 dpi and is suppressed rather than landing a
                // floating-point hair above it.
                let per_unit =
                    u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as f64;
                found.density = Some(match payload[8] {
                    1 => per_unit / 1000.0 * 25.4, // unit specifier: metre
                    // Unit 0 means the two values are an aspect ratio with
                    // no physical unit, and libvips reads the X value as
                    // px/mm regardless (measured: a `pHYs` of 3:1 with unit
                    // 0 reads back through sharp as 76, which is 3 × 25.4
                    // rounded).
                    _ => per_unit * 25.4,
                });
            }
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        // The chunk's 4-byte CRC follows its data and isn't otherwise read.
        let Some(next) = payload_end.checked_add(4) else {
            break;
        };
        idx = next;
    }
    // Same precedence and default as a JPEG's: an `eXIf` resolution wins
    // over `pHYs` (measured: a PNG carrying a 300 dpi `pHYs` and a 25.4 dpi
    // `eXIf` reads back as no density at all through sharp), and a PNG with
    // no `pHYs` at all is 72 dpi — measured: sharp reports 72 for a PNG
    // this crate's own encoder wrote, which writes no `pHYs` unless asked.
    found.density = found
        .exif
        .as_deref()
        .and_then(exif_resolution_dpi)
        .or(found.density)
        .or(Some(DEFAULT_DPI))
        .and_then(reportable_density);
    found
}

/// `iTXt` payload after the keyword+NUL: compression flag, compression
/// method, language tag + NUL, translated keyword + NUL, then the text —
/// plain UTF-8 when the flag is `0`, or a zlib stream (method `0`, the only
/// one PNG defines) when the flag is `1`. Any other flag/method combination
/// isn't a form this reads.
fn parse_png_itxt_xmp(rest: &[u8]) -> Option<Vec<u8>> {
    let flag = *rest.first()?;
    let method = *rest.get(1)?;
    let after_header = rest.get(2..)?;
    let first_nul = after_header.iter().position(|&b| b == 0)?;
    let lang_end = first_nul.checked_add(1)?;
    let translated = after_header.get(lang_end..)?;
    let second_nul = translated.iter().position(|&b| b == 0)?;
    let text_start = lang_end.checked_add(second_nul)?.checked_add(1)?;
    let text = after_header.get(text_start..)?;
    match (flag, method) {
        (0, _) => Some(text.to_vec()),
        (1, 0) => inflate_bounded(text),
        _ => None,
    }
}

/// Inflate a zlib stream, giving up at [`MAX_SIDECAR_BYTES`].
///
/// PNG's compressed chunks are attacker-controlled input with an
/// unbounded expansion ratio: measured before this, a crafted
/// 66,516-byte PNG whose `iCCP` inflated to 64 MB made `metadata()`
/// return a 67,108,864-byte `icc` in 1,826 ms, to be base64'd into the
/// JSON reply at another ~85 MB (#3507 final fix wave, item 8). Over the
/// ceiling the block is reported absent, the same as a corrupt stream —
/// sharp rejects the same file outright ("pngload_buffer: reached
/// chunk/cache limits"), so neither library hands the expansion back.
fn inflate_bounded(zlib: &[u8]) -> Option<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(zlib, MAX_SIDECAR_BYTES).ok()
}
