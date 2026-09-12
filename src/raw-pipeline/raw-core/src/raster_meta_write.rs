//! Rewrite tags inside an EXIF block (#3507): the recipe's
//! `metadata.orientation` and `metadata.density` both have to land in the
//! EXIF block an output carries, not only in the container's own
//! orientation/density field, because libvips prefers the EXIF values when
//! reading either one back.
//!
//! Split out of `raster_meta.rs` (final fix wave): that file reads five
//! containers and was at the 570-line headroom ceiling once the canonical
//! EXIF form landed. Reading a container and rewriting a tag inside the
//! block it yielded are separate jobs, so this is the seam.
//!
//! Every writer here keeps the block's byte length unchanged — an existing
//! entry is rewritten in place so every other tag's offset stays valid —
//! and falls back to a freshly built minimal block when the tag it needs
//! isn't already there, since there is no room to insert a 12-byte IFD
//! entry without reflowing every offset in the original.

use super::canonical_exif;

/// EXIF tag 0x0112, Orientation.
const TAG_ORIENTATION: u16 = 0x0112;

/// Return `block` with its IFD0 Orientation tag set to `orientation`,
/// creating a minimal little-endian block when `block` has no usable IFD0
/// entry for it (#3507, so the recipe's `metadata.orientation` can rewrite
/// whichever EXIF block `resolve_metadata` resolved, or create one when
/// there was none to begin with).
///
/// The block never grows: an existing entry is rewritten in place, so every
/// other tag's offset stays valid. When there is no existing Orientation
/// entry to rewrite — no usable TIFF header, a corrupt/truncated IFD0, or
/// simply no such tag — a fresh minimal block is returned instead, since
/// there is no room to insert a new 12-byte IFD entry without reflowing
/// every other tag's offset in the original block.
pub fn set_exif_orientation(block: &[u8], orientation: u16) -> Vec<u8> {
    // A caller-supplied block may still carry the `Exif\0\0` introducer
    // (sharp's own `metadata().exif` hands one out for three of the five
    // containers); before this, an introduced block matched neither `II`
    // nor `MM` at offset 0 and was replaced wholesale by the 26-byte
    // minimal stub below — total metadata loss (#3507 final fix wave).
    let (block, _) = canonical_exif(block);
    let minimal = || -> Vec<u8> {
        let mut tiff = vec![0u8; 26];
        tiff[..2].copy_from_slice(b"II");
        tiff[2..4].copy_from_slice(&42u16.to_le_bytes());
        tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
        tiff[10..12].copy_from_slice(&TAG_ORIENTATION.to_le_bytes());
        tiff[12..14].copy_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff[14..18].copy_from_slice(&1u32.to_le_bytes()); // count
        tiff[18..20].copy_from_slice(&orientation.to_le_bytes());
        tiff
    };
    let little = block.starts_with(b"II");
    if block.len() < 8 || (!little && !block.starts_with(b"MM")) {
        return minimal();
    }
    let u16_at = |b: &[u8], i: usize| -> Option<u16> {
        let end = i.checked_add(2)?;
        let s = b.get(i..end)?;
        Some(if little {
            u16::from_le_bytes([s[0], s[1]])
        } else {
            u16::from_be_bytes([s[0], s[1]])
        })
    };
    let u32_at = |b: &[u8], i: usize| -> Option<u32> {
        let end = i.checked_add(4)?;
        let s = b.get(i..end)?;
        Some(if little {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        })
    };
    let mut out = block.to_vec();
    let Some(ifd) = u32_at(&out, 4).map(|v| v as usize) else {
        return minimal();
    };
    let Some(count) = u16_at(&out, ifd) else {
        return minimal();
    };
    let Some(entries_start) = ifd.checked_add(2) else {
        return minimal();
    };
    let entry = (0..count as usize).find(|&e| {
        e.checked_mul(12)
            .and_then(|offset| entries_start.checked_add(offset))
            .and_then(|at| u16_at(&out, at))
            == Some(TAG_ORIENTATION)
    });
    let Some(entry) = entry else {
        // No Orientation entry, and no room to add one without reflowing
        // every offset in the block — hand back a minimal block instead,
        // which is what an encoder needs to carry the value.
        return minimal();
    };
    let Some(value_at) = entry
        .checked_mul(12)
        .and_then(|offset| entries_start.checked_add(offset))
        .and_then(|at| at.checked_add(8))
    else {
        return minimal();
    };
    let bytes = if little {
        orientation.to_le_bytes()
    } else {
        orientation.to_be_bytes()
    };
    let Some(value_end) = value_at.checked_add(2) else {
        return minimal();
    };
    match out.get_mut(value_at..value_end) {
        Some(slot) => slot.copy_from_slice(&bytes),
        None => return minimal(),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian block whose IFD0 carries Orientation = `value`.
    fn block_with_orientation(value: u16) -> Vec<u8> {
        set_exif_orientation(&[], value)
    }

    #[test]
    fn rewrites_an_orientation_in_place() {
        let block = block_with_orientation(6);
        let rewritten = set_exif_orientation(&block, 3);
        assert_eq!(rewritten.len(), block.len());
        assert_eq!(&rewritten[18..20], &3u16.to_le_bytes());
    }

    #[test]
    fn tolerates_an_introduced_block_instead_of_discarding_it() {
        // An `Exif\0\0`-introduced block used to match neither `II` nor
        // `MM` at offset 0, so the whole thing was replaced by the 26-byte
        // minimal stub — measured on a WebP→JPEG `keepMetadata()
        // .withMetadata({orientation:5})`, where a 186-byte block came out
        // 32 bytes and every tag but Orientation was lost (#3507 final fix
        // wave, item 3). The block must survive, and come back canonical.
        let plain = block_with_orientation(6);
        let introduced = [b"Exif\0\0".as_slice(), &plain].concat();
        let rewritten = set_exif_orientation(&introduced, 5);
        assert_eq!(rewritten.len(), plain.len());
        assert_eq!(&rewritten[..2], b"II");
        assert_eq!(&rewritten[18..20], &5u16.to_le_bytes());
    }
}
