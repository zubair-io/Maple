//! Hand-built ISO-BMFF fixture tests for [`super`] (#3507): everything that
//! exercises `read_avif_boxes` directly against small, purpose-built box
//! streams rather than a real encoder's output (that's the sibling
//! `avif_boxes_encoder_tests.rs`, which needs the `avif` feature).
//!
//! Sibling of `avif_boxes.rs`, split out once the box walker itself grew
//! past the 400-line soft budget and pushed the combined file past the
//! 600-line hard budget (CONTRIBUTING.md § "File-size budget") — same
//! `#[path]` sibling pattern `stages/hsl.rs` uses. Still registered as
//! `mod tests` from `avif_boxes.rs`, so `avif_boxes_encoder_tests.rs`'s
//! `use super::tests::bx;` is unaffected by the split.

use super::*;

/// Build a box: 4-byte big-endian size, 4-byte type, payload. `pub(super)`
/// so the sibling `encoder_tests` module (a descendant of `avif_boxes`,
/// same as this one) can reach it as `super::tests::bx`.
pub(super) fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    [&size.to_be_bytes()[..], kind, payload].concat()
}

/// Count the top-level boxes in a flat box stream — used to number
/// `ipco`'s properties 1-based when building a default "associate
/// everything with item 1" fixture.
fn count_boxes(data: &[u8]) -> usize {
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

/// A minimal but spec-complete AVIF-shaped file: `ftyp` + `meta{pitm(item
/// 1), iprp{ipco{props}, ipma{item 1 -> assoc_indices}}}`. The more
/// explicit form for tests that need a specific, possibly out-of-range
/// or otherwise unusual association list; `avif_with_ipco` below is the
/// common case of "associate everything, in order".
fn avif_with_ipco_and_associations(props: &[u8], assoc_indices: &[u8]) -> Vec<u8> {
    let ftyp = bx(b"ftyp", b"avif\0\0\0\0avifmif1");
    let ipco = bx(b"ipco", props);
    // ipma: version 0 (7-bit indices), one entry, for item 1.
    let mut ipma_payload = vec![0u8, 0, 0, 0];
    ipma_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count = 1
    ipma_payload.extend_from_slice(&1u16.to_be_bytes()); // item_ID = 1
    ipma_payload.push(assoc_indices.len() as u8);
    ipma_payload.extend(assoc_indices.iter().map(|i| i & 0x7f));
    let ipma = bx(b"ipma", &ipma_payload);
    let iprp = bx(b"iprp", &[ipco, ipma].concat());
    // pitm: version 0, item_ID = 1.
    let pitm = bx(b"pitm", &[0u8, 0, 0, 0, 0, 1]);
    // `meta` is a FullBox: one version byte plus three flag bytes.
    let meta = bx(b"meta", &[vec![0u8, 0, 0, 0], pitm, iprp].concat());
    [ftyp, meta].concat()
}

/// A minimal AVIF-shaped file: `ftyp` + `meta{pitm(item 1), iprp{ipco{
/// props}, ipma{item 1 -> every property in props, in order}}}`. Item 1
/// is the primary item, associated with everything `props` carries —
/// what most of this module's tests want.
fn avif_with_ipco(props: &[u8]) -> Vec<u8> {
    let count = count_boxes(props) as u8;
    let assoc_indices: Vec<u8> = (1..=count).collect();
    avif_with_ipco_and_associations(props, &assoc_indices)
}

#[test]
fn no_transform_properties_means_orientation_one() {
    let file = avif_with_ipco(&[]);
    assert_eq!(read_avif_boxes(&file).transform, 1);
}

#[test]
fn irot_maps_onto_the_exif_rotations() {
    // irot payload is one byte whose low two bits are the CCW step count.
    for (step, expected) in [(0u8, 1u16), (1, 8), (2, 3), (3, 6)] {
        let file = avif_with_ipco(&bx(b"irot", &[step]));
        assert_eq!(
            read_avif_boxes(&file).transform,
            expected,
            "irot {step} should be EXIF {expected}"
        );
    }
}

#[test]
fn imir_maps_onto_the_exif_mirrors() {
    // axis 0 = top/bottom exchanged -> EXIF 4; axis 1 = left/right
    // exchanged -> EXIF 2 (libavif's `avif.h`; see the module doc).
    assert_eq!(
        read_avif_boxes(&avif_with_ipco(&bx(b"imir", &[0]))).transform,
        4
    );
    assert_eq!(
        read_avif_boxes(&avif_with_ipco(&bx(b"imir", &[1]))).transform,
        2
    );
}

#[test]
fn irot_and_imir_together_map_onto_the_transposed_orientations() {
    let props = [bx(b"irot", &[1]), bx(b"imir", &[1])].concat();
    // 90 CCW then a left-right mirror is EXIF 7 (transverse), not 5: the
    // mirror runs on the already-rotated image, so the left/right axis it
    // exchanges is the rotated one. Measured against libheif 1.20.2 (#3507
    // final fix wave, item 1) — this assertion pinned 5 before that.
    assert_eq!(read_avif_boxes(&avif_with_ipco(&props)).transform, 7);
}

#[test]
fn irot_and_imir_together_map_onto_orientation_five() {
    // ORIENTATION_TABLE[1][1] == 5: 90 CCW (irot step 1) then a top/bottom
    // mirror (imir axis 0) is EXIF 5 (transpose) — measured against
    // libheif 1.20.2; this assertion pinned 7 before the fix.
    let props = [bx(b"irot", &[1]), bx(b"imir", &[0])].concat();
    assert_eq!(read_avif_boxes(&avif_with_ipco(&props)).transform, 5);
}

#[test]
fn the_association_order_decides_the_composition() {
    // libheif applies the transform properties in the order `ipma` lists
    // them, not the spec's fixed crop-rotate-mirror order — measured by
    // swapping nothing but the two association bytes of a real
    // sharp-written AVIF and decoding it through sharp: `irot 3` + `imir
    // 1` listed as [irot, imir] decodes as EXIF 5, and as [imir, irot] as
    // EXIF 7 (#3507 round 2). Maple reproduces both.
    let props = [bx(b"irot", &[3]), bx(b"imir", &[1])].concat();
    let forward = avif_with_ipco_and_associations(&props, &[1, 2]);
    let reversed = avif_with_ipco_and_associations(&props, &[2, 1]);
    assert_eq!(read_avif_boxes(&forward).transform, 5);
    assert_eq!(read_avif_boxes(&reversed).transform, 7);
}

#[test]
fn every_irot_imir_combination_matches_libheif() {
    // The full 12-entry table, each row measured against libheif 1.20.2 by
    // patching the irot/imir bytes of a sharp-written AVIF and matching the
    // decoded pixels to one of the eight EXIF transforms of the source (see
    // `ORIENTATION_TABLE`'s doc). Kept as one table-driven case so a future
    // edit to the table has to disagree with the measurement to pass.
    const MEASURED: [(u8, Option<u8>, u16); 12] = [
        (0, None, 1),
        (0, Some(0), 4),
        (0, Some(1), 2),
        (1, None, 8),
        (1, Some(0), 5),
        (1, Some(1), 7),
        (2, None, 3),
        (2, Some(0), 2),
        (2, Some(1), 4),
        (3, None, 6),
        (3, Some(0), 7),
        (3, Some(1), 5),
    ];
    for (angle, axis, expected) in MEASURED {
        let props = match axis {
            Some(axis) => [bx(b"irot", &[angle]), bx(b"imir", &[axis])].concat(),
            None => bx(b"irot", &[angle]),
        };
        assert_eq!(
            read_avif_boxes(&avif_with_ipco(&props)).transform,
            expected,
            "irot {angle} imir {axis:?} should be EXIF {expected}"
        );
    }
}

#[test]
fn orientation_comes_from_the_primary_items_own_associations() {
    // Two image items, two distinct `irot` properties: item 1 (the
    // primary, per `pitm`) is associated with property 1 (90 CCW ->
    // EXIF 8 alone); item 2 is associated with property 2 (180 ->
    // EXIF 3 alone). The result must be item 1's own orientation, never
    // item 2's, regardless of how `ipco`/`ipma` order the properties.
    let ftyp = bx(b"ftyp", b"avif\0\0\0\0avifmif1");
    let irot_a = bx(b"irot", &[1]);
    let irot_b = bx(b"irot", &[2]);
    let ipco = bx(b"ipco", &[irot_a, irot_b].concat()); // index 1 = A, index 2 = B

    let mut ipma_payload = vec![0u8, 0, 0, 0];
    ipma_payload.extend_from_slice(&2u32.to_be_bytes()); // entry_count = 2
    ipma_payload.extend_from_slice(&1u16.to_be_bytes()); // item_ID = 1
    ipma_payload.push(1);
    ipma_payload.push(1); // -> property index 1 (irot_a)
    ipma_payload.extend_from_slice(&2u16.to_be_bytes()); // item_ID = 2
    ipma_payload.push(1);
    ipma_payload.push(2); // -> property index 2 (irot_b)
    let ipma = bx(b"ipma", &ipma_payload);

    let iprp = bx(b"iprp", &[ipco, ipma].concat());
    let pitm = bx(b"pitm", &[0u8, 0, 0, 0, 0, 1]); // primary item = 1
    let meta = bx(b"meta", &[vec![0u8, 0, 0, 0], pitm, iprp].concat());
    let file = [ftyp, meta].concat();

    assert_eq!(
        read_avif_boxes(&file).transform,
        8,
        "must report the primary item's own irot, not the secondary item's"
    );
}

#[test]
fn an_ipma_association_past_the_ipco_list_is_ignored() {
    // Only one property (irot, index 1) exists; the association claims
    // index 5, which `ipco` doesn't have.
    let file = avif_with_ipco_and_associations(&bx(b"irot", &[1]), &[5]);
    assert_eq!(read_avif_boxes(&file).transform, 1);
}

#[test]
fn a_truncated_ipma_box_means_orientation_one() {
    let ftyp = bx(b"ftyp", b"avif\0\0\0\0avifmif1");
    let ipco = bx(b"ipco", &bx(b"irot", &[1]));
    // Declares one entry (entry_count = 1) but the bytes stop right
    // after — no item_ID, no association_count, nothing.
    let ipma = bx(b"ipma", &[0u8, 0, 0, 0, 0, 0, 0, 1]);
    let iprp = bx(b"iprp", &[ipco, ipma].concat());
    let pitm = bx(b"pitm", &[0u8, 0, 0, 0, 0, 1]);
    let meta = bx(b"meta", &[vec![0u8, 0, 0, 0], pitm, iprp].concat());
    let file = [ftyp, meta].concat();
    assert_eq!(read_avif_boxes(&file).transform, 1);
}

#[test]
fn garbage_and_truncation_never_panic() {
    for input in [
        &b""[..],
        b"\0\0\0\x08ftyp",
        b"\xff\xff\xff\xffftypavif",
        &avif_with_ipco(&bx(b"irot", &[]))[..],
    ] {
        let _ = read_avif_boxes(input);
    }
}

#[test]
fn a_probe_reports_the_real_orientation() {
    let file = avif_with_ipco(&bx(b"irot", &[1]));
    // `probe_raster_metadata` cannot decode this synthetic container's
    // pixels, but `read_avif_boxes` is what feeds it the orientation.
    assert_eq!(read_avif_boxes(&file).transform, 8);
}

/// A hand-built AVIF-shaped file whose `iloc` uses `base_offset_size = 4`:
/// one `Exif` item (id 1) and one `mime`/XMP item (id 2), each located as
/// `base_offset + extent_offset` with the split chosen by the caller. The
/// payload bytes are appended after `meta`, and the offsets are patched in
/// a second pass once their real file position is known (the `iloc` box's
/// size doesn't depend on the values, so the two passes agree on layout).
fn avif_with_located_items(
    exif_item: &[u8],
    xmp_item: &[u8],
    split: fn(usize) -> (u32, u32),
) -> Vec<u8> {
    let build = |exif_at: usize, xmp_at: usize| -> Vec<u8> {
        let ftyp = bx(b"ftyp", b"avif\0\0\0\0avifmif1");
        let pitm = bx(b"pitm", &[0u8, 0, 0, 0, 0, 9]); // primary item is the image
        let mut iinf_payload = vec![0u8, 0, 0, 0];
        iinf_payload.extend_from_slice(&2u16.to_be_bytes());
        for (id, kind) in [(1u16, b"Exif"), (2u16, b"mime")] {
            let mut infe = vec![2u8, 0, 0, 0];
            infe.extend_from_slice(&id.to_be_bytes());
            infe.extend_from_slice(&[0, 0]);
            infe.extend_from_slice(kind);
            infe.push(0);
            iinf_payload.extend(bx(b"infe", &infe));
        }
        let iinf = bx(b"iinf", &iinf_payload);
        // iloc version 0: offset_size 4, length_size 4, base_offset_size 4.
        let mut iloc_payload = vec![0u8, 0, 0, 0, 0x44, 0x40];
        iloc_payload.extend_from_slice(&2u16.to_be_bytes());
        for (id, at, len) in [
            (1u16, exif_at, exif_item.len()),
            (2u16, xmp_at, xmp_item.len()),
        ] {
            let (base, extent) = split(at);
            iloc_payload.extend_from_slice(&id.to_be_bytes());
            iloc_payload.extend_from_slice(&[0, 0]); // data_reference_index
            iloc_payload.extend_from_slice(&base.to_be_bytes());
            iloc_payload.extend_from_slice(&1u16.to_be_bytes()); // extent_count
            iloc_payload.extend_from_slice(&extent.to_be_bytes());
            iloc_payload.extend_from_slice(&(len as u32).to_be_bytes());
        }
        let iloc = bx(b"iloc", &iloc_payload);
        let meta = bx(b"meta", &[vec![0u8, 0, 0, 0], pitm, iinf, iloc].concat());
        [ftyp, meta].concat()
    };
    let header_len = build(0, 0).len();
    let mut out = build(header_len, header_len + exif_item.len());
    out.extend_from_slice(exif_item);
    out.extend_from_slice(xmp_item);
    out
}

/// The `Exif` item payload shape ISO/IEC 23008-12 Annex A.2.1 defines: a
/// 4-byte offset to the TIFF header, then the block.
fn exif_item_payload(tiff: &[u8]) -> Vec<u8> {
    [&[0u8, 0, 0, 0][..], tiff].concat()
}

#[test]
fn iloc_base_offset_locates_the_metadata_items() {
    // libheif/libvips and libavif put the item's real file position in
    // `base_offset` and leave `extent_offset` at 0 — ignoring the base
    // offset made every such file's `exif`/`xmp` read from byte 0 (#3507
    // final fix wave, item 2; measured on a sharp-written AVIF whose
    // `exif` came back as its own `ftypavif...` header).
    let tiff = b"II*\0\x08\0\0\0\0\0";
    let xmp = b"<x:xmpmeta/>";
    let file = avif_with_located_items(&exif_item_payload(tiff), xmp, |at| (at as u32, 0));
    let boxes = read_avif_boxes(&file);
    assert_eq!(boxes.exif.as_deref(), Some(&tiff[..]));
    assert_eq!(boxes.xmp.as_deref(), Some(&xmp[..]));
}

#[test]
fn iloc_splits_the_location_across_base_and_extent_offsets() {
    // Either field may carry part of the location; the item starts at
    // their sum.
    let tiff = b"MM\0*\0\0\0\x08\0\0";
    let xmp = b"<x:xmpmeta id=\"2\"/>";
    // `saturating_sub` only matters for the layout pass's placeholder
    // offsets of 0; the real second pass is always past the header.
    let file = avif_with_located_items(&exif_item_payload(tiff), xmp, |at| {
        ((at as u32).saturating_sub(4), 4)
    });
    let boxes = read_avif_boxes(&file);
    assert_eq!(boxes.exif.as_deref(), Some(&tiff[..]));
    assert_eq!(boxes.xmp.as_deref(), Some(&xmp[..]));
}

#[test]
fn iloc_offset_sum_that_overflows_yields_no_items() {
    let file = avif_with_located_items(&exif_item_payload(b"II*\0\x08\0\0\0"), b"x", |_| {
        (u32::MAX, u32::MAX)
    });
    let boxes = read_avif_boxes(&file);
    assert_eq!(boxes.exif, None);
    assert_eq!(boxes.xmp, None);
}
