//! Real-encoder fixture tests for [`super`] (#3507): everything that needs
//! `crate::avif::encode`'s actual AV1 payload rather than the hand-built
//! ISO-BMFF fixture in `avif_boxes.rs`'s own `tests` module.
//!
//! Sibling of `avif_boxes.rs`'s inline `tests` module, split out once this
//! grew the parent file past the 600-line hard budget
//! (CONTRIBUTING.md § "File-size budget") — same `#[path]` sibling pattern
//! `stages/hsl.rs` uses. Reaches `bx` (the tiny ISO-BMFF box builder) via
//! `super::tests::bx`, since that's a `pub(super)` item of the sibling
//! `tests` module and this file is a descendant of the same `avif_boxes`
//! module that item's visibility is scoped to.
//!
//! `crate::avif::encode`'s muxer (`avif-serialize`, via `image`'s AVIF
//! codec) writes only what a decoder strictly needs: `ftyp`, then
//! `meta{hdlr,pitm,iloc,iinf{infe},iprp{ipco{ispe,av1C,pixi},ipma}}`, then
//! one `mdat`. No `irot`/`imir`, no `Exif`/`mime` item — exactly the gap
//! `avif_boxes` fills. `mux_avif` below splices them in after the fact so
//! these tests exercise the real wiring (`probe_raster_metadata`,
//! `read_sidecars`) against a real encoded AV1 payload, not just the
//! hand-built fixture. The base file's box layout was confirmed by
//! hex-dumping `crate::avif::encode`'s own output; every offset/size this
//! helper touches is re-derived from that real file rather than assumed,
//! except where noted.

use super::tests::bx;
use super::*;

/// Find the first top-level box of type `kind` in `data[start..end]`.
/// Returns its absolute start and total size (header + payload).
#[cfg(feature = "avif")]
fn find_box(data: &[u8], start: usize, end: usize, kind: &[u8; 4]) -> Option<(usize, usize)> {
    let mut idx = start;
    while idx + 8 <= end {
        let size =
            u32::from_be_bytes([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]) as usize;
        if size < 8 || idx + size > end {
            return None;
        }
        if &data[idx + 4..idx + 8] == kind {
            return Some((idx, size));
        }
        idx += size;
    }
    None
}

/// Count the top-level boxes in a flat box stream (used on `ipco`'s
/// payload, which is nothing but sibling property boxes).
#[cfg(feature = "avif")]
fn count_top_level_boxes(data: &[u8]) -> usize {
    let mut idx = 0;
    let mut n = 0;
    while idx + 8 <= data.len() {
        let size =
            u32::from_be_bytes([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]) as usize;
        if size < 8 {
            break;
        }
        n += 1;
        idx += size;
    }
    n
}

/// One `infe` entry (version 2 — see `read_avif_boxes`'s `infe` arm for
/// why this walker only trusts that version).
#[cfg(feature = "avif")]
fn infe_box(item_id: u16, item_type: &[u8; 4]) -> Vec<u8> {
    let mut payload = vec![2u8, 0, 0, 0]; // version 2, flags 0
    payload.extend_from_slice(&item_id.to_be_bytes());
    payload.extend_from_slice(&[0, 0]); // item_protection_index
    payload.extend_from_slice(item_type);
    payload.push(0); // empty, NUL-terminated item_name
    bx(b"infe", &payload)
}

/// One `iloc` extent entry: item_ID(2), data_reference_index(2),
/// extent_count(2)=1, extent_offset(4), extent_length(4) — the
/// version-0/base_offset_size-0/single-extent layout the base file's
/// own (sole, pre-existing) entry already uses.
#[cfg(feature = "avif")]
fn iloc_entry(item_id: u16, offset: u32, length: u32) -> Vec<u8> {
    let mut out = item_id.to_be_bytes().to_vec();
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&offset.to_be_bytes());
    out.extend_from_slice(&length.to_be_bytes());
    out
}

