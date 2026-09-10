//! Fast IFD0 / EXIF header parsers for raster image metadata probing.

/// Helper to scan for TIFF/EXIF orientation tag in JPEG/TIFF byte streams.
pub(crate) fn extract_exif_orientation(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 12 {
        return None;
    }

    if (bytes[0] == b'I' && bytes[1] == b'I' && bytes[2] == 0x2A && bytes[3] == 0x00)
        || (bytes[0] == b'M' && bytes[1] == b'M' && bytes[2] == 0x00 && bytes[3] == 0x2A)
    {
        return parse_tiff_exif_orientation(bytes);
    }

    if bytes[0] == 0xFF && bytes[1] == 0xD8 {
        let mut idx = 2;
        while idx + 4 < bytes.len() {
            if bytes[idx] != 0xFF {
                break;
            }
            let marker = bytes[idx + 1];
            if marker == 0xDA || marker == 0xD9 {
                break;
            }
            let seg_len = u16::from_be_bytes([bytes[idx + 2], bytes[idx + 3]]) as usize;
            if marker == 0xE1 && idx + 4 + 6 <= bytes.len() {
                if &bytes[idx + 4..idx + 10] == b"Exif\0\0" {
                    let exif_bytes =
                        &bytes[idx + 10..std::cmp::min(bytes.len(), idx + 2 + seg_len)];
                    return parse_tiff_exif_orientation(exif_bytes);
                }
            }
            idx += 2 + seg_len;
        }
    }

    None
}

pub(crate) fn parse_tiff_exif_orientation(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 8 {
        return None;
    }
    let is_le = bytes[0] == b'I' && bytes[1] == b'I';
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

    let ifd0_offset = read_u32(&bytes[4..8]) as usize;
    if ifd0_offset + 2 > bytes.len() {
        return None;
    }

    let num_entries = read_u16(&bytes[ifd0_offset..ifd0_offset + 2]) as usize;
    let mut entry_offset = ifd0_offset + 2;

    for _ in 0..num_entries {
        if entry_offset + 12 > bytes.len() {
            break;
        }
        let tag = read_u16(&bytes[entry_offset..entry_offset + 2]);
        if tag == 0x0112 {
            let val = read_u16(&bytes[entry_offset + 8..entry_offset + 10]);
            return Some(val);
        }
        entry_offset += 12;
    }

    None
}

pub(crate) fn parse_tiff_dimensions(bytes: &[u8]) -> Option<(u32, u32, bool)> {
    if bytes.len() < 8 {
        return None;
    }
    let is_le = bytes[0] == b'I' && bytes[1] == b'I';
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

    let ifd0_offset = read_u32(&bytes[4..8]) as usize;
    if ifd0_offset + 2 > bytes.len() {
        return None;
    }

    let num_entries = read_u16(&bytes[ifd0_offset..ifd0_offset + 2]) as usize;
    let mut entry_offset = ifd0_offset + 2;

    let mut width = None;
    let mut height = None;
    let mut is_dng = false;

    for _ in 0..num_entries {
        if entry_offset + 12 > bytes.len() {
            break;
        }
        let tag = read_u16(&bytes[entry_offset..entry_offset + 2]);
        let typ = read_u16(&bytes[entry_offset + 2..entry_offset + 4]);
        let val = if typ == 3 {
            read_u16(&bytes[entry_offset + 8..entry_offset + 10]) as u32
        } else if typ == 4 {
            read_u32(&bytes[entry_offset + 8..entry_offset + 12])
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

        entry_offset += 12;
    }

    if let (Some(w), Some(h)) = (width, height) {
        Some((w, h, is_dng))
    } else {
        None
    }
}
