//! A minimal ISO-BMFF property walker for AVIF (#3507).
//!
//! `avif-parse` 2.1.0 gives us the AV1 payloads and nothing else — it exposes
//! neither the `irot`/`imir` transform properties nor the `Exif` and XMP
//! metadata items. That is why `probe_raster_metadata` reported
//! `orientation: 1` for every AVIF, which made `.rotate()` a silent no-op on
//! an AVIF source and left the server's AVIF orientation checks structurally
//! dead.
//!
//! `meta`'s children are a fixed, shallow shape —
//! `pitm`, `iloc`, `iinf{infe...}`, `iprp{ipco{...}, ipma}` — so rather than
//! one generic recursive box visitor, this reads each of those directly:
//! `pitm` for the primary item, `iprp`/`ipco`/`ipma` for which transform
//! properties apply to *that* item (not just any item in the file), and
//! `iinf`/`iloc` for the `Exif` and XMP metadata items. It never allocates
//! for a file that has neither, and it is total: a malformed box stops the
//! read at that point rather than panicking. Same discipline `raster_meta.rs`
//! uses, for the same reason — every offset comes from `get(..)`, and every
//! addition that could overflow goes through `checked_add`, so a hostile or
//! truncated file (including a declared box size near `u32::MAX`) yields
//! `None`/default fields rather than a panic or, on the 32-bit `usize` of
//! the wasm32 target this crate also builds for, a silent wraparound into an
//! in-bounds-but-wrong read.
//!
//! ## Only the primary item's own properties count
//!
//! A property in `ipco` only applies to an item if that item's `ipma` entry
//! associates it — a file can carry more than one image item (e.g. a
//! thumbnail alongside the main image), each with its own transform, and
//! this must never read one item's rotation as if it were another's. So
//! orientation comes from: find the primary item (`pitm`'s item_ID, or item
//! 1 when `pitm` is absent — the ISO/IEC 23008-12 fallback), find that
//! item's association list in `ipma`, and apply only the `irot`/`imir`
//! properties `ipma` actually lists for it. An association naming a
//! property index `ipco` doesn't have is ignored (that one association
//! contributes nothing; every other valid association in the list still
//! applies); a corrupt or truncated `ipma` yields no associations at all,
//! so the primary item keeps its default orientation (1).
//!
//! ## irot/imir to EXIF orientation
//!
//! `irot` carries a rotation in the counter-clockwise direction, in units of
//! 90 degrees (ISO/IEC 23008-12:2017 6.5.10). Confirmed against libavif's
//! public header (`include/avif/avif.h`, the reference AVIF implementation):
//! `avifImageRotation.angle` is documented as "the angle (in anti-clockwise
//! direction) in units of degrees" for `angle * 90`.
//!
//! `imir` carries a mirror axis. libavif's header documents it by the
//! observable effect rather than the axis name, which is the least
//! ambiguous phrasing available: "'axis' specifies how the mirroring is
//! performed: 0 indicates that the top and bottom parts of the image are
//! exchanged; 1 specifies that the left and right parts are exchanged." This
//! file follows libavif's convention: axis 0 is a top/bottom (vertical) flip
//! — EXIF 4 alone — axis 1 is a left/right (horizontal) flip — EXIF 2 alone.
//! Some HEIF-derived write-ups instead name the axis of reflection ("axis 0
//! = the vertical axis") rather than the effect, which is easy to invert: a
//! reflection across a *vertical* line swaps left and right, not top and
//! bottom, so reading that phrasing as "axis 0 -> top/bottom" is backwards.
//! This is exactly the "older docs swap this" trap — this file follows
//! libavif's effect-first wording rather than the axis-name phrasing. This
//! has NOT been independently verified against libheif's or sharp/libvips'
//! `heif` loader source (neither was reachable while writing this) — see
//! #3507 if that verification becomes possible.
//!
//! The eight EXIF orientations are exactly the eight combinations of a
//! 90-degree-step rotation and an optional mirror, which is why a
//! container transform can be reported as one — see
//! `avif_boxes_transform.rs` for the composition, the association order it
//! follows, and the libheif measurements behind both.
//!
//! ## The transform is pixels, not a flag
//!
//! `AvifBoxes::transform` is NOT an orientation flag a consumer should pass
//! on. libheif applies `irot`/`imir` while decoding, so sharp's pixels for
//! an `irot 3` AVIF are already rotated and its `metadata()` reports the
//! rotated size (measured: 16×24 for a 24×16 image, where the same image as
//! a JPEG reports 24×16 with `orientation: 6`). `decode_raster` bakes this
//! transform into the pixels for the same reason, and the orientation
//! `RasterImage` then carries — the one `.rotate()`/`autoOrient` applies —
//! is the `Exif` item's own Orientation tag, reached through
//! `AvifBoxes::exif_orientation` (#3507 round 2).

