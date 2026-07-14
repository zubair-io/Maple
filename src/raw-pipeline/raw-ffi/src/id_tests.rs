//! Tests for the spec-form `maple_id_primary` / `maple_id_fallback`
//! FFI entries, plus the streaming `MapleFallbackIdHasher` opaque-handle
//! API (#1995). Each test computes the id via `raw_core::MapleId`
//! directly and asserts the FFI output matches byte-for-byte. Pure
//! functions over byte slices — no fixtures required.

use crate::id::{
    maple_fallback_id_hasher_finalize, maple_fallback_id_hasher_free, maple_fallback_id_hasher_new,
    maple_fallback_id_hasher_update, maple_id_fallback, maple_id_primary,
};

#[test]
fn maple_id_primary_matches_raw_core() {
    let mut bytes = vec![0u8; 1024];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = (i & 0xff) as u8;
    }
    let ts = b"2024:06:01 12:34:56";
    let serial = b"SN-1234";
    let expected =
        raw_core::MapleId::primary(&bytes, "2024:06:01 12:34:56", Some("SN-1234"), Some(4242))
            .to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_primary(
        bytes.as_ptr(),
        bytes.len(),
        ts.as_ptr(),
        ts.len(),
        serial.as_ptr(),
        serial.len(),
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
    let expected =
        raw_core::MapleId::primary(&bytes, "2024:06:01 12:34:56", None, Some(0)).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_primary(
        bytes.as_ptr(),
        bytes.len(),
        ts.as_ptr(),
        ts.len(),
        std::ptr::null(),
        0,
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
        std::ptr::null(),
        0,
        ts.as_ptr(),
        ts.len(),
        std::ptr::null(),
        0,
        0,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, -1);
    // null captured_at
    let bytes = [1u8; 8];
    let rc = maple_id_primary(
        bytes.as_ptr(),
        bytes.len(),
        std::ptr::null(),
        0,
        std::ptr::null(),
        0,
        0,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, -1);
    // null out_hex
    let rc = maple_id_primary(
        bytes.as_ptr(),
        bytes.len(),
        ts.as_ptr(),
        ts.len(),
        std::ptr::null(),
        0,
        0,
        std::ptr::null_mut(),
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
        bytes.as_ptr(),
        0,
        ts.as_ptr(),
        ts.len(),
        std::ptr::null(),
        0,
        0,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, -2);
    // zero captured_at_len
    let rc = maple_id_primary(
        bytes.as_ptr(),
        bytes.len(),
        ts.as_ptr(),
        0,
        std::ptr::null(),
        0,
        0,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, -2);
}

#[test]
fn maple_id_fallback_matches_raw_core() {
    let mut bytes = vec![0u8; 512];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = ((i * 7) & 0xff) as u8;
    }
    let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

    let mut out = [0u8; 32];
    let rc = maple_id_fallback(
        bytes.as_ptr(),
        bytes.len(),
        bytes.len() as u64,
        out.as_mut_ptr(),
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
    let rc = maple_id_fallback(bytes.as_ptr(), bytes.len(), claimed_size, out.as_mut_ptr());
    assert_eq!(rc, 0);
    assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
}

#[test]
fn maple_id_fallback_rejects_nulls_and_empty() {
    let mut out = [0u8; 32];
    let rc = maple_id_fallback(std::ptr::null(), 0, 0, out.as_mut_ptr());
    assert_eq!(rc, -1);
    let bytes = [1u8; 4];
    let rc = maple_id_fallback(
        bytes.as_ptr(),
        bytes.len(),
        bytes.len() as u64,
        std::ptr::null_mut(),
    );
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
            bytes.as_ptr(),
            bytes.len(),
            ts.as_ptr(),
            ts.len(),
            std::ptr::null(),
            0,
            0,
            prim.as_mut_ptr(),
        ),
        0,
    );
    assert_eq!(
        maple_id_fallback(
            bytes.as_ptr(),
            bytes.len(),
            bytes.len() as u64,
            fall.as_mut_ptr(),
        ),
        0,
    );
    assert!(prim.starts_with(b"01"));
    assert!(fall.starts_with(b"02"));
}

// --- MapleFallbackIdHasher: streaming FFI (#1995) ----------------------
//
// Each test drives the C-ABI create/update/.../finalize sequence and
// asserts the resulting hex matches `raw_core::MapleId::fallback(...)`
// computed directly — same style as the pure-function tests above.

#[test]
fn fallback_id_hasher_new_never_null() {
    let handle = maple_fallback_id_hasher_new();
    assert!(!handle.is_null());
    unsafe { maple_fallback_id_hasher_free(handle) };
}

#[test]
fn fallback_id_hasher_ffi_matches_raw_core_single_update() {
    let mut bytes = vec![0u8; 2048];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = ((i * 13) & 0xff) as u8;
    }
    let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

    let handle = maple_fallback_id_hasher_new();
    unsafe {
        let rc = maple_fallback_id_hasher_update(handle, bytes.as_ptr(), bytes.len());
        assert_eq!(rc, 0);
        let mut out = [0u8; 32];
        let rc = maple_fallback_id_hasher_finalize(handle, bytes.len() as u64, out.as_mut_ptr());
        assert_eq!(rc, 0);
        assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
    }
}

