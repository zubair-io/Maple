//! Read the metadata blocks a container carries (#3507), so `metadata()` can
//! report them and `keepMetadata()` can hand them straight back to an encoder.
//!
//! * JPEG: APP1 `Exif\0\0`, APP2 `ICC_PROFILE\0` (reassembled across its
//!   chunk sequence — see `assemble_icc_chunks` for how a dropped or
//!   duplicated chunk is caught rather than silently mis-joined), APP1
//!   `http://ns.adobe.com/xap/1.0/\0` for XMP, and the APP0 JFIF density.
//!   Marker codes may be preceded by `0xFF` fill bytes, and standalone
//!   markers (`RSTn`, `TEM`) carry no length field — both are handled.
//! * PNG: `eXIf`, `iCCP` (zlib-deflated), `iTXt` with the
//!   `XML:com.adobe.xmp` keyword (plain or zlib-compressed, per its own
//!   compression flag), and `pHYs` for density.
//! * TIFF: the IFD0 `InterColorProfile` (34675) and `XMLPacket` (700) tags,
//!   with the whole file standing in as the EXIF block. Only a byte-sized
//!   TIFF type (BYTE/ASCII/UNDEFINED) is trusted to mean "the declared count
//!   is a byte length".
//! * WebP: the `EXIF`, `ICCP` and `XMP ` RIFF chunks.
//!
//! AVIF is handled separately (Task G2) — its metadata lives in ISO-BMFF
//! item boxes, not in a chunk stream.
//!
//! Everything here is READ-ONLY and allocation-light: a container with no
//! metadata costs one linear scan of its header. Every offset comes from
//! `get(..)` fed by `checked_add`/`checked_mul` arithmetic, never direct
//! index arithmetic or unchecked `+` that could panic — or, on the 32-bit
//! `usize` of the wasm32 target this crate also builds for, silently wrap
//! into a bogus-but-in-bounds offset — on a truncated or hostile file. A
//! corrupt container yields `None` fields, not a panic (see
//! `raster_meta_tests.rs`'s truncation sweep).

/// Metadata blocks a container carries, in their canonical byte form: the
/// EXIF block starts at the TIFF header (`II*\0` / `MM\0*`), the ICC profile
/// is the raw profile, the XMP packet is the XML.
// No `Eq`: `density` is an `Option<f64>`, and `f64` has no total order (NaN),
// so it cannot implement `Eq` — `PartialEq` is what `assert_eq!` needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RasterSidecars {
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
    /// Pixels per inch, when the container states one.
    pub density: Option<f64>,
}

const EXIF_INTRO: &[u8] = b"Exif\0\0";
const ICC_INTRO: &[u8] = b"ICC_PROFILE\0";
const XMP_INTRO: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const PNG_XMP_KEYWORD: &[u8] = b"XML:com.adobe.xmp\0";

/// Dispatch on the container's magic bytes and walk its chunk/segment
/// stream for EXIF, ICC, XMP and pixel density. Anything unrecognised, or
/// too short to carry a valid header, reports every field `None`.
pub fn read_sidecars(bytes: &[u8]) -> RasterSidecars {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return read_jpeg(bytes);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return read_png(bytes);
    }
    if bytes.starts_with(b"II\x2a\x00") || bytes.starts_with(b"MM\x00\x2a") {
        return read_tiff(bytes);
    }
    if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return read_webp(bytes);
    }
    RasterSidecars::default()
}

