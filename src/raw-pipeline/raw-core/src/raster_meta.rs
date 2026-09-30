//! Read the metadata blocks a container carries (#3507), so `metadata()` can
//! report them and `keepMetadata()` can hand them straight back to an encoder.
//!
//! * JPEG: APP1 `Exif\0\0`, APP2 `ICC_PROFILE\0` (reassembled across its
//!   chunk sequence — see `assemble_icc_chunks` for how a dropped or
//!   duplicated chunk is caught rather than silently mis-joined), APP1
//!   `http://ns.adobe.com/xap/1.0/\0` for XMP, and the APP0 JFIF density.
//!   Marker codes may be preceded by `0xFF` fill bytes, and standalone
//!   markers (`RSTn`, `TEM`) carry no length field — both are handled.
//! * PNG: `eXIf`, `iCCP` (zlib-deflated), the `XML:com.adobe.xmp` keyword
//!   in an `iTXt` (plain or zlib-compressed, per its own compression flag),
//!   a `tEXt` (plain — the form libvips writes) or a `zTXt` (deflated), and
//!   `pHYs` for density, defaulting to 72 dpi like a JPEG's. Every zlib stream here is inflated under the
//!   [`MAX_SIDECAR_BYTES`] ceiling — see `inflate_bounded`.
//! * TIFF: the IFD0 `InterColorProfile` (34675) and `XMLPacket` (700) tags.
//!   No EXIF block — a TIFF's IFD0 *is* its EXIF, and sharp reports none for
//!   a TIFF (see `read_tiff`). Only a byte-sized TIFF type
//!   (BYTE/ASCII/UNDEFINED) is trusted to mean "the declared count is a byte
//!   length".
//! * WebP: the `EXIF`, `ICCP` and `XMP ` RIFF chunks. No density — libvips
//!   reports none for a WebP however the file was written (measured), not
//!   even from an EXIF `XResolution` the chunk carries.
//! * AVIF: the `Exif` and `mime` (XMP) items `crate::avif_boxes` reads out of
//!   the container's `meta`/`iinf`/`iloc` item boxes — a completely
//!   different shape from the chunk/segment streams above, so it dispatches
//!   straight to that module rather than growing a fifth walker here. No ICC
//!   here either: it would live in a `colr` box of type `prof`, which
//!   `avif-serialize` (what backs this crate's own AVIF encoder) cannot
//!   write and Maple therefore does not read back (Tier 2 plan decision D5).
//!
//! Everything here is READ-ONLY and allocation-light: a container with no
//! metadata costs one linear scan of its header. Every offset comes from
//! `get(..)` fed by `checked_add`/`checked_mul` arithmetic, never direct
//! index arithmetic or unchecked `+` that could panic — or, on the 32-bit
//! `usize` of the wasm32 target this crate also builds for, silently wrap
//! into a bogus-but-in-bounds offset — on a truncated or hostile file. A
//! corrupt container yields `None` fields, not a panic (see
//! `raster_meta_tests.rs`'s truncation sweep).

/// Metadata blocks a container carries, in their canonical byte form: the
/// EXIF block starts at the TIFF header (`II*\0` / `MM\0*`) for EVERY
/// container, the ICC profile is the raw profile, the XMP packet is the XML.
///
/// The EXIF rule is what [`canonical_exif`] enforces, and it is load-bearing
/// rather than cosmetic (#3507 final fix wave, item 3). JPEG's APP1 segment,
/// WebP's `EXIF` chunk as libvips writes it, and an AVIF `Exif` item all
/// store a 6-byte `Exif\0\0` introducer ahead of the TIFF header, while
/// PNG's `eXIf` chunk stores the TIFF header bare. Keeping whichever form
/// the input happened to use meant a WebP→JPEG `keepMetadata()` wrote a
/// doubly-introduced block no reader could parse (measured: sharp read
/// `orientation: undefined` off a 192-byte APP1 payload), and
/// [`set_exif_orientation`] threw the whole block away and substituted a
/// 26-byte stub because it saw no `II`/`MM` at offset 0.
///
/// What `metadata()` hands *back* is a separate question, answered by
/// [`RasterSidecars::exif_as_stored`]: sharp returns the block exactly as
/// its container stores it, so `exif_intro` remembers which form that was.
// No `Eq`: `density` is an `Option<f64>`, and `f64` has no total order (NaN),
// so it cannot implement `Eq` — `PartialEq` is what `assert_eq!` needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RasterSidecars {
    /// The EXIF block starting at its TIFF header, never introduced.
    pub exif: Option<Vec<u8>>,
    /// Whether the container stored `exif` behind the `Exif\0\0`
    /// introducer. Read-side bookkeeping only — nothing embeds from it;
    /// `metadata()` uses it to hand the block back in the form sharp does.
    pub exif_intro: bool,
    pub icc: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
    /// Pixels per inch, when the container states one.
    pub density: Option<f64>,
}

