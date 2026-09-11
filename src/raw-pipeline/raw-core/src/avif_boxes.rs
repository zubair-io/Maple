//! A minimal ISO-BMFF property walker for AVIF (#3507).
//!
//! `avif-parse` 2.1.0 gives us the AV1 payloads and nothing else — it exposes
//! neither the `irot`/`imir` transform properties nor the `Exif` and XMP
//! metadata items. That is why `probe_raster_metadata` reported
//! `orientation: 1` for every AVIF, which made `.rotate()` a silent no-op on
//! an AVIF source and left the server's AVIF orientation checks structurally
//! dead.
//!
//! This walks `meta` -> `iprp` -> `ipco` for the transform properties and
//! `meta` -> `iinf` + `iloc` for the metadata items. It never allocates for a
//! file that has neither, and it is total: a malformed box stream stops the
//! walk rather than panicking. Same discipline `raster_meta.rs` uses, for the
//! same reason — every offset comes from `get(..)`, and every addition that
//! could overflow goes through `checked_add`, so a hostile or truncated file
//! (including a declared box size near `u32::MAX`) yields `None`/default
//! fields rather than a panic or, on the 32-bit `usize` of the wasm32 target
//! this crate also builds for, a silent wraparound into an in-bounds-but-
//! wrong read.
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
//! file follows that: axis 0 is a top/bottom (vertical) flip — EXIF 4 alone
//! — axis 1 is a left/right (horizontal) flip — EXIF 2 alone. Some
//! HEIF-derived write-ups instead name the axis of reflection ("axis 0 = the
//! vertical axis") rather than the effect, which is easy to invert: a
//! reflection across a *vertical* line swaps left and right, not top and
//! bottom, so reading that phrasing as "axis 0 -> top/bottom" is backwards.
//! This is exactly the "older docs swap this" trap — this file follows
//! libavif's effect-first wording (and matches sharp/libvips' `heif` loader,
//! which maps the same two properties to EXIF orientation the same way)
//! rather than the axis-name phrasing.
//!
//! The eight EXIF orientations are exactly the eight combinations of a
//! 90-degree-step rotation and an optional mirror, so `ORIENTATION_TABLE` is
//! a lookup rather than a computation.

/// The parts of an AVIF container `avif-parse` does not surface.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AvifBoxes {
    /// EXIF orientation, 1..=8. `1` when the file carries no transform.
    pub orientation: u16,
    pub exif: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
}

/// `[rotation_steps][mirror]`, where mirror is 0 = none, 1 = axis 0
/// (top/bottom exchanged), 2 = axis 1 (left/right exchanged). Rotation is
/// counter-clockwise in 90-degree steps, as `irot` defines it — see the
/// module doc for the source and the axis-convention caveat.
const ORIENTATION_TABLE: [[u16; 3]; 4] = [
    [1, 4, 2], // no rotation
    [8, 7, 5], // 90 CCW
    [3, 2, 4], // 180
    [6, 5, 7], // 270 CCW
];

/// Call `visit` for every top-level box in `data`, depth-first into the
/// containers named in `recurse_into`. Stops cleanly at the first malformed
/// header, truncated payload, or arithmetic overflow rather than panicking.
fn walk(data: &[u8], recurse_into: &[&[u8; 4]], visit: &mut impl FnMut(&[u8; 4], &[u8])) {
    let mut idx = 0usize;
    loop {
        let Some(header_end) = idx.checked_add(8) else {
            return;
        };
        if header_end > data.len() {
            return;
        }
        let size =
            u32::from_be_bytes([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]) as usize;
        let kind: [u8; 4] = [data[idx + 4], data[idx + 5], data[idx + 6], data[idx + 7]];
        // `size == 0` means "box runs to the end of the buffer it's in";
        // `size == 1` means a 64-bit largesize follows, which no box this
        // walk cares about ever uses — treated as unsupported.
        let Some(end) = (match size {
            0 => Some(data.len()),
            1 => None,
            n if n < 8 => None,
            n => idx.checked_add(n),
        }) else {
            return;
        };
        let Some(payload) = data.get(header_end..end.min(data.len())) else {
            return;
        };
        if recurse_into.contains(&&kind) {
            // `meta` is a FullBox (version+flags, 4 bytes) and `iinf` is a
            // FullBox followed by its own 2-byte entry_count — both prefix
            // their children with fields this walk doesn't need. `iprp` and
            // `ipco` are plain boxes whose payload is immediately children.
            let children = if &kind == b"meta" {
                payload.get(4..).unwrap_or(&[])
            } else if &kind == b"iinf" {
                payload.get(6..).unwrap_or(&[])
            } else {
                payload
            };
            walk(children, recurse_into, visit);
        } else {
            visit(&kind, payload);
        }
        idx = end;
    }
}