/// Rebuild the whole `iloc` payload: the base file's own version/sizes
/// header bytes, a fresh item_count, then one entry per item.
#[cfg(feature = "avif")]
fn build_iloc_payload(header: &[u8], entries: &[(u16, u32, u32)]) -> Vec<u8> {
    let mut out = header[..6].to_vec();
    out.extend_from_slice(&(entries.len() as u16).to_be_bytes());
    for &(id, offset, length) in entries {
        out.extend(iloc_entry(id, offset, length));
    }
    out
}

/// Splice `irot`/`imir` transform properties (with `ipma` associations)
/// and `Exif`/`mime` metadata items (with `iloc` entries) into a real
/// AVIF encoded by `crate::avif::encode`. `avif-serialize` — what backs
/// `image`'s AVIF encoder, and therefore `crate::avif::encode` — writes
/// none of these (see the Tier 2 plan's decision D5), so this stands in
/// for a full HEIF muxer, test-only.
///
/// Inserting bytes into `meta` (which sits before `mdat` in the base
/// file) shifts everything from `mdat` onward, including the existing
/// `iloc` entry's file offset for the image item — so this builds the
/// new `iloc` box twice: once with placeholder offsets, purely to learn
/// the resulting `meta` size (and hence the shift), then again with the
/// real offsets it can now compute. Both builds are the same length
/// (same entry count and field widths — only the offset values change),
/// which the trailing `assert_eq!` treats as a correctness check on
/// that claim rather than an assumption.
#[cfg(feature = "avif")]
fn mux_avif(
    base: &[u8],
    irot: Option<u8>,
    imir: Option<u8>,
    exif: Option<&[u8]>,
    xmp: Option<&[u8]>,
) -> Vec<u8> {
    let (meta_start, meta_size) =
        find_box(base, 0, base.len(), b"meta").expect("base AVIF has a meta box");
    let meta_end = meta_start + meta_size;
    let children_start = meta_start + 8 + 4; // box header + meta's FullBox version/flags

    let hdlr = find_box(base, children_start, meta_end, b"hdlr").expect("meta has hdlr");
    let pitm = find_box(base, children_start, meta_end, b"pitm").expect("meta has pitm");
    let hdlr_bytes = &base[hdlr.0..hdlr.0 + hdlr.1];
    let pitm_bytes = &base[pitm.0..pitm.0 + pitm.1];

    let iloc_box = find_box(base, children_start, meta_end, b"iloc").expect("meta has iloc");
    let iloc_payload = &base[iloc_box.0 + 8..iloc_box.0 + iloc_box.1];
    let existing_items = parse_iloc(iloc_payload);
    let (image_item_id, orig_offset, orig_length) = existing_items
        .first()
        .copied()
        .expect("iloc has the image item");

    let iinf_box = find_box(base, children_start, meta_end, b"iinf").expect("meta has iinf");
    let iinf_payload = &base[iinf_box.0 + 8..iinf_box.0 + iinf_box.1];
    let existing_item_count = u16::from_be_bytes([iinf_payload[4], iinf_payload[5]]);

    let (iprp_start, iprp_size) =
        find_box(base, children_start, meta_end, b"iprp").expect("meta has iprp");
    let iprp_end = iprp_start + iprp_size;
    let ipco = find_box(base, iprp_start + 8, iprp_end, b"ipco").expect("iprp has ipco");
    let ipma = find_box(base, iprp_start + 8, iprp_end, b"ipma").expect("iprp has ipma");
    let ipco_payload = &base[ipco.0 + 8..ipco.0 + ipco.1];
    let ipma_payload = &base[ipma.0 + 8..ipma.0 + ipma.1];

    // New `ipco`: the existing properties, plus one box per requested
    // transform, associated to the (sole) primary item via `ipma`.
    let existing_prop_count = count_top_level_boxes(ipco_payload) as u8;
    let mut new_props = Vec::new();
    let mut new_indices: Vec<u8> = Vec::new();
    let mut next_index = existing_prop_count + 1;
    for (kind, value) in [(*b"irot", irot), (*b"imir", imir)] {
        if let Some(v) = value {
            new_props.extend(bx(&kind, &[v]));
            new_indices.push(next_index);
            next_index += 1;
        }
    }
    let mut new_ipco_payload = ipco_payload.to_vec();
    new_ipco_payload.extend_from_slice(&new_props);
    let new_ipco_box = bx(b"ipco", &new_ipco_payload);

    // `ipma`: version/flags(4) + entry_count(4) + item_ID(2) +
    // assoc_count(1) + one byte per association (flags bit 0 is 0 in
    // the base file, so indices are 7-bit, essential-flag 0).
    let old_assoc_count = ipma_payload[10] as usize;
    let mut new_ipma_payload = ipma_payload[..10].to_vec();
    new_ipma_payload.push((old_assoc_count + new_indices.len()) as u8);
    new_ipma_payload.extend_from_slice(&ipma_payload[11..11 + old_assoc_count]);
    new_ipma_payload.extend(new_indices.iter().map(|i| i & 0x7f));
    let new_ipma_box = bx(b"ipma", &new_ipma_payload);

    let new_iprp_box = bx(b"iprp", &[new_ipco_box, new_ipma_box].concat());

    // New `iinf`: the existing entry copied verbatim, plus one `infe`
    // per metadata item requested, with fresh IDs after the existing
    // ones.
    let mut extra_ids: Vec<(u16, [u8; 4])> = Vec::new();
    let mut next_id = existing_item_count + 1;
    if exif.is_some() {
        extra_ids.push((next_id, *b"Exif"));
        next_id += 1;
    }
    if xmp.is_some() {
        extra_ids.push((next_id, *b"mime"));
    }
    let new_entry_count = existing_item_count + extra_ids.len() as u16;
    let mut new_iinf_payload = iinf_payload[..4].to_vec();
    new_iinf_payload.extend_from_slice(&new_entry_count.to_be_bytes());
    new_iinf_payload.extend_from_slice(&iinf_payload[6..]);
    for (id, kind) in &extra_ids {
        new_iinf_payload.extend(infe_box(*id, kind));
    }
    let new_iinf_box = bx(b"iinf", &new_iinf_payload);

    // The 4-byte TIFF-header-offset prefix an `Exif` item carries (see
    // `read_avif_boxes`'s `exif` line) counts toward its extent length.
    let exif_len = exif.map(|e| 4 + e.len());
    let xmp_len = xmp.map(|x| x.len());
    let build_iloc = |image_offset: u32, exif_offset: u32, xmp_offset: u32| -> Vec<u8> {
        let mut ids = extra_ids.iter();
        let mut entries = vec![(image_item_id, image_offset, orig_length as u32)];
        if let Some(len) = exif_len {
            let (id, _) = ids.next().expect("an Exif id was reserved");
            entries.push((*id, exif_offset, len as u32));
        }
        if let Some(len) = xmp_len {
            let (id, _) = ids.next().expect("a mime id was reserved");
            entries.push((*id, xmp_offset, len as u32));
        }
        build_iloc_payload(iloc_payload, &entries)
    };

    let assemble_meta = |iloc_box: &[u8]| -> Vec<u8> {
        let mut payload = base[meta_start + 8..meta_start + 12].to_vec(); // version/flags
        payload.extend_from_slice(hdlr_bytes);
        payload.extend_from_slice(pitm_bytes);
        payload.extend_from_slice(iloc_box);
        payload.extend_from_slice(&new_iinf_box);
        payload.extend_from_slice(&new_iprp_box);
        bx(b"meta", &payload)
    };

    let placeholder_iloc = bx(b"iloc", &build_iloc(0, 0, 0));
    let placeholder_meta = assemble_meta(&placeholder_iloc);
    let delta = placeholder_meta.len() as i64 - meta_size as i64;

    let real_image_offset = (orig_offset as i64 + delta) as u32;
    let real_exif_offset = (base.len() as i64 + delta) as u32;
    let real_xmp_offset = real_exif_offset + exif_len.unwrap_or(0) as u32;
    let real_iloc = bx(
        b"iloc",
        &build_iloc(real_image_offset, real_exif_offset, real_xmp_offset),
    );
    let real_meta = assemble_meta(&real_iloc);
    assert_eq!(
        real_meta.len(),
        placeholder_meta.len(),
        "iloc offset values must not change the box's byte length"
    );

    let mut out = Vec::with_capacity(real_meta.len() + base.len());
    out.extend_from_slice(&base[..meta_start]);
    out.extend_from_slice(&real_meta);
    out.extend_from_slice(&base[meta_end..]);
    if let Some(exif) = exif {
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(exif);
    }
    if let Some(xmp) = xmp {
        out.extend_from_slice(xmp);
    }
    out
}

