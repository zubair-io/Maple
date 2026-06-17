//! Minimal TIFF-format EXIF blob builder for PNG `eXIf` chunk embedding.
//!
//! Builds a valid TIFF byte stream carrying the subset of EXIF tags that
//! Apple ImageIO / CGImageSource reads and surfaces in the "Camera & Location"
//! panel:
//!
//! - IFD0 (TIFF root): Make, Model, Software, ExifIFD pointer, GPSInfo pointer
//! - EXIF IFD: FNumber, ExposureTime, ISOSpeedRatings, LensModel, FocalLength
//! - GPS IFD: GPSLatitudeRef, GPSLatitude, GPSLongitudeRef, GPSLongitude
//!   (populated only when the source frame carries GPS data)
//!
//! # Format
//!
//! TIFF is little-endian (II header). Each IFD entry is the classic 12-byte
//! layout:
//!
//! ```text
//!   [tag:u16][type:u16][count:u32][value_or_offset:u32]
//! ```
//!
//! Values that fit in 4 bytes are stored inline (left-aligned); larger values
//! (strings, Rational pairs) go in the "value area" appended after all IFDs.
//!
//! References: TIFF 6.0 §2 / EXIF 2.32 spec Annex A.
//!
//! # No external dependencies
//!
//! This module hand-rolls the TIFF/EXIF bytes rather than pulling in a new
//! crate. The blob is small (< 512 bytes) and the layout is stable.

use raw_core::Exif;

// ─── TIFF/EXIF tag constants ──────────────────────────────────────────────

// IFD0 (TIFF root) tags
const TAG_MAKE: u16 = 0x010F;
const TAG_MODEL: u16 = 0x0110;
const TAG_SOFTWARE: u16 = 0x0131;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;

// EXIF IFD tags
const TAG_EXPOSURE_TIME: u16 = 0x829A;
const TAG_FNUMBER: u16 = 0x829D;
const TAG_ISO: u16 = 0x8827;
const TAG_FOCAL_LENGTH: u16 = 0x920A;
const TAG_LENS_MODEL: u16 = 0xA434;

// GPS IFD tags
const TAG_GPS_LAT_REF: u16 = 0x0001;
const TAG_GPS_LAT: u16 = 0x0002;
const TAG_GPS_LON_REF: u16 = 0x0003;
const TAG_GPS_LON: u16 = 0x0004;

// TIFF data types
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5; // unsigned rational: (numerator:u32, denominator:u32)

// ─── TIFF blob builder ───────────────────────────────────────────────────

/// Append-only little-endian byte builder.
struct Le(Vec<u8>);

impl Le {
    fn new() -> Self {
        Self(Vec::with_capacity(512))
    }

    fn push_u8(&mut self, v: u8) {
        self.0.push(v);
    }