/// Walk JPEG marker segments from the SOI to the SOS, collecting APP1/APP2.
fn read_jpeg(bytes: &[u8]) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut icc_chunks: Vec<(u8, u8, Vec<u8>)> = Vec::new();
    let mut idx = 2usize;
    'segments: loop {
        if bytes.get(idx) != Some(&0xFF) {
            break;
        }
        // A marker may be preceded by a run of 0xFF fill bytes (padding some
        // encoders emit) before the real, non-0xFF code byte.
        let mut code_idx = idx;
        while bytes.get(code_idx) == Some(&0xFF) {
            let Some(next) = code_idx.checked_add(1) else {
                break 'segments;
            };
            code_idx = next;
        }
        let Some(&marker) = bytes.get(code_idx) else {
            break;
        };
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        // Standalone markers — restart (RST0..7) and TEM — carry no length
        // field: they're exactly the fill bytes plus this one code byte.
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            let Some(next) = code_idx.checked_add(1) else {
                break;
            };
            idx = next;
            continue;
        }
        let Some(len_start) = code_idx.checked_add(1) else {
            break;
        };
        let Some(len_end) = len_start.checked_add(2) else {
            break;
        };
        let Some(length_bytes) = bytes.get(len_start..len_end) else {
            break;
        };
        let length = u16::from_be_bytes([length_bytes[0], length_bytes[1]]) as usize;
        let Some(payload_start) = code_idx.checked_add(3) else {
            break;
        };
        let Some(segment_end) = len_start.checked_add(length) else {
            break;
        };
        let Some(payload) = bytes.get(payload_start..segment_end) else {
            break;
        };
        match marker {
            0xE0 if payload.starts_with(b"JFIF\0") && payload.len() >= 12 => {
                // JFIF: units byte then X/Y density, big-endian.
                let x = u16::from_be_bytes([payload[8], payload[9]]) as f64;
                found.density = match payload[7] {
                    1 => Some(x),        // already per inch
                    2 => Some(x * 2.54), // per cm
                    _ => None,           // aspect ratio only
                };
            }
            0xE1 if payload.starts_with(EXIF_INTRO) => {
                found
                    .exif
                    .get_or_insert_with(|| payload[EXIF_INTRO.len()..].to_vec());
            }
            0xE1 if payload.starts_with(XMP_INTRO) => {
                found
                    .xmp
                    .get_or_insert_with(|| payload[XMP_INTRO.len()..].to_vec());
            }
            0xE2 if payload.len() > ICC_INTRO.len() + 2 && payload.starts_with(ICC_INTRO) => {
                let sequence = payload[ICC_INTRO.len()];
                let count = payload[ICC_INTRO.len() + 1];
                icc_chunks.push((sequence, count, payload[ICC_INTRO.len() + 2..].to_vec()));
            }
            _ => {}
        }
        idx = segment_end;
    }
    found.icc = assemble_icc_chunks(icc_chunks);
    found
}

/// Reassemble numbered JPEG APP2 ICC chunks (`sequence`, declared total
/// `count`, chunk bytes) into one profile. Every chunk must agree on the
/// declared count, the collected sequence numbers must be exactly
/// `1..=count` with no duplicates, and there must be exactly `count` chunks
/// — a dropped chunk, a duplicate, or chunks that disagree about how many
/// there should be means the profile can't be trusted to reassemble
/// correctly, so it is reported as absent rather than silently wrong.
fn assemble_icc_chunks(mut chunks: Vec<(u8, u8, Vec<u8>)>) -> Option<Vec<u8>> {
    let (_, count, _) = *chunks.first()?;
    if chunks.iter().any(|(_, c, _)| *c != count) {
        return None;
    }
    if count as usize != chunks.len() {
        return None;
    }
    chunks.sort_by_key(|(sequence, _, _)| *sequence);
    let mut expected = 1u8;
    for (sequence, _, _) in &chunks {
        if *sequence != expected {
            return None;
        }
        expected = expected.checked_add(1)?;
    }
    Some(chunks.into_iter().flat_map(|(_, _, data)| data).collect())
}

