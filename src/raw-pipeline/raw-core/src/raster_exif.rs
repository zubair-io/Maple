//! Fast IFD0 / EXIF header parsers for raster image metadata probing.

use crate::metadata_source::MetadataSource;

/// Helper to scan for TIFF/EXIF orientation tag in JPEG/TIFF byte streams.
pub(crate) fn extract_exif_orientation(bytes: &[u8]) -> Option<u16> {
    extract_exif_orientation_source(bytes)
}

pub(crate) fn extract_exif_orientation_source<S: MetadataSource + ?Sized>(
    bytes: &S,
) -> Option<u16> {
    if bytes.len() < 12 {
        return None;
    }

    let header = bytes.get(0..12)?;
    if header.starts_with(b"II\x2a\0") || header.starts_with(b"MM\0\x2a") {
        return parse_tiff_exif_orientation_source(bytes);
    }

    if header.starts_with(&[0xFF, 0xD8]) {
        let mut idx = 2usize;
        while idx.checked_add(4)? < bytes.len() {
            if bytes.byte(idx)? != 0xFF {
                break;
            }
            let marker = bytes.byte(idx + 1)?;
            if marker == 0xDA || marker == 0xD9 {
                break;
            }
            let seg_len = u16::from_be_bytes([bytes.byte(idx + 2)?, bytes.byte(idx + 3)?]) as usize;
            if marker == 0xE1 && idx.checked_add(10)? <= bytes.len() {
                if bytes.get(idx + 4..idx + 10)?.as_ref() == b"Exif\0\0" {
                    let exif_bytes = bytes.get(
                        idx + 10
                            ..std::cmp::min(bytes.len(), idx.checked_add(2)?.checked_add(seg_len)?),
                    )?;
                    return parse_tiff_exif_orientation(&exif_bytes);
                }
            }
            idx = idx.checked_add(2)?.checked_add(seg_len)?;
        }
    }

    None
}

pub(crate) fn parse_tiff_exif_orientation(bytes: &[u8]) -> Option<u16> {
    parse_tiff_exif_orientation_source(bytes)
}

fn parse_tiff_exif_orientation_source<S: MetadataSource + ?Sized>(bytes: &S) -> Option<u16> {
    if bytes.len() < 8 {
        return None;
    }
    let is_le = bytes.starts_with(b"II");
    let read_u16 = |buf: &[u8]| -> u16 {
        if is_le {
            u16::from_le_bytes([buf[0], buf[1]])
        } else {
            u16::from_be_bytes([buf[0], buf[1]])
        }
    };
    let read_u32 = |buf: &[u8]| -> u32 {
        if is_le {
            u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]])
        } else {
            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]])
        }
    };

    let ifd0_offset = read_u32(&bytes.get(4..8)?) as usize;
    if ifd0_offset.checked_add(2)? > bytes.len() {
        return None;
    }

    let num_entries = read_u16(&bytes.get(ifd0_offset..ifd0_offset.checked_add(2)?)?) as usize;
    let mut entry_offset = ifd0_offset.checked_add(2)?;

    for _ in 0..num_entries {
        if entry_offset.checked_add(12)? > bytes.len() {
            break;
        }
        let tag = read_u16(&bytes.get(entry_offset..entry_offset + 2)?);
        if tag == 0x0112 {
            let val = read_u16(&bytes.get(entry_offset + 8..entry_offset + 10)?);
            return Some(val);
        }
        entry_offset = entry_offset.checked_add(12)?;
    }

    None
}

pub(crate) fn parse_tiff_dimensions<S: MetadataSource + ?Sized>(
    bytes: &S,
) -> Option<(u32, u32, bool)> {
    if bytes.len() < 8 {
        return None;
    }
    let is_le = bytes.starts_with(b"II");
    let read_u16 = |buf: &[u8]| -> u16 {
        if is_le {
            u16::from_le_bytes([buf[0], buf[1]])
        } else {
            u16::from_be_bytes([buf[0], buf[1]])
        }
    };
    let read_u32 = |buf: &[u8]| -> u32 {
        if is_le {
            u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]])
        } else {
            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]])
        }
    };

    let ifd0_offset = read_u32(&bytes.get(4..8)?) as usize;
    if ifd0_offset.checked_add(2)? > bytes.len() {
        return None;
    }

    let num_entries = read_u16(&bytes.get(ifd0_offset..ifd0_offset.checked_add(2)?)?) as usize;
    let mut entry_offset = ifd0_offset.checked_add(2)?;

    let mut width = None;
    let mut height = None;
    let mut is_dng = false;

    for _ in 0..num_entries {
        if entry_offset.checked_add(12)? > bytes.len() {
            break;
        }
        let tag = read_u16(&bytes.get(entry_offset..entry_offset + 2)?);
        let typ = read_u16(&bytes.get(entry_offset + 2..entry_offset + 4)?);
        let val = if typ == 3 {
            read_u16(&bytes.get(entry_offset + 8..entry_offset + 10)?) as u32
        } else if typ == 4 {
            read_u32(&bytes.get(entry_offset + 8..entry_offset + 12)?)
        } else {
            0
        };

        if tag == 0x0100 {
            width = Some(val);
        } else if tag == 0x0101 {
            height = Some(val);
        } else if tag == 0xC612 {
            is_dng = true;
        }

        entry_offset = entry_offset.checked_add(12)?;
    }

    if let (Some(w), Some(h)) = (width, height) {
        Some((w, h, is_dng))
    } else {
        None
    }
}
