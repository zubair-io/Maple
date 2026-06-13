//! Tests for the spec-form `maple_id_primary` / `maple_id_fallback`
//! FFI entries. Each test computes the id via `raw_core::MapleId`
//! directly and asserts the FFI output matches byte-for-byte. Pure
//! functions over byte slices — no fixtures required.

use crate::id::{maple_id_fallback, maple_id_primary};

#[test]
fn maple_id_primary_matches_raw_core() {
    let mut bytes = vec![0u8; 1024];
    for (i, b) in bytes.iter_mut().enumerate() { *b = (i & 0xff) as u8; }
    let ts = b"2024:06:01 12:34:56";
    let serial = b"SN-1234";
    let expected = raw_core::MapleId::primary(
        &bytes, "2024:06:01 12:34:56", Some("SN-1234"), Some(4242),
    ).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_primary(
        bytes.as_ptr(), bytes.len(),
        ts.as_ptr(), ts.len(),
        serial.as_ptr(), serial.len(),
        4242,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0);
    assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
}

#[test]
fn maple_id_primary_null_serial_matches_none_branch() {
    let bytes = [9u8; 256];
    let ts = b"2024:06:01 12:34:56";
    let expected = raw_core::MapleId::primary(
        &bytes, "2024:06:01 12:34:56", None, Some(0),
    ).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_primary(
        bytes.as_ptr(), bytes.len(),
        ts.as_ptr(), ts.len(),
        std::ptr::null(), 0,
        0,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0);
    assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
}

#[test]
fn maple_id_primary_rejects_nulls() {
    let mut out = [0u8; 32];
    let ts = b"2024:06:01 12:34:56";
    // null head
    let rc = maple_id_primary(
        std::ptr::null(), 0, ts.as_ptr(), ts.len(),
        std::ptr::null(), 0, 0, out.as_mut_ptr(),
    );
    assert_eq!(rc, -1);
    // null captured_at
    let bytes = [1u8; 8];
    let rc = maple_id_primary(
        bytes.as_ptr(), bytes.len(), std::ptr::null(), 0,
        std::ptr::null(), 0, 0, out.as_mut_ptr(),
    );
    assert_eq!(rc, -1);
    // null out_hex
    let rc = maple_id_primary(
        bytes.as_ptr(), bytes.len(), ts.as_ptr(), ts.len(),
        std::ptr::null(), 0, 0, std::ptr::null_mut(),
    );
    assert_eq!(rc, -1);
}

#[test]
fn maple_id_primary_rejects_empty_inputs() {
    let mut out = [0u8; 32];
    let bytes = [1u8; 8];
    let ts = b"2024:06:01 12:34:56";
    // zero head_len
    let rc = maple_id_primary(
        bytes.as_ptr(), 0, ts.as_ptr(), ts.len(),
        std::ptr::null(), 0, 0, out.as_mut_ptr(),
    );
    assert_eq!(rc, -2);
    // zero captured_at_len
    let rc = maple_id_primary(
        bytes.as_ptr(), bytes.len(), ts.as_ptr(), 0,
        std::ptr::null(), 0, 0, out.as_mut_ptr(),
    );
    assert_eq!(rc, -2);
}

#[test]
fn maple_id_fallback_matches_raw_core() {
    let mut bytes = vec![0u8; 512];
    for (i, b) in bytes.iter_mut().enumerate() { *b = ((i * 7) & 0xff) as u8; }
    let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_fallback(
        bytes.as_ptr(), bytes.len(), bytes.len() as u64, out.as_mut_ptr(),
    );
    assert_eq!(rc, 0);
    assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
}

#[test]
fn maple_id_fallback_filesize_independent_of_bytes_len() {
    // The fallback formula hashes (sha1_full || filesize_le_u64). When
    // the caller's slice doesn't match the file's true size (e.g. a
    // streaming buffer is shorter), filesize is passed separately —
    // confirm the FFI honours that contract instead of overriding it
    // with bytes_len.
    let bytes = [3u8; 100];
    let claimed_size = 999u64;
    let expected = raw_core::MapleId::fallback(&bytes, claimed_size).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_fallback(
        bytes.as_ptr(), bytes.len(), claimed_size, out.as_mut_ptr(),
    );
    assert_eq!(rc, 0);
    assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
}

#[test]
fn maple_id_fallback_rejects_nulls_and_empty() {
    let mut out = [0u8; 32];
    let rc = maple_id_fallback(std::ptr::null(), 0, 0, out.as_mut_ptr());
    assert_eq!(rc, -1);
    let bytes = [1u8; 4];
    let rc = maple_id_fallback(bytes.as_ptr(), bytes.len(), bytes.len() as u64, std::ptr::null_mut());
    assert_eq!(rc, -1);
    let rc = maple_id_fallback(bytes.as_ptr(), 0, 0, out.as_mut_ptr());
    assert_eq!(rc, -2);
}

/// Cross-form sanity: primary and fallback ids never collide because
/// of the tag-byte prefix (0x01 vs 0x02). The FFI must surface that
/// invariant — a primary id always starts "01", fallback always "02".
#[test]
fn maple_id_ffi_tags_distinct() {
    let bytes = [7u8; 128];
    let ts = b"2024:06:01 12:34:56";
    let mut prim = [0u8; 32];
    let mut fall = [0u8; 32];
    assert_eq!(
        maple_id_primary(
            bytes.as_ptr(), bytes.len(), ts.as_ptr(), ts.len(),
            std::ptr::null(), 0, 0, prim.as_mut_ptr(),
        ),
        0,
    );
    assert_eq!(
        maple_id_fallback(
            bytes.as_ptr(), bytes.len(), bytes.len() as u64, fall.as_mut_ptr(),
        ),
        0,
    );
    assert!(prim.starts_with(b"01"));
    assert!(fall.starts_with(b"02"));
}
