//! Encoder for the **v3 split** DCP-bundle layout (ticket #829, design PR #831).
//!
//! This is the corrected, lazy-fetch-friendly encoding that REPLACES the
//! abandoned whole-stream v2 (single zlib over pool+records, index nested
//! inside the compressed region — see #828's load-bearing verdict). The three
//! corrections this module implements:
//!
//!   1. **Index hoisted out of the compressed region.** The header, the pool
//!      offset directory, and every profile record live uncompressed in the
//!      *index region* (`profiles.idx`, ~263 KB class). A body's matrices +
//!      HSM pool-index refs resolve without inflating any HSM.
//!   2. **Uncompressed pool offset directory.** `pool_count` entries of
//!      `(offset, compressed_len, dims, encoding)` so the exact byte range of
//!      pool entry N is computable from the index alone — the enabler for
//!      #828's per-body range fetch.
//!   3. **Per-entry zlib.** Each unique HSM table is its own independent zlib
//!      stream in the *pool region* (`profiles.pool`), so one body's entries
//!      inflate (and range-fetch) in isolation.
//!
//! The dedup *concept* is reused verbatim from the #379 work: Adobe ships
//! byte-identical HSM tables across many lens/style variants, so interning by
//! full table identity `(dims, encoding, bytes)` collapses ~2,162 instances to
//! ~1,193 unique tables. First-seen order is preserved so the output is
//! deterministic for a given input ordering.
//!
//! ## v3 byte layout (little-endian throughout)
//!
//! ```text
//! Index region (profiles.idx) — uncompressed:
//!   Header (16 bytes)
//!     [0..4]   magic         b"MDCP"
//!     [4..6]   version       u16 = 3
//!     [6..8]   flags         u16 (=0, reserved)
//!     [8..12]  num_profiles  u32
//!     [12..16] pool_count    u32
//!   pool_directory: pool_count × 16 bytes
//!     offset         u32   byte offset within the POOL region
//!     compressed_len u32   zlib-stream length within the POOL region
//!     hsm_h          u16
//!     hsm_s          u16
//!     hsm_v          u16
//!     encoding       u8    0=Linear, 1=sRGB
//!     reserved       u8    (=0)
//!   records: num_profiles × {
//!     ucm_len        u16
//!     ucm            ucm_len bytes (utf-8, no NUL)
//!     flags          u8    bit0=CM1 bit1=CM2 bit2=FM1 bit3=FM2 bit4=HSM1 bit5=HSM2
//!     reserved       u8    (=0)
//!     illum1         u16   DNG CalibrationIlluminant code, 0 if absent
//!     illum2         u16
//!     reserved       u16   (=0)
//!     (each present matrix: 9×f32 = 36 B; order CM1, CM2, FM1, FM2)
//!     (if HSM1: hsm1_pool_index u32)
//!     (if HSM2: hsm2_pool_index u32)
//!     baseline_exposure_offset_bits u32  (IEEE754 f32 bits)
//!   }
//!
//! Pool region (profiles.pool):
//!   pool_count × { zlib stream of (h*s*v*3) f32 — one independent stream }
//!   entry K occupies pool[offset_K .. offset_K + compressed_len_K]
//! ```
//!
//! A **combined** single-file form (index region immediately followed by the
//! pool region, directory offsets relative to the pool-region start) is also
//! emitted for the native embedded path; web prefers the two-file split. Both
//! come from the same in-memory model — see [`encode_v3`].

use std::collections::HashMap;

use super::{FORMAT_VERSION_V3, MAGIC};

/// zlib level for per-entry compression. 9 = max ratio; this runs once at
/// bundle-build time (the converter), never at load or in the render loop.
const DEFLATE_LEVEL: u8 = 9;

/// One body's color data destined for the v3 bundle. `hsm1`/`hsm2` carry the
/// raw `h*s*v*3` f32 payload (as little-endian bytes) plus their dims +
/// encoding; the encoder dedups + compresses them into the pool. Matrices are
/// held as raw 36-byte (9×f32 LE) blobs in CM1,CM2,FM1,FM2 order for whichever
/// `flags` bits are set — matching the v1 on-disk matrix encoding so transcode
/// copies them verbatim without float round-trips.
#[derive(Clone, Debug)]
pub struct EncoderProfile {
    pub ucm_bytes: Vec<u8>,
    pub flags: u8,
    pub illum1: u16,
    pub illum2: u16,
    /// Concatenated 36-byte matrix blobs (CM1,CM2,FM1,FM2 in flag order).
    pub matrices: Vec<u8>,
    pub hsm_dims: [u16; 3],
    pub hsm_encoding: u8,
    /// Raw HSM table bytes (LE f32), present iff `flags & 0x10`.
    pub hsm1: Option<Vec<u8>>,
    /// Raw HSM table bytes (LE f32), present iff `flags & 0x20`.
    pub hsm2: Option<Vec<u8>>,
    /// IEEE754 f32 bits of the baseline-exposure offset.
    pub be_bits: u32,
}

