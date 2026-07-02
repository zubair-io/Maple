//! Stable image identity per spec `docs/spec/12-maple-apps-spec.md` §04.
//!
//! Every image has a 16-byte `MapleId`, hex-encoded for display (32 chars).
//! Two derivation forms exist:
//!
//! * **Primary** (modern RAWs): `BLAKE3( sha1Head(first 64 KB) ||
//!   CaptureDateTimeOriginal || camera_serial || shutter_count )[..16]`.
//! * **Fallback** (phone snapshots, older cameras lacking EXIF capture time):
//!   `BLAKE3( sha1_full(all bytes) || filesize_le_u64 )[..16]`.
//!
//! To guarantee the two forms cannot alias — a primary id and a fallback id
//! computed from the same file must not collide — the first byte of the 16-byte
//! id is a tag: `0x01` for [`IdKind::Primary`], `0x02` for [`IdKind::Fallback`].
//! The remaining 15 bytes come from the BLAKE3 truncation. This burns one byte
//! of collision resistance (2^120 remaining for each kind) — still comfortably
//! beyond any foreseeable Maple library size.
//!
//! Determinism: BLAKE3 and SHA-1 are pure functions of their input bytes. The
//! derivation reads neither the wall clock nor any RNG. Calling [`maple_id`]
//! twice on identical inputs returns identical output, on any platform.

use crate::api::Exif;
use crate::error::{Error, Result};

use blake3::Hasher as Blake3Hasher;
use sha1::{Digest, Sha1};

/// First byte of a primary-form id.
pub const TAG_PRIMARY: u8 = 0x01;
/// First byte of a fallback-form id.
pub const TAG_FALLBACK: u8 = 0x02;

/// Number of leading bytes of a file that feed `sha1Head`.
pub const SHA1_HEAD_BYTES: usize = 64 * 1024;

/// Which derivation produced a [`MapleId`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum IdKind {
    /// Primary form: EXIF-anchored. See module docs.
    Primary,
    /// Fallback form: full-file hash + filesize.
    Fallback,
}

/// Stable 16-byte image id. First byte is the kind tag; remaining 15 bytes
/// are a BLAKE3 truncation.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct MapleId(pub [u8; 16]);

impl MapleId {
    /// Compute the primary-form id for a file whose bytes are available
    /// as a slice. Only the first [`SHA1_HEAD_BYTES`] of `bytes` are hashed
    /// into `sha1Head` — callers with very large files may (and should) pass
    /// a slice covering at least the first 64 KB; extra bytes are ignored for
    /// the primary form.
    ///
    /// `capture_datetime_original` is serialised as its UTF-8 bytes verbatim;
    /// EXIF tag format is "YYYY:MM:DD HH:MM:SS" and is stable under rename, so
    /// no timezone normalisation is performed here (that would require a
    /// parser + a TZ assumption — see spec §04 which says the formula feeds
    /// this value directly into the hash).
    ///
    /// `camera_serial` is optional; `None` is serialised as empty bytes so
    /// that two cameras of the same model at the same second — one with
    /// serial, one without — land in different ids.
    ///
    /// `shutter_count` is optional; `None` is serialised as `0u64` little-
    /// endian bytes. A frame with an explicit `shutter_count = 0` is
    /// indistinguishable from a missing one for id purposes; that is the
    /// documented spec behaviour.
    pub fn primary(
        bytes: &[u8],
        capture_datetime_original: &str,
        camera_serial: Option<&str>,
        shutter_count: Option<u64>,
    ) -> Self {
        // sha1Head = SHA-1( first 64 KB )
        let head_len = bytes.len().min(SHA1_HEAD_BYTES);
        let mut sha1 = Sha1::new();
        sha1.update(&bytes[..head_len]);
        let sha1_head = sha1.finalize();

        let mut h = Blake3Hasher::new();
        h.update(&sha1_head);
        h.update(capture_datetime_original.as_bytes());
        if let Some(serial) = camera_serial {
            h.update(serial.as_bytes());
        }
        h.update(&shutter_count.unwrap_or(0).to_le_bytes());

        let digest = h.finalize();
        let mut id = [0u8; 16];
        id[0] = TAG_PRIMARY;
        id[1..].copy_from_slice(&digest.as_bytes()[..15]);
        MapleId(id)
    }

