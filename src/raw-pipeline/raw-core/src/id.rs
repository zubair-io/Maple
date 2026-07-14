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
    /// `capture_datetime_original` is serialised as its UTF-8 bytes verbatim
    /// — this function performs no parsing, no timezone normalisation, and no
    /// reformatting of any kind; whatever string the caller passes is hashed
    /// as-is. That means the *caller* is responsible for passing a value that
    /// matches what every other id-deriving caller in the system passes for
    /// the same file, or ids silently stop matching across platforms/dedup.
    /// Concretely: the only real caller today, the TS server indexer
    /// (`src/api/src/indexer/id.ts`'s `deriveId`, fed by
    /// `src/api/src/indexer/exif.ts`'s `normalizeExif`), does NOT pass the
    /// raw EXIF `"YYYY:MM:DD HH:MM:SS"` tag string — it passes a `Date`
    /// object's ISO-8601 `.toISOString()` string (e.g.
    /// `"2024-06-01T12:34:56.789Z"`). New callers (Swift, WASM) matching the
    /// existing server dedup behaviour must reproduce that same ISO-8601
    /// string, not re-derive the raw EXIF format independently.
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

/// Streaming (chunked) fallback-form id hasher (#1995).
///
/// [`MapleId::fallback`] requires the caller to hold the entire file's bytes
/// as one contiguous slice, because the spec formula's `sha1_full` term is
/// `SHA1(all bytes)`. That's the wrong shape for a 100+ MB RAW read in
/// bounded chunks — an SMB byte-range read, or a browser's `File.slice()` —
/// where holding the whole file in memory at once is exactly what callers
/// need to avoid. `FallbackIdHasher` lets the same `sha1_full` term be built
/// incrementally: `new()`, then any number of [`update`](Self::update) calls
/// covering the file's bytes **in order**, then
/// [`finalize`](Self::finalize).
///
/// SHA-1 is already a block-based incremental hash (the underlying `sha1`
/// crate's `Sha1::update` can be called any number of times before
/// `finalize`), so this type does no reimplementation of hashing — it is a
/// thin, `raw-core`-public name for a capability the dependency already has.
/// Feeding chunk boundaries at any byte offset (including empty chunks and
/// single-byte chunks) produces a result byte-identical to a single
/// `MapleId::fallback(full_slice, filesize)` call over the same bytes; see
/// the `fallback_id_hasher_matches_one_shot_*` tests below for chunking
/// coverage.
///
/// The **primary** form (see [`MapleId::primary`]) has no streaming
/// counterpart and does not need one: it only ever reads a bounded 64 KB
/// head (`SHA1_HEAD_BYTES`), which trivially fits in memory as a single
/// buffer as-is.
pub struct FallbackIdHasher {
    sha1: Sha1,
    total_len: u64,
}

impl FallbackIdHasher {
    /// Start a new streaming fallback-id hash with no bytes fed yet.
    pub fn new() -> Self {
        FallbackIdHasher {
            sha1: Sha1::new(),
            total_len: 0,
        }
    }

    /// Feed the next chunk of file bytes. Chunks must be fed **in file
    /// order** (this is a running hash, not a set of independent pieces) but
    /// may be any length — including zero (a no-op) — and callers may vary
    /// chunk size call to call.
    pub fn update(&mut self, chunk: &[u8]) {
        self.sha1.update(chunk);
        self.total_len += chunk.len() as u64;
    }

    /// Number of bytes fed via [`update`](Self::update) so far. Exposed so a
    /// caller can assert it matches the `filesize` it's about to pass to
    /// [`finalize`](Self::finalize) — a cheap sanity check that every chunk
    /// of the file actually reached the hasher before the id is minted.
    pub fn bytes_fed(&self) -> u64 {
        self.total_len
    }

    /// Finish the hash and produce the tagged [`MapleId`], consuming `self`.
    ///
    /// `filesize` is passed explicitly rather than inferred from
    /// [`bytes_fed`](Self::bytes_fed) — this mirrors [`MapleId::fallback`]'s
    /// existing signature, where the spec formula's `filesize` term is
    /// allowed to differ from the hashed byte count in streaming contexts
    /// (e.g. a caller that stops feeding chunks early for some unrelated
    /// reason still wants to pass the file's true on-disk size here, exactly
    /// as a non-streaming caller can already pass a `filesize` that doesn't
    /// match `bytes.len()`).
    pub fn finalize(self, filesize: u64) -> MapleId {
        let sha1_full = self.sha1.finalize();

        let mut h = Blake3Hasher::new();
        h.update(&sha1_full);
        h.update(&filesize.to_le_bytes());

        let digest = h.finalize();
        let mut id = [0u8; 16];
        id[0] = TAG_FALLBACK;
        id[1..].copy_from_slice(&digest.as_bytes()[..15]);
        MapleId(id)
    }
}