#[cfg(feature = "avif")]
#[test]
fn a_real_avif_with_an_exif_item_yields_the_block() {
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let rgb: Vec<u8> = vec![120u8; 16 * 16 * 3];
    let base = crate::avif::encode(16, 16, &rgb, 60).unwrap();
    let muxed = mux_avif(&base, None, None, Some(&exif), None);
    let found = read_avif_boxes(&muxed);
    assert_eq!(found.exif.as_deref(), Some(exif.as_slice()));
}

#[cfg(feature = "avif")]
#[test]
fn a_real_avif_probe_reports_the_container_orientation() {
    let rgb: Vec<u8> = vec![128u8; 8 * 8 * 3];
    let base = crate::avif::encode(8, 8, &rgb, 60).unwrap();
    // irot step 1 (90 CCW), no mirror -> EXIF 8.
    let muxed = mux_avif(&base, Some(1), None, None, None);
    let meta = crate::raster::probe_raster_metadata(&muxed).unwrap();
    assert_eq!(
        meta.orientation, 8,
        "probe_raster_metadata must stop hardcoding 1"
    );
}

#[cfg(feature = "avif")]
#[test]
fn read_sidecars_returns_both_exif_and_xmp_items_from_a_real_avif() {
    let rgb: Vec<u8> = vec![100u8; 16 * 16 * 3];
    let base = crate::avif::encode(16, 16, &rgb, 60).unwrap();
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
    let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#.to_vec();
    let muxed = mux_avif(&base, None, None, Some(&exif), Some(&xmp));
    let sidecars = crate::raster_meta::read_sidecars(&muxed);
    assert_eq!(sidecars.exif.as_deref(), Some(exif.as_slice()));
    assert_eq!(sidecars.xmp.as_deref(), Some(xmp.as_slice()));
    assert_eq!(
        sidecars.icc, None,
        "avif-serialize writes no colr box for this fixture"
    );
}

