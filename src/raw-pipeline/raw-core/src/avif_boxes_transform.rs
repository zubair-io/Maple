//! Primary-item transform resolution for [`super`] (#3507): which
//! `irot`/`imir` properties (if any) apply to the AVIF's primary item,
//! read out of `iprp`'s `ipco` (the ordered property list) and `ipma`
//! (which properties are associated with which item) plus `pitm` (which
//! item is primary). See the parent module's doc for why only the primary
//! item's own associations count, and why the rotate-then-mirror
//! composition is always a fixed lookup rather than something derived from
//! storage order.
//!
//! Sibling of `avif_boxes.rs`, split out once the box walker grew past the
//! 400-line soft budget (CONTRIBUTING.md § "File-size budget") — same
//! `#[path]` sibling pattern `raster.rs` uses for `raster_exif.rs` and
//! friends, just for production code instead of tests this time. Reaches
//! `box_header`/`find_child_box` via the glob import below: both are
//! private items of the parent `avif_boxes` module, and Rust's visibility
//! rules make a private item visible in its defining module and every
//! descendant — this module is a descendant, so no `pub(super)` is needed
//! on either.

use super::*;

/// One `ipco` transform property this walker tracks, carrying its own
/// payload value (the rotation step or mirror axis) rather than just its
/// presence — `ipma` associations are resolved against this later.
enum Transform {
    Rotate(u8),
    Mirror(u8),
}
/// Walk `ipco`'s payload — nothing but sibling property boxes — into an
/// ordered, 1-indexed list: `props[i]` is property index `i + 1`, matching
/// the numbering `ipma` associations reference. Only `irot`/`imir` carry a
/// `Transform`; every other property (`ispe`, `av1C`, `pixi`, …) still
/// occupies its slot as `None` so later indices stay correct. Stops
/// (rather than guessing) at the first malformed box, returning whatever
/// was collected before it.
fn collect_ipco_properties(ipco: &[u8]) -> Vec<Option<Transform>> {
    let mut out = Vec::new();
    let mut idx = 0usize;
    while let Some((kind, payload_start, box_end)) = box_header(ipco, idx, ipco.len()) {
        let payload = ipco.get(payload_start..box_end).unwrap_or(&[]);
        let entry = match &kind {
            b"irot" => payload.first().map(|&b| Transform::Rotate(b & 0b11)),
            b"imir" => payload.first().map(|&b| Transform::Mirror(b & 1)),
            _ => None,
        };
        out.push(entry);
        idx = box_end;
    }
    out
}

/// `PrimaryItemBox`: FullBox; item_ID is 16 bits at version 0, 32 bits at
/// any later version.
pub(super) fn parse_pitm(payload: &[u8]) -> Option<u32> {
    let &version = payload.first()?;
    if version == 0 {
        let b = payload.get(4..6)?;
        Some(u16::from_be_bytes([b[0], b[1]]) as u32)
    } else {
        let b = payload.get(4..8)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// `ItemPropertyAssociationBox`: FullBox; `entry_count` is `unsigned
/// int(32)` regardless of version (unlike the per-entry `item_ID`, which
/// IS version-gated: 16 bits at version 0, 32 bits at version ≥1). Per
/// entry: item_ID, `association_count` (8 bits), then that many
/// associations — each 1 byte (flags bit 0 clear: 1 essential bit + 7-bit
/// property index) or 2 bytes (flags bit 0 set: 1 essential bit + 15-bit
/// property index). Returns the requested item's property indices in
/// association order, or an empty list on any parse failure (item not
/// found, or a corrupt/truncated box) — callers compose an empty list the
/// same way as "this item has no properties", which for `irot`/`imir`
/// means orientation stays 1.
fn parse_ipma_for_item(ipma: &[u8], item: u32) -> Vec<u32> {
    let Some(&version) = ipma.first() else {
        return Vec::new();
    };
    let Some(&flags_low_byte) = ipma.get(3) else {
        return Vec::new();
    };
    let wide_index = flags_low_byte & 1 == 1;
    let Some(entry_count_bytes) = ipma.get(4..8) else {
        return Vec::new();
    };
    let entry_count = u32::from_be_bytes([
        entry_count_bytes[0],
        entry_count_bytes[1],
        entry_count_bytes[2],
        entry_count_bytes[3],
    ]);
    let id_size = if version < 1 { 2usize } else { 4usize };
    let assoc_width = if wide_index { 2usize } else { 1usize };

    let mut at = 8usize;
    for _ in 0..entry_count {
        let Some(id_end) = at.checked_add(id_size) else {
            return Vec::new();
        };
        let Some(id_bytes) = ipma.get(at..id_end) else {
            return Vec::new();
        };
        let entry_item = if id_size == 2 {
            u16::from_be_bytes([id_bytes[0], id_bytes[1]]) as u32
        } else {
            u32::from_be_bytes([id_bytes[0], id_bytes[1], id_bytes[2], id_bytes[3]])
        };
        let Some(&assoc_count) = ipma.get(id_end) else {
            return Vec::new();
        };
        let Some(assoc_start) = id_end.checked_add(1) else {
            return Vec::new();
        };
        let Some(assoc_len) = (assoc_count as usize).checked_mul(assoc_width) else {
            return Vec::new();
        };
        let Some(assoc_end) = assoc_start.checked_add(assoc_len) else {
            return Vec::new();
        };
        let Some(assoc_bytes) = ipma.get(assoc_start..assoc_end) else {
            return Vec::new();
        };
        if entry_item == item {
            return assoc_bytes
                .chunks_exact(assoc_width)
                .map(|chunk| {
                    if wide_index {
                        (u16::from_be_bytes([chunk[0], chunk[1]]) & 0x7fff) as u32
                    } else {
                        (chunk[0] & 0x7f) as u32
                    }
                })
                .collect();
        }
        at = assoc_end;
    }
    Vec::new()
}

/// Resolve the primary item's own rotation/mirror step from `iprp`'s
/// `ipco` (the ordered property list) and `ipma` (which properties are
/// associated with which item) — see the module doc for why only the
/// primary item's associations count and why the composition is always
/// "rotate, then mirror" regardless of storage/association order.
pub(super) fn resolve_transform(iprp: &[u8], primary_item: u32) -> (usize, usize) {
    let Some(props) = find_child_box(iprp, 0, iprp.len(), b"ipco").map(collect_ipco_properties)
    else {
        return (0, 0);
    };
    let Some(associations) = find_child_box(iprp, 0, iprp.len(), b"ipma") else {
        return (0, 0);
    };
    let mut rotation = 0usize;
    let mut mirror = 0usize;
    for index in parse_ipma_for_item(associations, primary_item) {
        let slot = (index as usize).checked_sub(1).and_then(|i| props.get(i));
        match slot {
            Some(Some(Transform::Rotate(step))) => rotation = *step as usize,
            Some(Some(Transform::Mirror(axis))) => mirror = *axis as usize + 1,
            _ => {} // out-of-range index, or a non-transform property: ignore
        }
    }
    (rotation, mirror)
}