impl Default for FallbackIdHasher {
    fn default() -> Self {
        Self::new()
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

    // --- FallbackIdHasher: streaming/incremental hashing (#1995) --------
    //
    // The single most important correctness property of this whole task:
    // `FallbackIdHasher::new()` + N `.update(chunk)` calls covering the same
    // bytes as one `MapleId::fallback(full_slice, filesize)` call MUST
    // produce byte-identical output, for ANY chunking. Each test below picks
    // a different chunk-boundary shape (including degenerate ones: empty
    // chunks, single-byte chunks, one chunk covering everything) over the
    // same deterministic pseudo-random byte buffer and compares against the
    // one-shot reference.

    /// Deterministic, non-trivial (not all-zero/all-same) byte content so a
    /// chunking bug that scrambles byte order would actually change the
    /// hash rather than being masked by degenerate input.
    fn pseudo_random_bytes(len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| {
                let x = (i as u64)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add(0x9E37_79B9);
                (x >> 24) as u8
            })
            .collect()
    }

    /// Feed `bytes` through a fresh [`FallbackIdHasher`] in the chunks
    /// implied by `splits` (an ascending sequence starting at `0` and ending
    /// at `bytes.len()`; consecutive equal values produce a zero-length
    /// chunk), then finalize with `bytes.len()` as the filesize.
    fn hash_via_splits(bytes: &[u8], splits: &[usize]) -> MapleId {
        assert_eq!(splits[0], 0, "splits must start at 0");
        assert_eq!(
            *splits.last().unwrap(),
            bytes.len(),
            "splits must end at bytes.len()"
        );
        let mut hasher = FallbackIdHasher::new();
        for w in splits.windows(2) {
            assert!(w[1] >= w[0], "splits must be non-decreasing");
            hasher.update(&bytes[w[0]..w[1]]);
        }
        hasher.finalize(bytes.len() as u64)
    }

    fn assert_matches_one_shot(bytes: &[u8], splits: &[usize]) {
        let expected = MapleId::fallback(bytes, bytes.len() as u64);
        let actual = hash_via_splits(bytes, splits);
        assert_eq!(
            actual, expected,
            "chunked hash diverged from one-shot MapleId::fallback for splits {:?}",
            splits
        );
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_single_chunk() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_byte_0() {
        // First chunk is empty (split immediately after nothing).
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 0, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_byte_1() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 1, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_63() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 63, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_64kb_minus_1() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 64 * 1024 - 1, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_64kb() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 64 * 1024, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_split_at_64kb_plus_1() {
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(&bytes, &[0, 64 * 1024 + 1, bytes.len()]);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_many_arbitrary_splits() {
        // Irregular boundary set, including a duplicate (4096, 4096) to
        // exercise a zero-length chunk mid-stream, not just at the edges.
        let bytes = pseudo_random_bytes(130_000);
        assert_matches_one_shot(
            &bytes,
            &[
                0,
                17,
                500,
                4096,
                4096,
                12_345,
                65_536,
                65_537,
                100_000,
                bytes.len(),
            ],
        );
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_all_single_byte_chunks() {
        // Smaller buffer — this test issues one `update` call per byte.
        let bytes = pseudo_random_bytes(300);
        let splits: Vec<usize> = (0..=bytes.len()).collect();
        assert_matches_one_shot(&bytes, &splits);
    }

    #[test]
    fn fallback_id_hasher_matches_one_shot_empty_input() {
        let bytes: Vec<u8> = Vec::new();
        assert_matches_one_shot(&bytes, &[0, 0]);
    }

    #[test]
    fn fallback_id_hasher_bytes_fed_tracks_updates() {
        let mut hasher = FallbackIdHasher::new();
        assert_eq!(hasher.bytes_fed(), 0);
        hasher.update(&[1, 2, 3]);
        assert_eq!(hasher.bytes_fed(), 3);
        hasher.update(&[]);
        assert_eq!(hasher.bytes_fed(), 3);
        hasher.update(&[4, 5]);
        assert_eq!(hasher.bytes_fed(), 5);
    }

    #[test]
    fn fallback_id_hasher_finalize_uses_explicit_filesize_not_bytes_fed() {
        // Mirrors MapleId::fallback's existing filesize-independent-of-
        // bytes-len contract (see raw-ffi's
        // maple_id_fallback_filesize_independent_of_bytes_len test): the
        // hasher must mix in whatever `filesize` finalize() is called with,
        // not the accumulated `bytes_fed()` count.
        let bytes = pseudo_random_bytes(100);
        let claimed_size = 999u64;
        let expected = MapleId::fallback(&bytes, claimed_size);

        let mut hasher = FallbackIdHasher::new();
        hasher.update(&bytes);
        assert_eq!(hasher.bytes_fed(), 100);
        let actual = hasher.finalize(claimed_size);
        assert_eq!(actual, expected);
    }

    #[test]
    fn fallback_id_hasher_output_is_tagged_fallback() {
        let bytes = pseudo_random_bytes(1024);
        let mut hasher = FallbackIdHasher::new();
        hasher.update(&bytes);
        let id = hasher.finalize(bytes.len() as u64);
        assert_eq!(id.kind(), IdKind::Fallback);
        assert_eq!(id.0[0], TAG_FALLBACK);
    }
}