/// The parts of an AVIF container `avif-parse` does not surface.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AvifBoxes {
    /// The primary item's `irot`/`imir` transform, as the EXIF orientation
    /// that describes the same transform: `1` when the file carries none.
    ///
    /// A transform, not a flag — the decoder is expected to apply it to the
    /// pixels, which is what libheif does and what `decode_raster` now does.
    /// See the module doc.
    pub transform: u16,
    pub exif: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
}

impl AvifBoxes {
    /// The Orientation tag inside the `Exif` item, or `1` when there is no
    /// item, no tag, or no readable TIFF block.
    ///
    /// This is the orientation an AVIF's pixels have NOT been through: the
    /// container's own `irot`/`imir` is baked in at decode instead (see the
    /// module doc), so this is what is left for `.rotate()`/`autoOrient` to
    /// apply. `metadata().orientation` reports it too.
    pub fn exif_orientation(&self) -> u16 {
        self.exif
            .as_deref()
            .map(|block| crate::raster_meta::canonical_exif(block).0)
            .and_then(crate::raster::exif_orientation_from_block)
            .unwrap_or(1)
    }
}

#[path = "avif_boxes_transform.rs"]
mod transform;

/// Read one box header at `data[idx..]`, with every sibling box in this
/// scan bounded by `bound` (not necessarily `data.len()` — callers often
/// scan a slice that is itself another box's payload). Returns `(kind,
/// payload_start, box_end)`. `None` on a truncated header, an overflowing
/// or out-of-bounds size, or a `largesize` box (`size == 1`) — no box this
/// module reads ever uses one.
fn box_header(data: &[u8], idx: usize, bound: usize) -> Option<([u8; 4], usize, usize)> {
    let payload_start = idx.checked_add(8)?;
    if payload_start > bound {
        return None;
    }
    let size_start = idx.checked_add(4)?;
    let size_bytes = data.get(idx..size_start)?;
    let size =
        u32::from_be_bytes([size_bytes[0], size_bytes[1], size_bytes[2], size_bytes[3]]) as usize;
    let kind_bytes = data.get(size_start..payload_start)?;
    let kind = [kind_bytes[0], kind_bytes[1], kind_bytes[2], kind_bytes[3]];
    // `size == 0` means "box runs to the end of the buffer it's in"; `size
    // == 1` means a 64-bit largesize follows, which no box here ever uses.
    let box_end = match size {
        0 => bound,
        1 => return None,
        n if n < 8 => return None,
        n => idx.checked_add(n)?,
    };
    if box_end > bound {
        return None;
    }
    Some((kind, payload_start, box_end))
}

/// Find the first top-level (sibling-scanned, never recursing) box of type
/// `kind` in `data[start..end]`, returning its payload (header stripped).
/// `None` on a malformed header, a truncated/overflowing size, or a
/// missing box.
fn find_child_box<'a>(
    data: &'a [u8],
    start: usize,
    end: usize,
    kind: &[u8; 4],
) -> Option<&'a [u8]> {
    let mut idx = start;
    loop {
        let (this_kind, payload_start, box_end) = box_header(data, idx, end)?;
        if this_kind == *kind {
            return data.get(payload_start..box_end);
        }
        idx = box_end;
    }
}