/// Walk `bytes` for `irot`/`imir` transform properties and `Exif`/`mime`
/// (XMP) metadata items, returning the real EXIF orientation and the raw
/// item payloads. A file with none of these — or that isn't a well-formed
/// ISO-BMFF stream at all — reports orientation `1` and no items.
pub fn read_avif_boxes(bytes: &[u8]) -> AvifBoxes {
    let mut rotation = 0usize;
    let mut mirror = 0usize;
    let mut item_types: Vec<(u16, [u8; 4])> = Vec::new();
    let mut item_offsets: Vec<(u16, usize, usize)> = Vec::new();

    walk(
        bytes,
        &[b"meta", b"iprp", b"ipco", b"iinf"],
        &mut |kind, payload| match kind {
            b"irot" => {
                if let Some(&byte) = payload.first() {
                    rotation = (byte & 0b11) as usize;
                }
            }
            b"imir" => {
                if let Some(&byte) = payload.first() {
                    mirror = (byte & 1) as usize + 1;
                }
            }
            b"infe" => {
                // FullBox; version 2 (what every real-world AVIF muxer with
                // this few items writes) lays out: version/flags(4),
                // item_ID(2), item_protection_index(2), item_type(4), then a
                // NUL-terminated item_name this walker doesn't need. Version
                // 0/1 has no item_type field at all, so only version 2 (and
                // 3, which this doesn't special-case since a handful of
                // items never needs a 32-bit item_ID) is trusted.
                if payload.first() == Some(&2) {
                    if let (Some(id_bytes), Some(type_bytes)) =
                        (payload.get(4..6), payload.get(8..12))
                    {
                        let id = u16::from_be_bytes([id_bytes[0], id_bytes[1]]);
                        let item_kind =
                            [type_bytes[0], type_bytes[1], type_bytes[2], type_bytes[3]];
                        item_types.push((id, item_kind));
                    }
                }
            }
            b"iloc" => item_offsets = parse_iloc(payload),
            _ => {}
        },
    );

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
        orientation: ORIENTATION_TABLE[rotation][mirror],
        exif,
        xmp,
    }
}

/// `iloc` version 0 or 1, construction method 0 (file offsets), one extent
/// per item — which is what every AVIF muxer in practice writes for a
/// metadata item. Returns `(item_id, offset, length)`.
fn parse_iloc(payload: &[u8]) -> Vec<(u16, usize, usize)> {
    let Some(&version) = payload.first() else {
        return Vec::new();
    };
    if version > 1 || payload.len() < 8 {
        return Vec::new();
    }
    let sizes = payload[4];
    let (offset_size, length_size) = ((sizes >> 4) as usize, (sizes & 0xF) as usize);
    let base_size = (payload[5] >> 4) as usize;
    let index_size = if version == 1 {
        (payload[5] & 0xF) as usize
    } else {
        0
    };
    let count = u16::from_be_bytes([payload[6], payload[7]]) as usize;
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
        let Some(extents_at) = after_id
            .checked_add(2)
            .and_then(|v| v.checked_add(base_size))
            .and_then(|v| v.checked_add(2))
        else {
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
        let offset = read_be(&extent[index_size..index_size + offset_size]);
        let length = read_be(&extent[index_size + offset_size..]);
        out.push((id, offset, length));
        at = extent_end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a box: 4-byte big-endian size, 4-byte type, payload. `pub(super)`
    /// so the sibling `encoder_tests` module (a descendant of `avif_boxes`,
    /// same as this one) can reach it as `super::tests::bx`.
    pub(super) fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (8 + payload.len()) as u32;
        [&size.to_be_bytes()[..], kind, payload].concat()
    }

    /// A minimal AVIF-shaped file: ftyp + meta{iprp{ipco{...}}}.
    fn avif_with_ipco(props: &[u8]) -> Vec<u8> {
        let ftyp = bx(b"ftyp", b"avif\0\0\0\0avifmif1");
        let ipco = bx(b"ipco", props);
        let iprp = bx(b"iprp", &ipco);
        // `meta` is a FullBox: one version byte plus three flag bytes.
        let meta = bx(b"meta", &[&[0u8, 0, 0, 0][..], &iprp].concat());
        [ftyp, meta].concat()
    }

    #[test]
    fn no_transform_properties_means_orientation_one() {
        let file = avif_with_ipco(&[]);
        assert_eq!(read_avif_boxes(&file).orientation, 1);
    }

    #[test]
    fn irot_maps_onto_the_exif_rotations() {
        // irot payload is one byte whose low two bits are the CCW step count.
        for (step, expected) in [(0u8, 1u16), (1, 8), (2, 3), (3, 6)] {
            let file = avif_with_ipco(&bx(b"irot", &[step]));
            assert_eq!(
                read_avif_boxes(&file).orientation,
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
            read_avif_boxes(&avif_with_ipco(&bx(b"imir", &[0]))).orientation,
            4
        );
        assert_eq!(
            read_avif_boxes(&avif_with_ipco(&bx(b"imir", &[1]))).orientation,
            2
        );
    }

    #[test]
    fn irot_and_imir_together_map_onto_the_transposed_orientations() {
        let props = [bx(b"irot", &[1]), bx(b"imir", &[1])].concat();
        // 90 CCW plus a left-right mirror is EXIF 5 (transpose).
        assert_eq!(read_avif_boxes(&avif_with_ipco(&props)).orientation, 5);
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
        assert_eq!(read_avif_boxes(&file).orientation, 8);
    }
}

#[cfg(test)]
#[path = "avif_boxes_encoder_tests.rs"]
mod encoder_tests;