impl RasterSidecars {
    /// The EXIF block in the form its container stored it — with the
    /// `Exif\0\0` introducer when that is what was there.
    ///
    /// This is what `metadata().exif` must return, because it is what sharp
    /// returns: measured on sharp 0.34.5, one 24×16 source written to every
    /// container with `withMetadata({orientation:6})`, `metadata().exif` is
    /// 186 bytes starting `Exif\0\0II*` for JPEG, WebP and AVIF, 180 bytes
    /// starting `II*` for PNG, and absent for TIFF.
    pub fn exif_as_stored(&self) -> Option<Vec<u8>> {
        let block = self.exif.as_deref()?;
        Some(if self.exif_intro {
            [EXIF_INTRO, block].concat()
        } else {
            block.to_vec()
        })
    }
}

/// `(block without a leading `Exif\0\0`, whether one was there)` — the
/// canonical internal EXIF form every container's reader funnels through,
/// and the tolerance [`set_exif_orientation`] and the recipe's own
/// caller-supplied `metadata.exif` need (a caller handing Maple the buffer
/// sharp's `metadata().exif` gave them is handing over an introduced one).
pub fn canonical_exif(block: &[u8]) -> (&[u8], bool) {
    match block.strip_prefix(EXIF_INTRO) {
        Some(tiff) => (tiff, true),
        None => (block, false),
    }
}

/// The density to report for a container that states `dpi`, or `None` when
/// sharp would report none.
///
/// Two behaviours of libvips', both measured against sharp 0.34.5 with
/// `withMetadata({density})` round-trips (#3507 final fix wave, item 7).
/// It carries resolution as pixels per millimetre and reports it only when
/// that exceeds 1.0 — exactly 25.4 dpi — so 26 reads back and 25.4 and 25
/// read back as absent, on JPEG, PNG and TIFF alike. And what it reports is
/// the rounded whole number: a block storing `25999/1000` reads back as 26,
/// 150.7 as 151, 150.4 as 150, 72.5 as 73.
fn reportable_density(dpi: f64) -> Option<f64> {
    (dpi > MIN_REPORTED_DPI).then(|| dpi.round())
}

/// Densities at or below 25.4 dpi are not reported at all.
///
/// libvips carries resolution as pixels per millimetre and defaults it to
/// 1.0, which sharp suppresses (`density` is absent unless `xres > 1.0`) —
/// 1 px/mm is exactly 25.4 dpi. Measured on sharp 0.34.5 with
/// `withMetadata({density})`: 26 reads back as 26, 25.4 and 25 as
/// `undefined`, on both JPEG and PNG. That is also why every sharp-written
/// PNG's `pHYs` of 1000 px/m reads back as no density at all, where Maple
/// reported 25.4 on 8 of 8 PNG fixtures (#3507 final fix wave, item 7).
const MIN_REPORTED_DPI: f64 = 25.4;

/// What libvips' JPEG and PNG loaders assume for a file that states no
/// resolution at all — measured: sharp reports 72 both for a
/// mozjpeg-written JPEG (mozjpeg writes no JFIF density segment) and for a
/// PNG carrying no `pHYs` chunk. The TIFF, WebP and AVIF loaders have no
/// such default: they report nothing.
const DEFAULT_DPI: f64 = 72.0;

/// Ceiling on a single metadata block, in bytes (16 MiB).
///
/// Two jobs, one number (#3507 final fix wave, items 5 and 9). It bounds
/// the zlib inflate of a PNG `iCCP`/`iTXt`/`zTXt` chunk, where a 66 KB file
/// could otherwise expand to 64 MB (measured: 67,108,864 bytes of `icc` in
/// 1,826 ms from a crafted 66,516-byte PNG); and it bounds what
/// `metadata()` hands back across the FFI, where every block is base64'd
/// into one JSON reply at ~133% of its size. A block over the ceiling is
/// reported as absent rather than as an error: a hostile or simply unusual
/// file should not make `metadata()` fail, which is the same call
/// `read_sidecars` already makes for a corrupt `iCCP` zlib stream.
///
/// 16 MiB is far above anything real — the largest ICC profiles in
/// circulation are a few MB, a JPEG APP1 EXIF block cannot exceed 64 KB by
/// construction, and an XMP packet is kilobytes.
pub const MAX_SIDECAR_BYTES: usize = 16 << 20;