/// `ItemInfoBox`: FullBox; `entry_count` is 16 bits at version 0, 32 bits
/// at version 1. A version ≥2 `ItemInfoBox` (32-bit item_ID, defined in the
/// wider ISO/IEC 14496-12 spec) degrades to "no items" here rather than
/// guessing at a layout this hasn't verified — the file's `irot`/`imir`
/// orientation is unaffected either way, since that comes from
/// `iprp`/`ipco`/`ipma`, not here.
fn parse_iinf(iinf: &[u8]) -> Vec<(u16, [u8; 4])> {
    let Some(&version) = iinf.first() else {
        return Vec::new();
    };
    let children_start = match version {
        0 => 6usize, // version/flags(4) + entry_count(2)
        1 => 8usize, // version/flags(4) + entry_count(4)
        _ => return Vec::new(),
    };
    let Some(children) = iinf.get(children_start..) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut idx = 0usize;
    while let Some((kind, payload_start, box_end)) = box_header(children, idx, children.len()) {
        if &kind == b"infe" {
            if let Some(payload) = children.get(payload_start..box_end) {
                // FullBox; version 2 (what every real-world AVIF muxer with
                // this few items writes) lays out: version/flags(4),
                // item_ID(2), item_protection_index(2), item_type(4), then
                // a NUL-terminated item_name this doesn't need. Version
                // 0/1 has no item_type field at all, so only version 2
                // (and 3, which isn't special-cased since a handful of
                // items never needs a 32-bit item_ID) is trusted.
                if payload.first() == Some(&2) {
                    if let (Some(id_bytes), Some(type_bytes)) =
                        (payload.get(4..6), payload.get(8..12))
                    {
                        let id = u16::from_be_bytes([id_bytes[0], id_bytes[1]]);
                        out.push((
                            id,
                            [type_bytes[0], type_bytes[1], type_bytes[2], type_bytes[3]],
                        ));
                    }
                }
            }
        }
        idx = box_end;
    }
    out
}

/// `iloc` version 0 or 1, construction method 0 (file offsets), one extent
/// per item — which is what every AVIF muxer in practice writes for a
/// metadata item. A version-2 `iloc` (32-bit item_ID, defined in the wider
/// ISO/IEC 14496-12 spec) degrades to "no items" here, the same way
/// `parse_iinf`'s version ≥2 does. Returns `(item_id, offset, length)`,
/// where the offset is the item's absolute file position: `base_offset +
/// extent_offset`, since a writer is free to put the whole location in
/// either field (libheif/libvips and libavif use `base_offset`; the
/// `avif-serialize` encoder behind this crate's own AVIF output uses
/// `extent_offset`).
fn parse_iloc(payload: &[u8]) -> Vec<(u16, usize, usize)> {
    let Some(&version) = payload.first() else {
        return Vec::new();
    };
    if version > 1 || payload.len() < 8 {
        return Vec::new();
    }
    let Some(&sizes) = payload.get(4) else {
        return Vec::new();
    };
    let (offset_size, length_size) = ((sizes >> 4) as usize, (sizes & 0xF) as usize);
    let Some(&base_and_index) = payload.get(5) else {
        return Vec::new();
    };
    let base_size = (base_and_index >> 4) as usize;
    let index_size = if version == 1 {
        (base_and_index & 0xF) as usize
    } else {
        0
    };
    let Some(count_bytes) = payload.get(6..8) else {
        return Vec::new();
    };
    let count = u16::from_be_bytes([count_bytes[0], count_bytes[1]]) as usize;
    let read_be = |slice: &[u8]| slice.iter().fold(0usize, |acc, &b| (acc << 8) | b as usize);

    let mut at = 8usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let Some(id_end) = at.checked_add(2) else {
            break;
        };
        let Some(id_bytes) = payload.get(at..id_end) else {
            break;
        };
        let id = u16::from_be_bytes([id_bytes[0], id_bytes[1]]);
        // version 1 inserts a 2-byte construction-method field after item_ID.
        let ctor_extra = if version == 1 { 2 } else { 0 };
        let Some(after_id) = id_end.checked_add(ctor_extra) else {
            break;
        };
        // data_reference_index(2) + base_offset(base_size) + extent_count(2)
        let Some(base_at) = after_id.checked_add(2) else {
            break;
        };
        let Some(base_end) = base_at.checked_add(base_size) else {
            break;
        };
        let Some(base_bytes) = payload.get(base_at..base_end) else {
            break;
        };
        let base_offset = read_be(base_bytes);
        let Some(extents_at) = base_end.checked_add(2) else {
            break;
        };
        let Some(extent_end) = extents_at
            .checked_add(index_size)
            .and_then(|v| v.checked_add(offset_size))
            .and_then(|v| v.checked_add(length_size))
        else {
            break;
        };
        let Some(extent) = payload.get(extents_at..extent_end) else {
            break;
        };
        let extent_offset = read_be(&extent[index_size..index_size + offset_size]);
        let length = read_be(&extent[index_size + offset_size..]);
        // The item's bytes start at `base_offset + extent_offset`, not at
        // the extent offset alone: libheif/libvips and libavif both write
        // the real file position in `base_offset` and leave the extent
        // offset at 0, so ignoring it made every externally-produced AVIF's
        // `Exif`/XMP item read from the top of the file instead (#3507
        // final fix wave, item 2 — measured: a sharp-written AVIF's `exif`
        // came back as its own `ftypavif...` header). Checked, since both
        // halves are attacker-controlled 64-bit-capable fields.
        let Some(offset) = base_offset.checked_add(extent_offset) else {
            break;
        };
        out.push((id, offset, length));
        at = extent_end;
    }
    out
}