/// The two byte buffers a v3 encode produces: the always-resident index region
/// and the separately-addressable pool region. The combined single-file form
/// is simply `idx` followed by `pool` (directory offsets are pool-relative).
pub struct EncodedV3 {
    /// `profiles.idx` — header + pool directory + records (uncompressed).
    pub idx: Vec<u8>,
    /// `profiles.pool` — concatenated per-entry zlib streams.
    pub pool: Vec<u8>,
    /// Number of unique HSM tables interned into the pool.
    pub pool_count: usize,
    /// Total HSM-table instances seen across all records (pre-dedup).
    pub hsm_instances: usize,
}

impl EncodedV3 {
    /// Combined single-file bundle: index region then pool region, directory
    /// offsets already pool-relative so the two halves are independently
    /// addressable. This is what the native embedded fallback uses.
    pub fn combined(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.idx.len() + self.pool.len());
        out.extend_from_slice(&self.idx);
        out.extend_from_slice(&self.pool);
        out
    }
}

/// Identity key for pool dedup: dims + encoding + exact table bytes. Two tables
/// that share a byte payload but differ in declared dims/encoding are NOT
/// merged (matches the #379 Python `intern` keying).
type PoolKey = ([u16; 3], u8, Vec<u8>);

/// Encode a set of bodies into the v3 split layout.
///
/// Dedups HSM tables into a shared pool (first-seen order), compresses each
/// pool entry as an independent zlib stream, builds the offset directory, and
/// lays out the index region. Deterministic for a given input ordering.
pub fn encode_v3(profiles: &[EncoderProfile]) -> EncodedV3 {
    // ── Build the dedup pool (interning by full table identity) ──────────────
    let mut pool_order: Vec<PoolKey> = Vec::new();
    let mut index_of: HashMap<PoolKey, u32> = HashMap::new();
    let mut hsm_instances = 0usize;

    let mut intern = |dims: [u16; 3], enc: u8, blob: &[u8]| -> u32 {
        let key: PoolKey = (dims, enc, blob.to_vec());
        if let Some(&idx) = index_of.get(&key) {
            idx
        } else {
            let idx = pool_order.len() as u32;
            index_of.insert(key.clone(), idx);
            pool_order.push(key);
            idx
        }
    };

    // Record-by-record: resolve each present HSM table to a pool index.
    // (idx values stored in a parallel vec; records are serialized in the
    // second pass once the pool directory offsets are known — actually the
    // record bytes don't depend on offsets, only on indices, so we build them
    // here.)
    let mut record_bytes: Vec<u8> = Vec::new();
    for p in profiles {
        let idx1 = p.hsm1.as_ref().map(|b| {
            hsm_instances += 1;
            intern(p.hsm_dims, p.hsm_encoding, b)
        });
        let idx2 = p.hsm2.as_ref().map(|b| {
            hsm_instances += 1;
            intern(p.hsm_dims, p.hsm_encoding, b)
        });

        record_bytes.extend_from_slice(&(p.ucm_bytes.len() as u16).to_le_bytes());
        record_bytes.extend_from_slice(&p.ucm_bytes);
        record_bytes.push(p.flags);
        record_bytes.push(0); // reserved
        record_bytes.extend_from_slice(&p.illum1.to_le_bytes());
        record_bytes.extend_from_slice(&p.illum2.to_le_bytes());
        record_bytes.extend_from_slice(&0u16.to_le_bytes()); // reserved
        record_bytes.extend_from_slice(&p.matrices);
        if let Some(i) = idx1 {
            record_bytes.extend_from_slice(&i.to_le_bytes());
        }
        if let Some(i) = idx2 {
            record_bytes.extend_from_slice(&i.to_le_bytes());
        }
        record_bytes.extend_from_slice(&p.be_bits.to_le_bytes());
    }

    // ── Compress each pool entry independently, building the directory ───────
    let mut pool_region: Vec<u8> = Vec::new();
    let mut dir_bytes: Vec<u8> = Vec::with_capacity(pool_order.len() * 16);
    for (dims, enc, blob) in &pool_order {
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(blob, DEFLATE_LEVEL);
        let offset = pool_region.len() as u32;
        let clen = compressed.len() as u32;
        dir_bytes.extend_from_slice(&offset.to_le_bytes());
        dir_bytes.extend_from_slice(&clen.to_le_bytes());
        dir_bytes.extend_from_slice(&dims[0].to_le_bytes());
        dir_bytes.extend_from_slice(&dims[1].to_le_bytes());
        dir_bytes.extend_from_slice(&dims[2].to_le_bytes());
        dir_bytes.push(*enc);
        dir_bytes.push(0); // reserved
        pool_region.extend_from_slice(&compressed);
    }

    // ── Assemble the index region (header + directory + records) ─────────────
    let mut idx: Vec<u8> = Vec::with_capacity(16 + dir_bytes.len() + record_bytes.len());
    idx.extend_from_slice(MAGIC);
    idx.extend_from_slice(&FORMAT_VERSION_V3.to_le_bytes());
    idx.extend_from_slice(&0u16.to_le_bytes()); // flags
    idx.extend_from_slice(&(profiles.len() as u32).to_le_bytes());
    idx.extend_from_slice(&(pool_order.len() as u32).to_le_bytes());
    idx.extend_from_slice(&dir_bytes);
    idx.extend_from_slice(&record_bytes);

    EncodedV3 {
        idx,
        pool: pool_region,
        pool_count: pool_order.len(),
        hsm_instances,
    }
}