#[test]
fn fallback_id_hasher_ffi_matches_raw_core_multi_chunk() {
    // Chunk boundaries deliberately don't align to anything meaningful
    // (17, 63, 64KB - 1, 64KB, ...) — the FFI create/update/update/finalize
    // sequence must match the one-shot reference regardless.
    let mut bytes = vec![0u8; 200_000];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = ((i * 31 + 7) & 0xff) as u8;
    }
    let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

    let splits = [
        0usize,
        17,
        63,
        64 * 1024 - 1,
        64 * 1024,
        130_000,
        bytes.len(),
    ];
    let handle = maple_fallback_id_hasher_new();
    unsafe {
        for w in splits.windows(2) {
            let chunk = &bytes[w[0]..w[1]];
            let rc = maple_fallback_id_hasher_update(handle, chunk.as_ptr(), chunk.len());
            assert_eq!(rc, 0);
        }
        let mut out = [0u8; 32];
        let rc = maple_fallback_id_hasher_finalize(handle, bytes.len() as u64, out.as_mut_ptr());
        assert_eq!(rc, 0);
        assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
    }
}

#[test]
fn fallback_id_hasher_ffi_finalize_uses_explicit_filesize() {
    // Mirrors `maple_id_fallback_filesize_independent_of_bytes_len`: the
    // streaming finalize must mix in the `filesize` argument, not the
    // count of bytes actually fed via update.
    let bytes = [3u8; 100];
    let claimed_size = 999u64;
    let expected = raw_core::MapleId::fallback(&bytes, claimed_size).to_hex();

    let handle = maple_fallback_id_hasher_new();
    unsafe {
        let rc = maple_fallback_id_hasher_update(handle, bytes.as_ptr(), bytes.len());
        assert_eq!(rc, 0);
        let mut out = [0u8; 32];
        let rc = maple_fallback_id_hasher_finalize(handle, claimed_size, out.as_mut_ptr());
        assert_eq!(rc, 0);
        assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
    }
}

#[test]
fn fallback_id_hasher_ffi_zero_length_chunk_is_noop() {
    // An empty update (including a null chunk_ptr, since chunk_len == 0)
    // must not change the hash relative to never having called update at
    // all for that "chunk".
    let bytes = [9u8; 64];
    let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

    let handle = maple_fallback_id_hasher_new();
    unsafe {
        // Empty update before, in the middle, and after the real data.
        assert_eq!(
            maple_fallback_id_hasher_update(handle, std::ptr::null(), 0),
            0
        );
        assert_eq!(
            maple_fallback_id_hasher_update(handle, bytes.as_ptr(), bytes.len()),
            0
        );
        assert_eq!(
            maple_fallback_id_hasher_update(handle, std::ptr::null(), 0),
            0
        );
        let mut out = [0u8; 32];
        let rc = maple_fallback_id_hasher_finalize(handle, bytes.len() as u64, out.as_mut_ptr());
        assert_eq!(rc, 0);
        assert_eq!(std::str::from_utf8(&out).unwrap(), expected);
    }
}

#[test]
fn fallback_id_hasher_ffi_update_rejects_null_handle() {
    let bytes = [1u8; 8];
    let rc = unsafe { maple_fallback_id_hasher_update(std::ptr::null_mut(), bytes.as_ptr(), 8) };
    assert_eq!(rc, -1);
}

#[test]
fn fallback_id_hasher_ffi_update_rejects_null_chunk_with_nonzero_len() {
    let handle = maple_fallback_id_hasher_new();
    let rc = unsafe { maple_fallback_id_hasher_update(handle, std::ptr::null(), 8) };
    assert_eq!(rc, -1);
    unsafe { maple_fallback_id_hasher_free(handle) };
}

#[test]
fn fallback_id_hasher_ffi_finalize_rejects_nulls() {
    let mut out = [0u8; 32];
    // Null handle.
    let rc =
        unsafe { maple_fallback_id_hasher_finalize(std::ptr::null_mut(), 0, out.as_mut_ptr()) };
    assert_eq!(rc, -1);

    // Null out_hex: the handle is still consumed/freed even though this
    // call reports failure (the unconditional-free contract) — calling
    // `_free` again here would be a double-free, so we don't.
    let handle = maple_fallback_id_hasher_new();
    let rc = unsafe { maple_fallback_id_hasher_finalize(handle, 0, std::ptr::null_mut()) };
    assert_eq!(rc, -1);
}

#[test]
fn fallback_id_hasher_ffi_free_is_noop_on_null() {
    unsafe { maple_fallback_id_hasher_free(std::ptr::null_mut()) };
}

#[test]
fn fallback_id_hasher_ffi_free_allows_early_abort() {
    // Abandoning a hash mid-stream (free instead of finalize) must not
    // crash — this is the cancelled-read path.
    let bytes = [5u8; 4096];
    let handle = maple_fallback_id_hasher_new();
    unsafe {
        let rc = maple_fallback_id_hasher_update(handle, bytes.as_ptr(), bytes.len());
        assert_eq!(rc, 0);
        maple_fallback_id_hasher_free(handle);
    }
}