    /// Compute the fallback-form id. Streams `bytes` through SHA-1 in full.
    /// `filesize` is serialised as little-endian `u64` bytes. Typically
    /// `filesize == bytes.len()` but callers can pass a different value for
    /// streaming contexts; the spec formula is `sha1_full || filesize`.
    pub fn fallback(bytes: &[u8], filesize: u64) -> Self {
        let mut sha1 = Sha1::new();
        sha1.update(bytes);
        let sha1_full = sha1.finalize();

        let mut h = Blake3Hasher::new();
        h.update(&sha1_full);
        h.update(&filesize.to_le_bytes());

        let digest = h.finalize();
        let mut id = [0u8; 16];
        id[0] = TAG_FALLBACK;
        id[1..].copy_from_slice(&digest.as_bytes()[..15]);
        MapleId(id)
    }

    /// The derivation that produced this id (inferred from the tag byte).
    /// Unknown tag bytes map to [`IdKind::Fallback`] — we never parse a
    /// third category, so treat anything non-primary as fallback-ish rather
    /// than panicking.
    pub fn kind(&self) -> IdKind {
        match self.0[0] {
            TAG_PRIMARY => IdKind::Primary,
            _ => IdKind::Fallback,
        }
    }

    /// Lowercase hex, 32 characters. Stable across platforms.
    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(32);
        for byte in &self.0 {
            // Manual nibble write keeps us off `format!` in hot paths and
            // guarantees lowercase without locale surprises.
            const HEX: &[u8; 16] = b"0123456789abcdef";
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0F) as usize] as char);
        }
        out
    }

    /// Parse a 32-character hex string (case-insensitive) into a [`MapleId`].
    /// Returns [`Error::Xmp`] on bad length or invalid hex digit — the id
    /// parse path is driven by XMP reads, and [`Error::Xmp`] already names
    /// that class of failure.
    pub fn from_hex(s: &str) -> Result<Self> {
        if s.len() != 32 {
            return Err(Error::Xmp(format!(
                "maple:id: expected 32 hex chars, got {}",
                s.len()
            )));
        }
        let bytes = s.as_bytes();
        let mut out = [0u8; 16];
        for i in 0..16 {
            let hi = hex_nibble(bytes[i * 2])?;
            let lo = hex_nibble(bytes[i * 2 + 1])?;
            out[i] = (hi << 4) | lo;
        }
        Ok(MapleId(out))
    }
}

fn hex_nibble(c: u8) -> Result<u8> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(Error::Xmp(format!(
            "maple:id: invalid hex digit {:?}",
            c as char
        ))),
    }
}

/// Compute the BLAKE3-256 hash of arbitrary bytes and return it as a
/// 64-character lowercase hex string. Exposed for FFI callers (e.g.
/// `maple_blake3_hex` in raw-ffi) that need a standalone content hash without
/// going through the full `MapleId` derivation.
pub fn blake3_hex(bytes: &[u8]) -> [u8; 64] {
    let hash = blake3::hash(bytes);
    let hex_str = hash.to_hex();
    let hex_bytes = hex_str.as_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(hex_bytes);
    out
}

/// Derive a [`MapleId`] for a file's bytes given parsed [`Exif`].
///
/// Picks primary form when `exif.captured_at` is `Some`; falls back otherwise.
/// `camera_serial` and `shutter_count` are currently not surfaced on the
/// public [`Exif`] struct (rawler stores them on `RawExif` but the shell-
/// facing [`Exif`] keeps a minimal projection) — they are threaded through
/// as separate arguments to avoid growing [`Exif`] before the shell layer
/// needs those fields. Callers that have only an [`Exif`] can pass
/// `None` for both and still get a spec-conforming primary id whenever
/// `captured_at` is populated.
pub fn maple_id(
    bytes: &[u8],
    exif: &Exif,
    camera_serial: Option<&str>,
    shutter_count: Option<u64>,
) -> MapleId {
    match &exif.captured_at {
        Some(ts) => MapleId::primary(bytes, ts, camera_serial, shutter_count),
        None => MapleId::fallback(bytes, bytes.len() as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let id = MapleId([
            0x01, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22,
            0x33, 0x44,
        ]);
        let hex = id.to_hex();
        assert_eq!(hex, "01abcdef123456789abcdef011223344");
        let parsed = MapleId::from_hex(&hex).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn from_hex_rejects_wrong_length() {
        assert!(MapleId::from_hex("abcd").is_err());
    }

    #[test]
    fn from_hex_rejects_bad_digit() {
        assert!(MapleId::from_hex("zz000000000000000000000000000000").is_err());
    }

    #[test]
    fn from_hex_is_case_insensitive() {
        let lower = "01abcdef123456789abcdef011223344";
        let upper = "01ABCDEF123456789ABCDEF011223344";
        assert_eq!(
            MapleId::from_hex(lower).unwrap(),
            MapleId::from_hex(upper).unwrap()
        );
    }
}