#[cfg(feature = "avif")]
#[test]
fn an_avif_probe_no_longer_hardcodes_orientation_one() {
    // Encode an AVIF carrying an EXIF block whose Orientation tag is 6,
    // and confirm read_sidecars + the orientation parser report it
    // rather than the metadata being unreachable.
    let exif = {
        let mut tiff = vec![0u8; 26];
        tiff[..2].copy_from_slice(b"II");
        tiff[2..4].copy_from_slice(&42u16.to_le_bytes());
        tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
        tiff[10..12].copy_from_slice(&0x0112u16.to_le_bytes());
        tiff[12..14].copy_from_slice(&3u16.to_le_bytes());
        tiff[14..18].copy_from_slice(&1u32.to_le_bytes());
        tiff[18..20].copy_from_slice(&6u16.to_le_bytes());
        tiff
    };
    let rgb: Vec<u8> = vec![90u8; 16 * 16 * 3];
    let base = crate::avif::encode(16, 16, &rgb, 60).unwrap();
    let muxed = mux_avif(&base, None, None, Some(&exif), None);
    let sidecars = crate::raster_meta::read_sidecars(&muxed);
    let orientation = sidecars
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block)
        .unwrap_or(1);
    assert_eq!(orientation, 6, "the EXIF item's Orientation tag was lost");
}
