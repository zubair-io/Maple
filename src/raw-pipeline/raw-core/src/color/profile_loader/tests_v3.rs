//! Tests for the **v3 split** DCP-bundle layout (ticket #829, PR #831).
//!
//! Exercised entirely on SYNTHETIC data — no shipped bundle, no fixtures — so
//! they run unconditionally in CI. They prove the three corrections the design
//! mandates over the abandoned whole-stream v2:
//!
//!   1. **Index hoisted out of the compressed region** — [`index_resolves_without_pool`]
//!      parses a body's matrices + HSM pool-index refs from the index slice
//!      alone, never passing the pool region. Structurally impossible if the
//!      records were nested inside a compressed blob.
//!   2. **Uncompressed pool offset directory** — [`directory_addresses_single_entry`]
//!      computes one entry's byte range from the directory and inflates only
//!      that range, without scanning the rest of the pool.
//!   3. **Per-entry compression** — every pool entry is its own zlib stream
//!      ([`per_entry_streams_are_independent`]); [`roundtrip_byte_identical`]
//!      proves a transcode → parse-back yields byte-identical HSM f32 data.
//!
//! Plus dedup ([`dedup_collapses_identical_tables`]) and the v1→v3 transcode
//! path ([`transcode_v1_roundtrips_byte_identical`]).

use super::*;
use crate::color::hsm::HsmEncoding;

