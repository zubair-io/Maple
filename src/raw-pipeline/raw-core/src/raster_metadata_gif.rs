//! GIF header/frame metadata; compressed LZW subblocks are skipped, not decoded.

use crate::metadata_source::MetadataSource;

pub(crate) struct GifHeader {
    pub width: u32,
    pub height: u32,
    pub bits: u8,
    pub pages: usize,
    pub has_alpha: bool,
}

fn skip_blocks(bytes: &(impl MetadataSource + ?Sized), mut at: usize) -> Option<usize> {
    loop {
        let size = usize::from(bytes.byte(at)?);
        at = at.checked_add(1)?;
        if size == 0 {
            return Some(at);
        }
        let next = at.checked_add(size)?;
        if !bytes.contains(at..next) {
            return None;
        }
        at = next;
    }
}

pub(crate) fn read(bytes: &(impl MetadataSource + ?Sized)) -> Option<GifHeader> {
    let header = bytes.get(0..13)?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") {
        return None;
    }
    let width = u32::from(u16::from_le_bytes([header[6], header[7]]));
    let height = u32::from(u16::from_le_bytes([header[8], header[9]]));
    if width == 0 || height == 0 {
        return None;
    }
    let bits = (header[10] & 7) + 1;
    let table_size = if header[10] & 128 != 0 {
        3usize.checked_shl(u32::from(bits))?
    } else {
        0
    };
    let mut at = 13usize.checked_add(table_size)?;
    let mut pages = 0usize;
    let mut alpha = false;
    let mut first_bits = None;
    loop {
        match bytes.byte(at)? {
            0x3b => break,
            0x21 => {
                let label = bytes.byte(at.checked_add(1)?)?;
                if label == 0xf9 && bytes.byte(at.checked_add(2)?) == Some(4) {
                    alpha |= bytes.byte(at.checked_add(3)?)? & 1 != 0;
                }
                at = skip_blocks(bytes, at.checked_add(2)?)?;
            }
            0x2c => {
                let packed = bytes.byte(at.checked_add(9)?)?;
                let local_bits = (packed & 7) + 1;
                first_bits.get_or_insert(if packed & 128 != 0 { local_bits } else { bits });
                let table_size = if packed & 128 != 0 {
                    3usize.checked_shl(u32::from(local_bits))?
                } else {
                    0
                };
                // Descriptor(10), optional colour table, LZW minimum code size(1).
                at = skip_blocks(bytes, at.checked_add(11)?.checked_add(table_size)?)?;
                pages = pages.checked_add(1)?;
            }
            _ => return None,
        }
    }
    (pages != 0).then_some(GifHeader {
        width,
        height,
        bits: first_bits.unwrap_or(bits),
        pages,
        has_alpha: alpha,
    })
}