const EXIF_INTRO: &[u8] = b"Exif\0\0";
const ICC_INTRO: &[u8] = b"ICC_PROFILE\0";
const XMP_INTRO: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const PNG_XMP_KEYWORD: &[u8] = b"XML:com.adobe.xmp\0";

/// Dispatch on the container's magic bytes and walk its chunk/segment
/// stream for EXIF, ICC, XMP and pixel density. Anything unrecognised, or
/// too short to carry a valid header, reports every field `None`.
pub fn read_sidecars(bytes: &[u8]) -> RasterSidecars {
    read_sidecars_source(bytes)
}

/// Read metadata at its actual file offsets without loading image payloads.
pub fn read_sidecars_reader<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
) -> std::io::Result<RasterSidecars> {
    let source = crate::metadata_source::SeekableSource::new(reader)?;
    let sidecars = read_sidecars_source(&source);
    source.finish(sidecars)
}

use crate::metadata_source::MetadataSource;

pub(crate) fn read_sidecars_source<S: MetadataSource + ?Sized>(bytes: &S) -> RasterSidecars {
    let header = bytes.get(0..bytes.len().min(32)).unwrap_or_default();
    if crate::raster::is_avif(&header) {
        let boxes = crate::avif_boxes::read_avif_boxes_source(bytes);
        // libheif/libvips write the introducer after an `Exif` item's
        // 4-byte TIFF-header offset (measured: `\0\0\0\x06Exif\0\0II*`),
        // which is exactly what that offset of 6 points past.
        let (exif, exif_intro) = match boxes.exif.as_deref().map(canonical_exif) {
            Some((tiff, introduced)) => (Some(tiff.to_vec()), introduced),
            None => (None, false),
        };
        return RasterSidecars {
            exif,
            exif_intro,
            xmp: boxes.xmp,
            // See the module doc: `colr`/`prof` ICC is a real AVIF
            // possibility this crate's own encoder never writes, so there is
            // nothing to read back yet.
            icc: None,
            density: None,
        };
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return read_jpeg(bytes);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return read_png(bytes);
    }
    if bytes.starts_with(b"II\x2a\x00") || bytes.starts_with(b"MM\x00\x2a") {
        return read_tiff(bytes);
    }
    if bytes.len() > 12 && header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
        return read_webp(bytes);
    }
    RasterSidecars::default()
}