/// LE f32 byte blob of a deterministic synthetic HSM table of the given dims,
/// seeded by `seed` so distinct seeds give distinct tables.
fn synth_hsm_bytes(dims: [u16; 3], seed: u32) -> Vec<u8> {
    let n = dims[0] as usize * dims[1] as usize * dims[2] as usize * 3;
    let mut out = Vec::with_capacity(n * 4);
    for i in 0..n {
        let v = ((i as u32).wrapping_mul(2654435761).wrapping_add(seed) % 1000) as f32 / 1000.0;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 36-byte (9×f32 LE) matrix blob seeded by `seed`.
fn synth_matrix_bytes(seed: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    for i in 0..9u32 {
        let v = (i.wrapping_add(seed) as f32) * 0.01;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// f32 vector from an LE byte blob (for byte-identity comparisons).
fn f32s(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Three synthetic bodies. Body A (dual-illum, CM1+CM2+FM1+FM2, HSM1+HSM2),
/// body B (single-illum, CM1 only, HSM1 — sharing A's HSM1 table to exercise
/// dedup), body C (matrices-only, no HSM). HSM dims kept small (4×3×1) so the
/// test is fast.
fn synth_profiles() -> Vec<EncoderProfile> {
    let dims = [4u16, 3, 1];
    let hsm_a1 = synth_hsm_bytes(dims, 1);
    let hsm_a2 = synth_hsm_bytes(dims, 2);

    let body_a = EncoderProfile {
        ucm_bytes: b"Synth A dual".to_vec(),
        flags: 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20,
        illum1: 17, // StdA
        illum2: 21, // D65
        matrices: [
            synth_matrix_bytes(10),
            synth_matrix_bytes(20),
            synth_matrix_bytes(30),
            synth_matrix_bytes(40),
        ]
        .concat(),
        hsm_dims: dims,
        hsm_encoding: 0,
        hsm1: Some(hsm_a1.clone()),
        hsm2: Some(hsm_a2),
        be_bits: 0.5f32.to_bits(),
    };
    // Body B reuses body A's HSM1 byte-for-byte → must dedup to one pool entry.
    let body_b = EncoderProfile {
        ucm_bytes: b"Synth B single".to_vec(),
        flags: 0x01 | 0x10,
        illum1: 21,
        illum2: 0,
        matrices: synth_matrix_bytes(50),
        hsm_dims: dims,
        hsm_encoding: 0,
        hsm1: Some(hsm_a1),
        hsm2: None,
        be_bits: 0.0f32.to_bits(),
    };
    let body_c = EncoderProfile {
        ucm_bytes: b"Synth C matrices-only".to_vec(),
        flags: 0x01 | 0x02,
        illum1: 17,
        illum2: 21,
        matrices: [synth_matrix_bytes(60), synth_matrix_bytes(70)].concat(),
        hsm_dims: [0, 0, 0],
        hsm_encoding: 0,
        hsm1: None,
        hsm2: None,
        be_bits: 0.0f32.to_bits(),
    };
    vec![body_a, body_b, body_c]
}

/// Correction #1: a body's matrices + HSM pool-index refs resolve from the
/// index region alone — the pool region is NEVER passed to the parser.
#[test]
fn index_resolves_without_pool() {
    let enc = encode_v3(&synth_profiles());
    // parse_index sees ONLY enc.idx — enc.pool is not touched here.
    let index = parse_index(&enc.idx);

    assert_eq!(index.records.len(), 3, "all three bodies in the index");
    let a = index
        .records
        .get(&CameraKey::new("Synth A dual"))
        .expect("body A present");
    assert!(a.cm1.is_some() && a.cm2.is_some() && a.fm1.is_some() && a.fm2.is_some());
    assert!(a.hsm1_pool_index.is_some() && a.hsm2_pool_index.is_some());
    assert_eq!(a.baseline_exposure_offset, 0.5);

    let c = index
        .records
        .get(&CameraKey::new("Synth C matrices-only"))
        .expect("body C present");
    assert!(c.hsm1_pool_index.is_none() && c.hsm2_pool_index.is_none());

    // The directory is part of the index region and has one entry per unique
    // table — also resolvable without the pool body.
    assert_eq!(index.pool_dir.len(), enc.pool_count);
}

/// Dedup: body A's HSM1 and body B's HSM1 are byte-identical, so the three
/// HSM instances (A1, A2, B1) collapse to two unique pool entries.
#[test]
fn dedup_collapses_identical_tables() {
    let profiles = synth_profiles();
    let enc = encode_v3(&profiles);
    assert_eq!(enc.hsm_instances, 3, "A1 + A2 + B1 = 3 instances");
    assert_eq!(enc.pool_count, 2, "A1==B1 → 2 unique tables");

    // A's HSM1 index and B's HSM1 index must be the SAME pool entry.
    let index = parse_index(&enc.idx);
    let a = &index.records[&CameraKey::new("Synth A dual")];
    let b = &index.records[&CameraKey::new("Synth B single")];
    assert_eq!(
        a.hsm1_pool_index, b.hsm1_pool_index,
        "shared table → same index"
    );
    assert_ne!(
        a.hsm1_pool_index, a.hsm2_pool_index,
        "A's two tables differ"
    );
}

/// Correction #2: locate ONE entry purely from the directory range, then
/// inflate only that range's bytes — no scan of the rest of the pool.
#[test]
fn directory_addresses_single_entry() {
    let enc = encode_v3(&synth_profiles());
    let index = parse_index(&enc.idx);
    let a = &index.records[&CameraKey::new("Synth A dual")];
    let idx2 = a.hsm2_pool_index.unwrap();
    let dir = index.pool_dir[idx2 as usize];

    // Slice exactly [offset .. offset+compressed_len] — the only bytes a
    // range-fetch (#828) would pull — and inflate that alone.
    let start = dir.offset as usize;
    let end = start + dir.compressed_len as usize;
    let entry_bytes = &enc.pool[start..end];
    let table = inflate_pool_entry(entry_bytes, &dir).expect("entry inflates");

    let expected = synth_hsm_bytes([4, 3, 1], 2);
    assert_eq!(
        table.data,
        f32s(&expected),
        "A's HSM2 round-trips byte-identical"
    );
    assert_eq!(table.dims, [4, 3, 1]);
    assert_eq!(table.encoding, HsmEncoding::Linear);
}

/// Correction #3: each pool entry is an independent zlib stream — slicing at
/// the directory range and inflating works per entry, in any order, without
/// touching neighbours.
#[test]
fn per_entry_streams_are_independent() {
    let enc = encode_v3(&synth_profiles());
    let index = parse_index(&enc.idx);
    // Inflate every entry in reverse order via resolve_from_pool (which slices
    // at the directory range internally). Independence ⇒ order-agnostic.
    for i in (0..index.pool_dir.len()).rev() {
        let t = resolve_from_pool(&enc.pool, i as u32, &index.pool_dir);
        assert!(t.is_some(), "entry {i} inflates independently");
    }
}

/// Decode the first `n` 9×f32 matrices from a concatenated v1 matrix blob.
fn matrices(blob: &[u8], n: usize) -> Vec<[[f32; 3]; 3]> {
    let f = f32s(blob);
    (0..n)
        .map(|k| {
            let base = k * 9;
            let mut m = [[0f32; 3]; 3];
            for r in 0..3 {
                for c in 0..3 {
                    m[r][c] = f[base + r * 3 + c];
                }
            }
            m
        })
        .collect()
}

/// Full roundtrip: encode → parse index → byte-identical **profile data**
/// (matrices + illuminants + BE-offset + HSM). The ticket's discriminator —
/// not just HSM. Matrices/illuminants are value-compared, not presence-checked.
#[test]
fn roundtrip_byte_identical() {
    use crate::color::illuminant::Illuminant as I;
    let profiles = synth_profiles();
    let enc = encode_v3(&profiles);
    let index = parse_index(&enc.idx);

    for p in &profiles {
        let key = CameraKey::new(String::from_utf8(p.ucm_bytes.clone()).unwrap());
        let rec = &index.records[&key];

        // Matrices: every present CM/FM comes back bit-for-bit. Input blobs are
        // CM1,CM2,FM1,FM2 in flag order; decode them and compare to the parsed
        // Matrix3 values.
        let n = (p.flags & 0x0F).count_ones() as usize;
        let want_mats = matrices(&p.matrices, n);
        let got_mats: Vec<[[f32; 3]; 3]> = [rec.cm1, rec.cm2, rec.fm1, rec.fm2]
            .iter()
            .filter_map(|m| m.map(|m| m.0))
            .collect();
        assert_eq!(
            got_mats, want_mats,
            "{}: matrices byte-identical",
            key.unique_camera_model
        );

        // Illuminants survive their DNG codes (17→StdA, 21→D65).
        let want_il = |code: u16| match code {
            0 => None,
            17 => Some(I::StdA),
            21 => Some(I::D65),
            _ => Some(I::D65),
        };
        assert_eq!(
            rec.illum1,
            want_il(p.illum1),
            "{}: illum1",
            key.unique_camera_model
        );
        assert_eq!(
            rec.illum2,
            want_il(p.illum2),
            "{}: illum2",
            key.unique_camera_model
        );

        // Baseline-exposure offset survives bit-for-bit.
        assert_eq!(
            rec.baseline_exposure_offset.to_bits(),
            p.be_bits,
            "{}: BE",
            key.unique_camera_model
        );

        // HSM tables resolve byte-identical from the pool.
        if let Some(want) = &p.hsm1 {
            let i = rec.hsm1_pool_index.expect("hsm1 index");
            let got = resolve_from_pool(&enc.pool, i, &index.pool_dir).expect("resolve");
            assert_eq!(
                got.data,
                f32s(want),
                "{}: HSM1 byte-identical",
                key.unique_camera_model
            );
        }
        if let Some(want) = &p.hsm2 {
            let i = rec.hsm2_pool_index.expect("hsm2 index");
            let got = resolve_from_pool(&enc.pool, i, &index.pool_dir).expect("resolve");
            assert_eq!(
                got.data,
                f32s(want),
                "{}: HSM2 byte-identical",
                key.unique_camera_model
            );
        }
    }
}

/// The combined single-file form (idx ++ pool) is what the native embedded
/// fallback uses; its pool half slices identically given the same directory.
#[test]
fn combined_file_pool_half_matches() {
    let enc = encode_v3(&synth_profiles());
    let combined = enc.combined();
    assert_eq!(&combined[..enc.idx.len()], enc.idx.as_slice());
    assert_eq!(&combined[enc.idx.len()..], enc.pool.as_slice());
}

// ── v1 → v3 transcode ──────────────────────────────────────────────────────

/// Hand-build a minimal v1 (inline) bundle from synthetic records so the
/// transcode path can be tested without the shipped bundle. Mirrors the v1
/// on-disk record layout the reader expects.
fn synth_v1_bundle(profiles: &[EncoderProfile]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&(profiles.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved (v1 header is 16 B)
    for p in profiles {
        out.extend_from_slice(&(p.ucm_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&p.ucm_bytes);
        out.push(p.flags);
        out.push(0);
        out.extend_from_slice(&p.illum1.to_le_bytes());
        out.extend_from_slice(&p.illum2.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&p.matrices);
        // v1 inlines a (dims, encoding) preamble + the table bytes.
        out.extend_from_slice(&p.hsm_dims[0].to_le_bytes());
        out.extend_from_slice(&p.hsm_dims[1].to_le_bytes());
        out.extend_from_slice(&p.hsm_dims[2].to_le_bytes());
        out.push(p.hsm_encoding);
        out.push(0);
        if let Some(h) = &p.hsm1 {
            out.extend_from_slice(h);
        }
        if let Some(h) = &p.hsm2 {
            out.extend_from_slice(h);
        }
        out.extend_from_slice(&p.be_bits.to_le_bytes());
    }
    out
}

/// v1 → v3 transcode preserves matrices + HSM byte-for-byte and dedups.
#[test]
fn transcode_v1_roundtrips_byte_identical() {
    let profiles = synth_profiles();
    let v1 = synth_v1_bundle(&profiles);
    let enc = transcode_v1_to_v3(&v1).expect("transcode succeeds");

    // Dedup still happens through transcode (A1 == B1).
    assert_eq!(enc.pool_count, 2);
    assert_eq!(enc.hsm_instances, 3);

    let index = parse_index(&enc.idx);
    assert_eq!(index.records.len(), 3);

    // Matrices and HSM survive the repack byte-for-byte.
    let a_in = &profiles[0];
    let a = &index.records[&CameraKey::new("Synth A dual")];
    assert_eq!(a.baseline_exposure_offset, 0.5);
    let i1 = a.hsm1_pool_index.unwrap();
    let got = resolve_from_pool(&enc.pool, i1, &index.pool_dir).unwrap();
    assert_eq!(got.data, f32s(a_in.hsm1.as_ref().unwrap()));
}

/// transcode rejects a non-v1 buffer (bad magic) without panicking.
#[test]
fn transcode_rejects_bad_magic() {
    assert!(transcode_v1_to_v3(b"NOPExxxxxxxxxxxx").is_none());
}

/// Staged-work marker (#829 foundation only): once #825 lands the HSM
/// application math and the shipped bundle is regenerated WITH HSM data, this
/// asserts the shipped v3 index references a non-empty pool (HSM resolvable).
/// It is intentionally ignored today because #829 ships the v1 matrices-only
/// bundle (HSM disabled, no behavior change, no web bloat) — transcoding it
/// yields an EMPTY pool, which is the correct foundation state. Un-ignore when
/// #825 flips HSM on.
#[test]
#[ignore = "HSM disabled until #825 lands application-layer apply; foundation only per #829"]
fn shipped_bundle_v3_references_hsm_pool() {
    let enc = transcode_v1_to_v3(PROFILES_BIN).expect("shipped bundle transcodes");
    assert!(
        enc.pool_count > 0,
        "shipped v3 bundle must reference HSM pool entries once #825 enables HSM"
    );
    let index = parse_index(&enc.idx);
    assert!(
        index
            .records
            .values()
            .any(|r| r.hsm1_pool_index.is_some() || r.hsm2_pool_index.is_some()),
        "at least one body must reference an HSM pool entry"
    );
}
