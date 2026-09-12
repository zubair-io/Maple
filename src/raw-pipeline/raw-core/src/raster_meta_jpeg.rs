//! The JPEG half of [`super`] (#3507): walk the marker segments from the
//! SOI to the SOS, collecting the APP1 EXIF and XMP payloads, the APP2 ICC
//! chunk sequence, and the APP0 JFIF density.
//!
//! Split out of `raster_meta.rs` (final fix wave, item 7): JPEG is the
//! longest of the five container walks — it is the only one with a
//! multi-segment block to reassemble and two same-marker payloads to tell
//! apart — and lifting it out keeps that file inside the file-size budget.

use super::*;

/// Walk JPEG marker segments from the SOI to the SOS, collecting APP1/APP2.
pub(super) fn read_jpeg(bytes: &[u8]) -> RasterSidecars {
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
                // Always introduced in a JPEG — the introducer is how the
                // APP1 segment is told apart from the XMP one below.
                found.exif_intro = true;
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
    // The EXIF resolution wins over the JFIF one, and a JPEG that states
    // neither is 72 dpi. Both are libvips' behaviour, measured against
    // sharp 0.34.5 (#3507 final fix wave, item 7): a JPEG carrying a 300
    // dpi JFIF segment and a 96 dpi EXIF `XResolution` reads back as 96,
    // and a mozjpeg-written JPEG with no resolution anywhere reads back
    // as 72 where Maple reported nothing.
    found.density = found
        .exif
        .as_deref()
        .and_then(exif_resolution_dpi)
        .or(found.density)
        .or(Some(JPEG_DEFAULT_DPI))
        .and_then(reportable_density);
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
