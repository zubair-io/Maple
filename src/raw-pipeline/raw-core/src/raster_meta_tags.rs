//! Read and rewrite individual tags inside an EXIF block (#3507).
//!
//! Two jobs, both about the block rather than the container that carried
//! it. Reading: the pixel density libvips reports for a JPEG, PNG or TIFF
//! comes from the EXIF `XResolution`, not from the container's own JFIF or
//! `pHYs` field, so `read_sidecars` has to look inside the block it just
//! read. Writing: the recipe's `metadata.orientation` and
//! `metadata.density` have to land in that same block for the same reason —
//! writing only the container's field leaves a kept EXIF resolution to win
//! on read-back (measured: `keepMetadata().withMetadata({density:300})`
//! wrote a 300 dpi JFIF and sharp read 96 back out of the kept EXIF).
//!
//! Split out of `raster_meta.rs` (final fix wave): that file reads five
//! containers and was at the 570-line headroom ceiling once the canonical
//! EXIF form landed. Walking a container and walking the IFD0 inside one of
//! its blocks are separate jobs, so this is the seam.
//!
//! Every writer here keeps the block's byte length unchanged — an existing
//! entry is rewritten in place so every other tag's offset stays valid —
//! and falls back to a freshly built minimal block when a tag it needs
//! isn't already there, since there is no room to insert a 12-byte IFD
//! entry without reflowing every offset in the original.

use super::canonical_exif;

/// EXIF tag 0x0112, Orientation (SHORT).
const TAG_ORIENTATION: u16 = 0x0112;
/// EXIF tag 0x011A, XResolution (RATIONAL).
const TAG_X_RESOLUTION: u16 = 0x011A;
/// EXIF tag 0x011B, YResolution (RATIONAL).
const TAG_Y_RESOLUTION: u16 = 0x011B;
/// EXIF tag 0x0128, ResolutionUnit (SHORT): 2 = inch, 3 = centimetre.
const TAG_RESOLUTION_UNIT: u16 = 0x0128;
/// TIFF field type 3, SHORT.
const TYPE_SHORT: u16 = 3;
/// TIFF field type 5, RATIONAL — two LONGs, stored out of line.
const TYPE_RATIONAL: u16 = 5;
/// Denominator the resolution rationals are written with, so a fractional
/// dpi survives. libvips writes `96000/1000` for 96 dpi; this matches.
const RATIONAL_DENOMINATOR: u32 = 1000;

/// A located IFD0, with the endianness its TIFF header declared.
struct Ifd0<'a> {
    bytes: &'a [u8],
    little: bool,
    entries_start: usize,
    count: usize,
}

impl<'a> Ifd0<'a> {
    /// `None` when `block` has no usable TIFF header or IFD0 — a corrupt,
    /// truncated or simply empty block, which every caller treats as "no
    /// tag to rewrite" rather than an error.
    fn open(block: &'a [u8]) -> Option<Self> {
        let little = block.starts_with(b"II");
        if block.len() < 8 || (!little && !block.starts_with(b"MM")) {
            return None;
        }
        let read_u32 = |at: usize| -> Option<u32> {
            let s = block.get(at..at.checked_add(4)?)?;
            Some(if little {
                u32::from_le_bytes([s[0], s[1], s[2], s[3]])
            } else {
                u32::from_be_bytes([s[0], s[1], s[2], s[3]])
            })
        };
        let ifd = read_u32(4)? as usize;
        let count_bytes = block.get(ifd..ifd.checked_add(2)?)?;
        let count = if little {
            u16::from_le_bytes([count_bytes[0], count_bytes[1]])
        } else {
            u16::from_be_bytes([count_bytes[0], count_bytes[1]])
        } as usize;
        Some(Ifd0 {
            bytes: block,
            little,
            entries_start: ifd.checked_add(2)?,
            count,
        })
    }

    fn u16_at(&self, at: usize) -> Option<u16> {
        let s = self.bytes.get(at..at.checked_add(2)?)?;
        Some(if self.little {
            u16::from_le_bytes([s[0], s[1]])
        } else {
            u16::from_be_bytes([s[0], s[1]])
        })
    }

    fn u32_at(&self, at: usize) -> Option<u32> {
        let s = self.bytes.get(at..at.checked_add(4)?)?;
        Some(if self.little {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        })
    }