/// IFD0 tags 34675 (`InterColorProfile`) and 700 (`XMLPacket`), and no EXIF
/// block at all.
///
/// A TIFF's IFD0 is its EXIF, so there is no separate block to hand back,
/// and sharp reports none: measured on sharp 0.34.5, `metadata().exif` is
/// absent for every TIFF (both a plain one and one written with
/// `withMetadata({orientation:6})`, whose orientation sharp reads out of
/// the IFD0 itself). This used to return the whole file instead, which the
/// claim "that is how libvips reports it too" does not support — measured
/// on a 48,000,350-byte uncompressed TIFF, `metadata()` took 431 ms and
/// handed back a 48 MB `exif` buffer to be base64'd across the FFI, against
/// sharp's 1 ms and no `exif` at all (#3507 final fix wave, item 5). The
/// orientation a TIFF declares is unaffected: `container_orientation` reads
/// it straight out of the file's own TIFF header.
fn read_tiff<S: MetadataSource + ?Sized>(bytes: &S) -> RasterSidecars {
    let little = bytes.starts_with(b"II");
    let u16_at = |i: usize| -> Option<u16> {
        let end = i.checked_add(2)?;
        let b = bytes.get(i..end)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |i: usize| -> Option<u32> {
        let end = i.checked_add(4)?;
        let b = bytes.get(i..end)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let mut found = RasterSidecars {
        // A TIFF's IFD0 *is* its EXIF, so its own XResolution/ResolutionUnit
        // are what sharp reports (measured: 300 for a TIFF written with
        // `withMetadata({density:300})`, absent for a plain one whose
        // resolution is libvips' 1 px/mm default).
        density: tags::exif_resolution_dpi_source(bytes).and_then(reportable_density),
        ..Default::default()
    };
    let Some(ifd) = u32_at(4).map(|v| v as usize) else {
        return found;
    };
    let Some(count) = u16_at(ifd) else {
        return found;
    };
    let Some(entries_start) = ifd.checked_add(2) else {
        return found;
    };
    for entry in 0..count as usize {
        let Some(entry_offset) = entry.checked_mul(12) else {
            break;
        };
        let Some(at) = entries_start.checked_add(entry_offset) else {
            break;
        };
        let (Some(type_at), Some(length_at), Some(offset_at)) =
            (at.checked_add(2), at.checked_add(4), at.checked_add(8))
        else {
            break;
        };
        let (Some(tag), Some(type_field), Some(length), Some(offset)) = (
            u16_at(at),
            u16_at(type_at),
            u32_at(length_at),
            u32_at(offset_at),
        ) else {
            break;
        };
        // Only a byte-sized type (BYTE 1, ASCII 2, UNDEFINED 7) makes the
        // declared count a direct byte length; anything else (SHORT, LONG,
        // …) would need `count * type_size`, which neither tag this reads
        // uses in practice, so it's treated as "not present" rather than a
        // guess at the real length.
        if !matches!(type_field, 1 | 2 | 7) {
            continue;
        }
        let Some(value_end) = (offset as usize).checked_add(length as usize) else {
            continue;
        };
        if !matches!(tag, 34675 | 700) {
            continue;
        }
        let payload = bytes
            .get(offset as usize..value_end)
            .map(|s| s.into_owned());
        match tag {
            34675 => found.icc = payload,
            700 => found.xmp = payload,
            _ => {}
        }
    }
    found
}

/// RIFF chunk walk for `EXIF`, `ICCP` and `XMP `.
fn read_webp<S: MetadataSource + ?Sized>(bytes: &S) -> RasterSidecars {
    let mut found = RasterSidecars::default();
    let mut idx = 12usize;
    loop {
        let Some(kind_end) = idx.checked_add(4) else {
            break;
        };
        let Some(kind) = bytes.get(idx..kind_end) else {
            break;
        };
        let Some(len_end) = kind_end.checked_add(4) else {
            break;
        };
        let Some(length_bytes) = bytes.get(kind_end..len_end) else {
            break;
        };
        let length = u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ]) as usize;
        let Some(payload_end) = len_end.checked_add(length) else {
            break;
        };
        if !bytes.contains(len_end..payload_end) {
            break;
        }
        if !matches!(kind.as_ref(), b"EXIF" | b"ICCP" | b"XMP ") {
            let Some(next) = payload_end.checked_add(length & 1) else {
                break;
            };
            idx = next;
            continue;
        }
        let Some(payload) = bytes.get(len_end..payload_end) else {
            break;
        };
        match kind.as_ref() {
            b"EXIF" => {
                // libvips writes the introducer into this chunk (measured:
                // a sharp-written WebP's `EXIF` chunk is 186 bytes starting
                // `Exif\0\0`), while the WebP container spec asks for the
                // bare TIFF header this crate's own encoder writes — both
                // reach the canonical form here.
                let (tiff, introduced) = canonical_exif(&payload);
                found.exif = Some(tiff.to_vec());
                found.exif_intro = introduced;
            }
            b"ICCP" => found.icc = Some(payload.to_vec()),
            b"XMP " => found.xmp = Some(payload.to_vec()),
            _ => {}
        }
        // RIFF chunks are padded to an even length.
        let Some(next) = payload_end.checked_add(length & 1) else {
            break;
        };
        idx = next;
    }
    found
}

#[path = "raster_meta_png.rs"]
mod png_meta;
use png_meta::read_png;

/// The JPEG marker-segment walk — see its own module doc.
#[path = "raster_meta_jpeg.rs"]
mod jpeg;
use jpeg::read_jpeg;

/// Read and rewrite individual tags inside an EXIF block — see its own
/// module doc for why that is a separate file from walking a container.
#[path = "raster_meta_tags.rs"]
mod tags;
pub use tags::{exif_resolution_dpi, set_exif_orientation, set_exif_resolution};

#[cfg(test)]
#[path = "raster_meta_jpeg_tests.rs"]
mod jpeg_tests;
#[cfg(test)]
#[path = "raster_meta_png_tests.rs"]
mod png_tests;
#[cfg(test)]
#[path = "raster_meta_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "raster_meta_tiff_webp_tests.rs"]
mod tiff_webp_tests;