/// Walk PNG chunks. `iCCP` is a NUL-terminated name, a compression byte, then
/// a zlib stream; `iTXt` is keyword, compression flag/method, language and
/// translated keyword, then the text — see `parse_png_itxt_xmp`.
fn read_png(bytes: &[u8]) -> RasterSidecars {
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
        let Some(payload) = bytes.get(kind_end..payload_end) else {
            break;
        };
        match kind {
            b"eXIf" => found.exif = Some(payload.to_vec()),
            b"iCCP" => {
                if let Some(nul) = payload.iter().position(|&b| b == 0) {
                    // payload[nul + 1] is the compression method (always 0).
                    found.icc = nul
                        .checked_add(2)
                        .and_then(|start| payload.get(start..))
                        .and_then(|zlib| miniz_oxide::inflate::decompress_to_vec_zlib(zlib).ok());
                }
            }
            b"iTXt" if payload.starts_with(PNG_XMP_KEYWORD) => {
                found.xmp = parse_png_itxt_xmp(&payload[PNG_XMP_KEYWORD.len()..]);
            }
            b"pHYs" if payload.len() >= 9 && payload[8] == 1 => {
                let per_metre =
                    u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as f64;
                found.density = Some(per_metre * 0.0254);
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
        (1, 0) => miniz_oxide::inflate::decompress_to_vec_zlib(text).ok(),
        _ => None,
    }
}

/// IFD0 tags 34675 (`InterColorProfile`) and 700 (`XMLPacket`). The whole
/// file is the EXIF block for a TIFF, which is how libvips reports it too.
fn read_tiff(bytes: &[u8]) -> RasterSidecars {
    let little = bytes.starts_with(b"II");
    let u16_at = |i: usize| -> Option<u16> {
        let end = i.checked_add(2)?;
        let b = bytes.get(i..end)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |i: usize| -> Option<u32> {
        let end = i.checked_add(4)?;
        let b = bytes.get(i..end)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let mut found = RasterSidecars {
        exif: Some(bytes.to_vec()),
        ..Default::default()
    };
    let Some(ifd) = u32_at(4).map(|v| v as usize) else {
        return found;
    };
    let Some(count) = u16_at(ifd) else {
        return found;
    };
    let Some(entries_start) = ifd.checked_add(2) else {
        return found;
    };
    for entry in 0..count as usize {
        let Some(entry_offset) = entry.checked_mul(12) else {
            break;
        };
        let Some(at) = entries_start.checked_add(entry_offset) else {
            break;
        };
        let (Some(type_at), Some(length_at), Some(offset_at)) =
            (at.checked_add(2), at.checked_add(4), at.checked_add(8))
        else {
            break;
        };
        let (Some(tag), Some(type_field), Some(length), Some(offset)) = (
            u16_at(at),
            u16_at(type_at),
            u32_at(length_at),
            u32_at(offset_at),
        ) else {
            break;
        };
        // Only a byte-sized type (BYTE 1, ASCII 2, UNDEFINED 7) makes the
        // declared count a direct byte length; anything else (SHORT, LONG,
        // …) would need `count * type_size`, which neither tag this reads
        // uses in practice, so it's treated as "not present" rather than a
        // guess at the real length.
        if !matches!(type_field, 1 | 2 | 7) {
            continue;
        }
        let Some(value_end) = (offset as usize).checked_add(length as usize) else {
            continue;
        };
        let payload = bytes.get(offset as usize..value_end).map(|s| s.to_vec());
        match tag {
            34675 => found.icc = payload,
            700 => found.xmp = payload,
            _ => {}
        }
    }
    found
}

/// RIFF chunk walk for `EXIF`, `ICCP` and `XMP `.
fn read_webp(bytes: &[u8]) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut idx = 12usize;
    loop {
        let Some(kind_end) = idx.checked_add(4) else {
            break;
        };
        let Some(kind) = bytes.get(idx..kind_end) else {
            break;
        };
        let Some(len_end) = kind_end.checked_add(4) else {
            break;
        };
        let Some(length_bytes) = bytes.get(kind_end..len_end) else {
            break;
        };
        let length = u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ]) as usize;
        let Some(payload_end) = len_end.checked_add(length) else {
            break;
        };
        let Some(payload) = bytes.get(len_end..payload_end) else {
            break;
        };
        match kind {
            b"EXIF" => found.exif = Some(payload.to_vec()),
            b"ICCP" => found.icc = Some(payload.to_vec()),
            b"XMP " => found.xmp = Some(payload.to_vec()),
            _ => {}
        }
        // RIFF chunks are padded to an even length.
        let Some(next) = payload_end.checked_add(length & 1) else {
            break;
        };
        idx = next;
    }
    found
}

#[cfg(test)]
#[path = "raster_meta_jpeg_tests.rs"]
mod jpeg_tests;
#[cfg(test)]
#[path = "raster_meta_png_tests.rs"]
mod png_tests;
#[cfg(test)]
#[path = "raster_meta_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "raster_meta_tiff_webp_tests.rs"]
mod tiff_webp_tests;
