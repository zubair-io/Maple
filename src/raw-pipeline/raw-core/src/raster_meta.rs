//! Read the metadata blocks a container carries (#3507), so `metadata()` can
//! report them and `keepMetadata()` can hand them straight back to an encoder.
//!
//! * JPEG: APP1 `Exif\0\0`, APP2 `ICC_PROFILE\0` (reassembled across its
//!   chunk sequence), APP1 `http://ns.adobe.com/xap/1.0/\0` for XMP, and the
//!   APP0 JFIF density.
//! * PNG: `eXIf`, `iCCP` (zlib-deflated), `iTXt` with the
//!   `XML:com.adobe.xmp` keyword, and `pHYs` for density.
//! * TIFF: the IFD0 `InterColorProfile` (34675) and `XMLPacket` (700) tags,
//!   with the whole file standing in as the EXIF block.
//! * WebP: the `EXIF`, `ICCP` and `XMP ` RIFF chunks.
//!
//! AVIF is handled separately (Task G2) — its metadata lives in ISO-BMFF
//! item boxes, not in a chunk stream.
//!
//! Everything here is READ-ONLY and allocation-light: a container with no
//! metadata costs one linear scan of its header. Every offset comes from
//! `get(..)`, never direct index arithmetic that could panic on a truncated
//! or hostile file — a corrupt container yields `None` fields, not a panic
//! (see `raster_meta_tests.rs`'s truncation sweep).

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
/// The ICC profile is split across numbered APP2 chunks, so they are gathered
/// in order and concatenated.
fn read_jpeg(bytes: &[u8]) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut icc_chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut idx = 2usize;
    while idx + 4 <= bytes.len() && bytes[idx] == 0xFF {
        let marker = bytes[idx + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let length = u16::from_be_bytes([bytes[idx + 2], bytes[idx + 3]]) as usize;
        let Some(payload) = bytes.get(idx + 4..idx + 2 + length) else {
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
                icc_chunks.push((sequence, payload[ICC_INTRO.len() + 2..].to_vec()));
            }
            _ => {}
        }
        idx += 2 + length;
    }
    if !icc_chunks.is_empty() {
        icc_chunks.sort_by_key(|(sequence, _)| *sequence);
        found.icc = Some(icc_chunks.into_iter().flat_map(|(_, data)| data).collect());
    }
    found
}

/// Walk PNG chunks. `iCCP` is a NUL-terminated name, a compression byte, then
/// a zlib stream; `iTXt` is keyword, compression flag/method, language and
/// translated keyword, then the text.
fn read_png(bytes: &[u8]) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut idx = 8usize;
    while idx + 8 <= bytes.len() {
        let length =
            u32::from_be_bytes([bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3]])
                as usize;
        let kind = &bytes[idx + 4..idx + 8];
        let Some(payload) = bytes.get(idx + 8..idx + 8 + length) else {
            break;
        };
        match kind {
            b"eXIf" => found.exif = Some(payload.to_vec()),
            b"iCCP" => {
                if let Some(nul) = payload.iter().position(|&b| b == 0) {
                    // payload[nul + 1] is the compression method (always 0);
                    // `get` (not a direct slice) so a NUL right at the end of
                    // a truncated chunk can't panic.
                    found.icc = payload
                        .get(nul + 2..)
                        .and_then(|zlib| miniz_oxide::inflate::decompress_to_vec_zlib(zlib).ok());
                }
            }
            b"iTXt" if payload.starts_with(PNG_XMP_KEYWORD) => {
                let rest = &payload[PNG_XMP_KEYWORD.len()..];
                // compression flag, compression method, then two NUL-terminated
                // strings (language tag and translated keyword).
                let text = rest.get(2..).and_then(|r| {
                    let first = r.iter().position(|&b| b == 0)? + 1;
                    let second = r.get(first..)?.iter().position(|&b| b == 0)? + first + 1;
                    r.get(second..)
                });
                found.xmp = text.map(|t| t.to_vec());
            }
            b"pHYs" if payload.len() >= 9 && payload[8] == 1 => {
                let per_metre =
                    u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as f64;
                found.density = Some(per_metre * 0.0254);
            }
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        idx += 12 + length;
    }
    found
}

/// IFD0 tags 34675 (`InterColorProfile`) and 700 (`XMLPacket`). The whole
/// file is the EXIF block for a TIFF, which is how libvips reports it too.
fn read_tiff(bytes: &[u8]) -> RasterSidecars {
    let little = bytes.starts_with(b"II");
    let u16_at = |i: usize| -> Option<u16> {
        let b = bytes.get(i..i + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |i: usize| -> Option<u32> {
        let b = bytes.get(i..i + 4)?;
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
    for entry in 0..count as usize {
        let at = ifd + 2 + entry * 12;
        let (Some(tag), Some(length), Some(offset)) = (u16_at(at), u32_at(at + 4), u32_at(at + 8))
        else {
            break;
        };
        let payload = bytes
            .get(offset as usize..offset as usize + length as usize)
            .map(|s| s.to_vec());
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
    while idx + 8 <= bytes.len() {
        let kind = &bytes[idx..idx + 4];
        let length = u32::from_le_bytes([
            bytes[idx + 4],
            bytes[idx + 5],
            bytes[idx + 6],
            bytes[idx + 7],
        ]) as usize;
        let Some(payload) = bytes.get(idx + 8..idx + 8 + length) else {
            break;
        };
        match kind {
            b"EXIF" => found.exif = Some(payload.to_vec()),
            b"ICCP" => found.icc = Some(payload.to_vec()),
            b"XMP " => found.xmp = Some(payload.to_vec()),
            _ => {}
        }
        // RIFF chunks are padded to an even length.
        idx += 8 + length + (length & 1);
    }
    found
}

#[cfg(test)]
#[path = "raster_meta_tests.rs"]
mod tests;