    fn push_u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    fn push_u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    /// Pad to an even offset (TIFF word alignment).
    fn align2(&mut self) {
        if self.0.len() % 2 != 0 {
            self.0.push(0);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.0
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Convert a floating-point value to Rational (n, d) with `d = 100`.
fn to_rational_100(v: f32) -> (u32, u32) {
    let n = (v * 100.0).round() as u32;
    (n, 100)
}

/// Convert an exposure time in seconds to a Rational.
///
/// Sub-second values: prefer `1/N` when `|v - 1/N| / v < 0.5%`
/// (i.e. the value is a close match to a standard shutter speed).
/// Otherwise fall back to `(round(v * 1000), 1000)` reduced by GCD,
/// so that e.g. 0.6 s → 3/5 rather than the distorting 1/2.
/// Long exposures (≥ 1 s): `(round(v*10), 10)`.
fn to_exposure_rational(v: f32) -> (u32, u32) {
    if v <= 0.0 {
        return (0, 1);
    }
    if v < 1.0 {
        let denom = (1.0 / v).round() as u32;
        let denom = denom.max(1);
        // Accept 1/N when it reconstructs within 0.5 % of the true value.
        let reconstructed = 1.0 / denom as f32;
        if (reconstructed - v).abs() / v < 0.005 {
            (1, denom)
        } else {
            // Higher-precision fraction: numerator/1000, then reduce by GCD.
            let n = (v * 1000.0).round() as u32;
            let g = gcd(n, 1000);
            (n / g, 1000 / g)
        }
    } else {
        let n = (v * 10.0).round() as u32;
        (n, 10)
    }
}

/// Greatest common divisor (Euclidean).
fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Convert a decimal GPS coordinate to DMS rationals (d/1, m/1, s_num/1000).
fn decimal_to_dms(decimal: f64) -> (u32, u32, u32) {
    let abs = decimal.abs();
    let d = abs.floor() as u32;
    let m_frac = (abs - d as f64) * 60.0;
    let m = m_frac.floor() as u32;
    let s_ms = ((m_frac - m as f64) * 60.0 * 1000.0).round() as u32;
    (d, m, s_ms)
}

/// Prepare a null-terminated, even-padded ASCII value.
/// Count = string_len + 1 (including the null terminator).
fn ascii_bytes(s: &str) -> (Vec<u8>, u32) {
    let mut b: Vec<u8> = s.as_bytes().to_vec();
    b.push(0); // null terminator
    let count = b.len() as u32;
    if b.len() % 2 != 0 {
        b.push(0); // alignment pad (not counted)
    }
    (b, count)
}

// ─── IFD writer ───────────────────────────────────────────────────────────

/// A single tag + value scheduled for writing.  The value may fit inline
/// in the 4-byte `value_or_offset` field (SHORT/LONG/small ASCII), or it
/// must go in the value-area heap after all IFD entries.
enum EntryValue {
    /// Inline 2-byte SHORT (left-padded to 4 bytes LE).
    Short(u16),
    /// Inline 4-byte LONG (pointer or opaque u32).
    Long(u32),
    /// Null-terminated ASCII: (bytes-including-null-and-pad, count-without-pad).
    /// If count ≤ 4 the bytes go inline, else they go in the value area.
    Ascii(Vec<u8>, u32),
    /// One unsigned Rational (8 bytes) — always in the value area.
    Rational(u32, u32),
    /// Three unsigned Rationals (24 bytes) — always in the value area.
    Rational3([(u32, u32); 3]),
}

struct Entry {
    tag: u16,
    value: EntryValue,
}

impl Entry {
    fn type_count(&self) -> (u16, u32) {
        match &self.value {
            EntryValue::Short(_) => (TYPE_SHORT, 1),
            EntryValue::Long(_) => (TYPE_LONG, 1),
            EntryValue::Ascii(_, count) => (TYPE_ASCII, *count),
            EntryValue::Rational(_, _) => (TYPE_RATIONAL, 1),
            EntryValue::Rational3(_) => (TYPE_RATIONAL, 3),
        }
    }

    fn is_inline(&self) -> bool {
        match &self.value {
            EntryValue::Short(_) | EntryValue::Long(_) => true,
            EntryValue::Ascii(_, count) => *count <= 4,
            _ => false,
        }
    }

    /// Inline bytes (4 bytes, LE, zero-padded on the right).
    fn inline_bytes(&self) -> [u8; 4] {
        match &self.value {
            EntryValue::Short(v) => {
                let mut b = [0u8; 4];
                b[..2].copy_from_slice(&v.to_le_bytes());
                b
            }
            EntryValue::Long(v) => v.to_le_bytes(),
            EntryValue::Ascii(bytes, _) => {
                let mut b = [0u8; 4];
                let n = bytes.len().min(4);
                b[..n].copy_from_slice(&bytes[..n]);
                b
            }
            _ => [0u8; 4], // shouldn't be called for deferred
        }
    }

    /// Heap bytes for deferred values.
    fn heap_bytes(&self) -> Option<Vec<u8>> {
        match &self.value {
            EntryValue::Ascii(bytes, count) if *count > 4 => Some(bytes.clone()),
            EntryValue::Rational(n, d) => {
                let mut b = Vec::with_capacity(8);
                b.extend_from_slice(&n.to_le_bytes());
                b.extend_from_slice(&d.to_le_bytes());
                Some(b)
            }
            EntryValue::Rational3(pairs) => {
                let mut b = Vec::with_capacity(24);
                for (n, d) in pairs {
                    b.extend_from_slice(&n.to_le_bytes());
                    b.extend_from_slice(&d.to_le_bytes());
                }
                Some(b)
            }
            _ => None,
        }
    }
}

/// Serialize one IFD.  All value data is placed in a shared heap (starting
/// at `heap_start` in the global TIFF blob).  After writing the IFD entries,
/// the heap data is appended inline.  Returns the byte count written.
///
/// `buf` is the global TIFF blob.
/// `entries` must be sorted by tag before calling.
/// `heap_start` is where the heap for this IFD begins in the global blob.
fn write_ifd(buf: &mut Le, entries: &[Entry], heap_start: u32, next_ifd_offset: u32) {
    buf.push_u16(entries.len() as u16);

    // Phase 1: measure heap layout.
    let mut heap_offsets: Vec<Option<u32>> = Vec::with_capacity(entries.len());
    let mut cursor = heap_start;
    for e in entries {
        if e.is_inline() {
            heap_offsets.push(None);
        } else {
            heap_offsets.push(Some(cursor));
            let bytes = e.heap_bytes().unwrap();
            // Advance cursor by padded size.
            cursor += bytes.len() as u32;
            if cursor % 2 != 0 {
                cursor += 1;
            }
        }
    }

    // Phase 2: write all 12-byte entry slots.
    for (i, e) in entries.iter().enumerate() {
        let (typ, count) = e.type_count();
        buf.push_u16(e.tag);
        buf.push_u16(typ);
        buf.push_u32(count);
        if e.is_inline() {
            buf.0.extend_from_slice(&e.inline_bytes());
        } else {
            buf.push_u32(heap_offsets[i].unwrap());
        }
    }

    // Next IFD pointer (0 = none / end of chain).
    buf.push_u32(next_ifd_offset);

    // Phase 3: write the heap.
    for e in entries {
        if let Some(bytes) = e.heap_bytes() {
            buf.0.extend_from_slice(&bytes);
            buf.align2();
        }
    }
}

/// Compute the total byte size an IFD will occupy in the global blob,
/// **including** the 2-byte entry-count prefix and the 4-byte next-IFD
/// pointer suffix that `write_ifd` writes around the entry slots.
fn ifd_total_size(entries: &[Entry]) -> u32 {
    // entry count (2) + entries (n×12) + next-ifd (4) + heap
    let mut size: u32 = 2 + entries.len() as u32 * 12 + 4;
    for e in entries {
        if let Some(bytes) = e.heap_bytes() {
            size += bytes.len() as u32;
            if size % 2 != 0 {
                size += 1;
            }
        }
    }
    size
}

// ─── Tag constructors ─────────────────────────────────────────────────────

fn ascii_entry(tag: u16, s: &str) -> Entry {
    let (bytes, count) = ascii_bytes(s);
    Entry {
        tag,
        value: EntryValue::Ascii(bytes, count),
    }
}

fn short_entry(tag: u16, v: u16) -> Entry {
    Entry {
        tag,
        value: EntryValue::Short(v),
    }
}

fn rational_entry(tag: u16, n: u32, d: u32) -> Entry {
    Entry {
        tag,
        value: EntryValue::Rational(n, d),
    }
}

fn rational3_entry(tag: u16, pairs: [(u32, u32); 3]) -> Entry {
    Entry {
        tag,
        value: EntryValue::Rational3(pairs),
    }
}

fn long_ptr_entry(tag: u16, offset: u32) -> Entry {
    Entry {
        tag,
        value: EntryValue::Long(offset),
    }
}

// ─── Public API ───────────────────────────────────────────────────────────

/// Build a minimal TIFF/EXIF blob suitable for embedding in a PNG `eXIf`
/// chunk, from a [`raw_core::Exif`] parsed from the first source frame.
///
/// The result is a valid TIFF byte stream (little-endian, II header) that
/// Apple ImageIO / CGImageSource parses correctly. Returns `None` only when
/// `exif` carries nothing useful (all-None fields) — in practice the blob
/// always contains at least the `Software` tag.
pub fn build_exif_blob(exif: &Exif) -> Option<Vec<u8>> {
    // ── EXIF sub-IFD entries ─────────────────────────────────────────────
    let mut exif_entries: Vec<Entry> = Vec::new();

    if let Some(s) = exif.shutter_s {
        let (n, d) = to_exposure_rational(s);
        exif_entries.push(rational_entry(TAG_EXPOSURE_TIME, n, d));
    }
    if let Some(a) = exif.aperture {
        let (n, d) = to_rational_100(a);
        exif_entries.push(rational_entry(TAG_FNUMBER, n, d));
    }
    if let Some(iso) = exif.iso {
        exif_entries.push(short_entry(TAG_ISO, iso.min(u16::MAX as u32) as u16));
    }
    if let Some(fl) = exif.focal_mm {
        let (n, d) = to_rational_100(fl);
        exif_entries.push(rational_entry(TAG_FOCAL_LENGTH, n, d));
    }
    if let Some(lm) = &exif.lens_model {
        exif_entries.push(ascii_entry(TAG_LENS_MODEL, lm));
    }
    exif_entries.sort_by_key(|e| e.tag);

    // ── GPS sub-IFD entries ───────────────────────────────────────────────
    let mut gps_entries: Vec<Entry> = Vec::new();

    if let Some(g) = &exif.gps {
        let lat_ref = if g.lat_deg >= 0.0 { "N" } else { "S" };
        let (ld, lm, ls) = decimal_to_dms(g.lat_deg);
        gps_entries.push(ascii_entry(TAG_GPS_LAT_REF, lat_ref));
        gps_entries.push(rational3_entry(TAG_GPS_LAT, [(ld, 1), (lm, 1), (ls, 1000)]));

        let lon_ref = if g.lon_deg >= 0.0 { "E" } else { "W" };
        let (lod, lom, los) = decimal_to_dms(g.lon_deg);
        gps_entries.push(ascii_entry(TAG_GPS_LON_REF, lon_ref));
        gps_entries.push(rational3_entry(
            TAG_GPS_LON,
            [(lod, 1), (lom, 1), (los, 1000)],
        ));
        gps_entries.sort_by_key(|e| e.tag);
    }

    // ── IFD0 entries (without sub-IFD pointers yet) ───────────────────────
    let mut ifd0_base: Vec<Entry> = Vec::new();

    if let Some(make) = &exif.camera_make {
        ifd0_base.push(ascii_entry(TAG_MAKE, make));
    }
    if let Some(model) = &exif.camera_model {
        ifd0_base.push(ascii_entry(TAG_MODEL, model));
    }
    ifd0_base.push(ascii_entry(TAG_SOFTWARE, "Maple Panorama"));
    // (sub-IFD pointers will be added below once we know their offsets)

    // ── Layout calculation ────────────────────────────────────────────────
    //
    //  Byte 0..8  : TIFF header (II + 42 + IFD0-offset=8)
    //  Byte 8..?  : IFD0  (n entries + heap)
    //  Byte ?..?  : EXIF IFD (if non-empty)
    //  Byte ?..?  : GPS IFD  (if non-empty)
    //
    // We need to know IFD0's total size to compute where EXIF/GPS IFDs land.
    // IFD0 has `ifd0_base.len()` entries + up to 2 pointer entries.

    // Temporarily build ifd0_entries WITH pointer stubs (value=0) to measure
    // its size.  We'll re-build with real values later.
    let mut ifd0_entries: Vec<Entry> = Vec::new();
    for e in &ifd0_base {
        // Clone by rebuilding — Entry doesn't implement Clone, but values are small.
        ifd0_entries.push(ascii_entry(e.tag, "")); // placeholder to measure
    }
    if !exif_entries.is_empty() {
        ifd0_entries.push(long_ptr_entry(TAG_EXIF_IFD, 0));
    }
    if !gps_entries.is_empty() {
        ifd0_entries.push(long_ptr_entry(TAG_GPS_IFD, 0));
    }

    // Measure actual IFD0 size using the REAL base entries (not the empty placeholders).
    let mut ifd0_real: Vec<Entry> = ifd0_base
        .iter()
        .map(|e| {
            if let EntryValue::Ascii(_, _) = &e.value {
                let s = match e.tag {
                    TAG_MAKE => exif.camera_make.as_deref().unwrap_or(""),
                    TAG_MODEL => exif.camera_model.as_deref().unwrap_or(""),
                    _ => "Maple Panorama",
                };
                ascii_entry(e.tag, s)
            } else {
                // Not hit for the current base entry set (all ASCII).
                long_ptr_entry(e.tag, 0)
            }
        })
        .collect();
    if !exif_entries.is_empty() {
        ifd0_real.push(long_ptr_entry(TAG_EXIF_IFD, 0));
    }
    if !gps_entries.is_empty() {
        ifd0_real.push(long_ptr_entry(TAG_GPS_IFD, 0));
    }
    ifd0_real.sort_by_key(|e| e.tag);

    // IFD0 starts at offset 8 in the global blob.
    let ifd0_start: u32 = 8;
    let ifd0_size = ifd_total_size(&ifd0_real);
    let exif_ifd_start = ifd0_start + ifd0_size;
    let exif_ifd_size = if !exif_entries.is_empty() {
        ifd_total_size(&exif_entries)
    } else {
        0
    };
    let gps_ifd_start = exif_ifd_start + exif_ifd_size;

    // ── Final IFD0 with real pointer values ───────────────────────────────
    let mut ifd0_final: Vec<Entry> = ifd0_base
        .iter()
        .map(|e| {
            let s = match e.tag {
                TAG_MAKE => exif.camera_make.as_deref().unwrap_or(""),
                TAG_MODEL => exif.camera_model.as_deref().unwrap_or(""),
                _ => "Maple Panorama",
            };
            ascii_entry(e.tag, s)
        })
        .collect();
    if !exif_entries.is_empty() {
        ifd0_final.push(long_ptr_entry(TAG_EXIF_IFD, exif_ifd_start));
    }
    if !gps_entries.is_empty() {
        ifd0_final.push(long_ptr_entry(TAG_GPS_IFD, gps_ifd_start));
    }
    ifd0_final.sort_by_key(|e| e.tag);

    // ── Write the blob ───────────────────────────────────────────────────
    let mut buf = Le::new();

    // TIFF header: "II" (LE), magic 42, offset to IFD0 = 8.
    buf.push_u8(b'I');
    buf.push_u8(b'I');
    buf.push_u16(42);
    buf.push_u32(ifd0_start);

    // IFD0: heap starts after the entry count (2) + entries (n×12) + next-ifd (4).
    let ifd0_heap_start = ifd0_start + 2 + ifd0_final.len() as u32 * 12 + 4;
    write_ifd(&mut buf, &ifd0_final, ifd0_heap_start, 0);

    // EXIF sub-IFD.
    if !exif_entries.is_empty() {
        let exif_heap_start = exif_ifd_start + 2 + exif_entries.len() as u32 * 12 + 4;
        write_ifd(&mut buf, &exif_entries, exif_heap_start, 0);
    }

    // GPS sub-IFD.
    if !gps_entries.is_empty() {
        let gps_heap_start = gps_ifd_start + 2 + gps_entries.len() as u32 * 12 + 4;
        write_ifd(&mut buf, &gps_entries, gps_heap_start, 0);
    }

    Some(buf.finish())
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "exif_embed_tests.rs"]
mod tests;