    /// Offset of `tag`'s 4-byte value field, and the field type it declares.
    fn find(&self, tag: u16) -> Option<(usize, u16)> {
        (0..self.count).find_map(|entry| {
            let at = self
                .entries_start
                .checked_add(entry.checked_mul(12)?)
                .filter(|_| true)?;
            (self.u16_at(at)? == tag)
                .then(|| Some((at.checked_add(8)?, self.u16_at(at.checked_add(2)?)?)))
                .flatten()
        })
    }

    /// A SHORT tag's value, read out of the inline value field.
    fn short(&self, tag: u16) -> Option<u16> {
        let (value_at, kind) = self.find(tag)?;
        (kind == TYPE_SHORT)
            .then(|| self.u16_at(value_at))
            .flatten()
    }

    /// A RATIONAL tag's value as an `f64`, read from where its value field
    /// points. A zero denominator is no value at all, not an infinity.
    fn rational(&self, tag: u16) -> Option<f64> {
        let (value_at, kind) = self.find(tag)?;
        if kind != TYPE_RATIONAL {
            return None;
        }
        let at = self.u32_at(value_at)? as usize;
        let numerator = self.u32_at(at)?;
        let denominator = self.u32_at(at.checked_add(4)?)?;
        (denominator != 0).then(|| numerator as f64 / denominator as f64)
    }
}

/// The pixel density an EXIF block declares, in dots per inch.
///
/// `ResolutionUnit` 3 means the resolution is per centimetre; 2 (and the
/// EXIF default, when the tag is absent) means per inch. This is the value
/// libvips prefers over a container's own JFIF/`pHYs` field, which is why
/// `read_sidecars` consults it (#3507 final fix wave, item 7 — measured:
/// sharp reports 96 for a JPEG whose only resolution is EXIF
/// `XResolution = 96000/1000`, where Maple reported nothing).
pub fn exif_resolution_dpi(block: &[u8]) -> Option<f64> {
    let ifd = Ifd0::open(canonical_exif(block).0)?;
    let value = ifd.rational(TAG_X_RESOLUTION)?;
    match ifd.short(TAG_RESOLUTION_UNIT) {
        Some(3) => Some(value * 2.54),
        _ => Some(value),
    }
}

/// One 12-byte IFD entry holding an inline SHORT.
fn short_entry(tag: u16, value: u16) -> [u8; 12] {
    let mut entry = [0u8; 12];
    entry[0..2].copy_from_slice(&tag.to_le_bytes());
    entry[2..4].copy_from_slice(&TYPE_SHORT.to_le_bytes());
    entry[4..8].copy_from_slice(&1u32.to_le_bytes());
    entry[8..10].copy_from_slice(&value.to_le_bytes());
    entry
}

/// One 12-byte IFD entry whose value field points at an out-of-line
/// RATIONAL at `offset`.
fn rational_entry(tag: u16, offset: u32) -> [u8; 12] {
    let mut entry = [0u8; 12];
    entry[0..2].copy_from_slice(&tag.to_le_bytes());
    entry[2..4].copy_from_slice(&TYPE_RATIONAL.to_le_bytes());
    entry[4..8].copy_from_slice(&1u32.to_le_bytes());
    entry[8..12].copy_from_slice(&offset.to_le_bytes());
    entry
}

/// A fresh little-endian block carrying only the tags asked for, in
/// ascending tag order as TIFF requires. Used when there is no existing
/// entry to rewrite; at least one of the two must be `Some`, or the result
/// is an empty IFD0.
fn minimal_block(orientation: Option<u16>, dpi: Option<f64>) -> Vec<u8> {
    let rational = dpi.map(|dpi| {
        (
            (dpi * RATIONAL_DENOMINATOR as f64)
                .round()
                .clamp(1.0, u32::MAX as f64) as u32,
            RATIONAL_DENOMINATOR,
        )
    });
    let count = orientation.is_some() as usize + 3 * rational.is_some() as usize;
    let data_at = (8 + 2 + count * 12 + 4) as u32;

    let mut out = b"II".to_vec();
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&(count as u16).to_le_bytes());
    if let Some(orientation) = orientation {
        out.extend_from_slice(&short_entry(TAG_ORIENTATION, orientation));
    }
    if rational.is_some() {
        out.extend_from_slice(&rational_entry(TAG_X_RESOLUTION, data_at));
        out.extend_from_slice(&rational_entry(TAG_Y_RESOLUTION, data_at + 8));
        out.extend_from_slice(&short_entry(TAG_RESOLUTION_UNIT, 2));
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
    if let Some((numerator, denominator)) = rational {
        for _ in 0..2 {
            out.extend_from_slice(&numerator.to_le_bytes());
            out.extend_from_slice(&denominator.to_le_bytes());
        }
    }
    out
}