/// Walk `bytes` for the primary item's `irot`/`imir` transform and the
/// `Exif`/`mime` (XMP) metadata items, returning the transform as an EXIF
/// orientation equivalent and the raw item payloads. A file with none of
/// these — or that isn't a well-formed ISO-BMFF stream at all — reports
/// transform `1` and no items.
pub fn read_avif_boxes(bytes: &[u8]) -> AvifBoxes {
    let meta_children = find_child_box(bytes, 0, bytes.len(), b"meta")
        .and_then(|payload| payload.get(4..)) // skip meta's own FullBox version/flags
        .unwrap_or(&[]);

    let primary_item = find_child_box(meta_children, 0, meta_children.len(), b"pitm")
        .and_then(transform::parse_pitm)
        .unwrap_or(1); // ISO/IEC 23008-12 fallback: no `pitm` means item 1.

    let transform = find_child_box(meta_children, 0, meta_children.len(), b"iprp")
        .map(|iprp| transform::resolve_transform(iprp, primary_item))
        .unwrap_or(1);

    let item_types = find_child_box(meta_children, 0, meta_children.len(), b"iinf")
        .map(parse_iinf)
        .unwrap_or_default();
    let item_offsets = find_child_box(meta_children, 0, meta_children.len(), b"iloc")
        .map(parse_iloc)
        .unwrap_or_default();

    let block_for = |wanted: &[u8; 4]| -> Option<Vec<u8>> {
        let id = item_types
            .iter()
            .find(|(_, kind)| kind == wanted)
            .map(|(id, _)| *id)?;
        let (_, offset, length) = item_offsets.iter().find(|(i, _, _)| *i == id)?;
        let end = offset.checked_add(*length)?;
        bytes.get(*offset..end).map(|s| s.to_vec())
    };

    // An `Exif` item's payload is prefixed by a 4-byte offset to the TIFF
    // header (almost always zero), per ISO/IEC 23008-12 Annex A.2.1.
    let exif = block_for(b"Exif").and_then(|raw| raw.get(4..).map(|s| s.to_vec()));
    let xmp = block_for(b"mime");

    AvifBoxes {
        transform,
        exif,
        xmp,
    }
}

#[cfg(test)]
#[path = "avif_boxes_fixture_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "avif_boxes_encoder_tests.rs"]
mod encoder_tests;