/// Overwrite `len` bytes at `at` in `block`, or `None` if they don't fit.
fn patched(block: &[u8], at: usize, value: &[u8]) -> Option<Vec<u8>> {
    let end = at.checked_add(value.len())?;
    let mut out = block.to_vec();
    out.get_mut(at..end)?.copy_from_slice(value);
    Some(out)
}

/// Return `block` with its IFD0 Orientation tag set to `orientation`,
/// creating a minimal little-endian block when `block` has no usable IFD0
/// entry for it (#3507, so the recipe's `metadata.orientation` can rewrite
/// whichever EXIF block `resolve_metadata` resolved, or create one when
/// there was none to begin with).
///
/// A caller-supplied block may still carry the `Exif\0\0` introducer
/// (sharp's own `metadata().exif` hands one out for three of the five
/// containers); before the final fix wave, an introduced block matched
/// neither `II` nor `MM` at offset 0 and was replaced wholesale by the
/// minimal stub below — total metadata loss.
pub fn set_exif_orientation(block: &[u8], orientation: u16) -> Vec<u8> {
    let block = canonical_exif(block).0;
    let rewritten = Ifd0::open(block).and_then(|ifd| {
        let (value_at, kind) = ifd.find(TAG_ORIENTATION)?;
        if kind != TYPE_SHORT {
            return None;
        }
        let bytes = if ifd.little {
            orientation.to_le_bytes()
        } else {
            orientation.to_be_bytes()
        };
        patched(block, value_at, &bytes)
    });
    rewritten.unwrap_or_else(|| minimal_block(Some(orientation), None))
}

/// Return `block` with its IFD0 `XResolution`/`YResolution` set to `dpi`
/// and `ResolutionUnit` set to inches — the values libvips prefers over a
/// container's own JFIF or `pHYs` density when reading one back.
///
/// The block never grows: the two rationals are rewritten where their
/// existing value fields already point. When any of the three tags is
/// missing there is nowhere to put it, so a minimal block is built instead,
/// carrying the orientation the original declared so that a
/// `withMetadata({orientation, density})` pair doesn't lose one of them.
pub fn set_exif_resolution(block: &[u8], dpi: f64) -> Vec<u8> {
    let block = canonical_exif(block).0;
    let numerator = (dpi * RATIONAL_DENOMINATOR as f64)
        .round()
        .clamp(1.0, u32::MAX as f64) as u32;
    let rewritten = Ifd0::open(block).and_then(|ifd| {
        let unit_at = ifd
            .find(TAG_RESOLUTION_UNIT)
            .filter(|(_, kind)| *kind == TYPE_SHORT)?
            .0;
        let rationals: Vec<usize> = [TAG_X_RESOLUTION, TAG_Y_RESOLUTION]
            .iter()
            .filter_map(|tag| {
                let (value_at, kind) = ifd.find(*tag)?;
                (kind == TYPE_RATIONAL).then(|| ifd.u32_at(value_at).map(|at| at as usize))?
            })
            .collect();
        if rationals.len() != 2 {
            return None;
        }
        let (numerator_bytes, denominator_bytes, unit_bytes) = if ifd.little {
            (
                numerator.to_le_bytes(),
                RATIONAL_DENOMINATOR.to_le_bytes(),
                2u16.to_le_bytes(),
            )
        } else {
            (
                numerator.to_be_bytes(),
                RATIONAL_DENOMINATOR.to_be_bytes(),
                2u16.to_be_bytes(),
            )
        };
        rationals.iter().try_fold(
            patched(block, unit_at, &unit_bytes)?,
            |out, &at| -> Option<Vec<u8>> {
                let out = patched(&out, at, &numerator_bytes)?;
                patched(&out, at + 4, &denominator_bytes)
            },
        )
    });
    rewritten.unwrap_or_else(|| {
        minimal_block(crate::raster::exif_orientation_from_block(block), Some(dpi))
    })
}

#[cfg(test)]
#[path = "raster_meta_tags_tests.rs"]
mod tests;
