//! Hashing + maple_id FFI entries — `maple_blake3_hex`,
//! `maple_id_primary`, `maple_id_fallback`. Pure functions over byte
//! slices; no rawler, no allocator dance, no thread-local error state.
//!
//! Also the streaming fallback-form hasher (#1995):
//! `maple_fallback_id_hasher_new` / `_update` / `_finalize` / `_free`. Unlike
//! the pure functions above, this is a stateful opaque-handle API — see
//! [`MapleFallbackIdHasher`]'s doc comment for the lifecycle and the ABI
//! shape it mirrors (`MapleCancelFlag` in `crate::cancel`).

/// Compute BLAKE3 hex of arbitrary bytes. Output buffer must be at least 64
/// bytes (BLAKE3 is 256-bit → 64 hex chars). No null terminator — the caller
/// knows the length is exactly 64.
///
/// Returns 0 on success, -1 on null pointers, -2 on zero-length input.
#[no_mangle]
pub extern "C" fn maple_blake3_hex(
    bytes_ptr: *const u8,
    bytes_len: usize,
    out_hex: *mut u8,
) -> i32 {
    if bytes_ptr.is_null() || out_hex.is_null() {
        return -1;
    }
    if bytes_len == 0 {
        return -2;
    }
    let bytes = unsafe { std::slice::from_raw_parts(bytes_ptr, bytes_len) };
    let hex = raw_core::blake3_hex(bytes);
    unsafe {
        std::ptr::copy_nonoverlapping(hex.as_ptr(), out_hex, 64);
    }
    0
}

/// Compute the spec-form **primary** maple_id over a file's leading bytes.
/// Output is the 32-character lowercase hex of the 16-byte tagged id
/// (`0x01 || BLAKE3(SHA1(head) || captured_at || serial || u64_le(shutter))[..15]`).
///
/// Only the first `SHA1_HEAD_BYTES` (= 64 KB) of `head_ptr` feed `sha1Head`;
/// callers may safely pass exactly the first 64 KB rather than the whole
/// file. `captured_at_ptr` is hashed verbatim (UTF-8 bytes; the server's
/// indexer normalises the EXIF date to ISO 8601 before hashing — the device
/// must match that string byte-for-byte for dedup to fire).
///
/// `serial_ptr` may be null (or `serial_len == 0`) — absent serial is
/// hashed as empty bytes, matching `MapleId::primary(_, _, None, _)`.
///
/// `shutter_count == 0` is hashed as `0u64_le`, identical to
/// `MapleId::primary(_, _, _, None)`. The spec documents that a real
/// shutter-count of 0 collides with "absent" — this is by design.
///
/// `out_hex` must point to at least 32 writable bytes. No null terminator.
///
/// Returns:
///   0  success
///  -1  null pointer for `head_ptr`, `captured_at_ptr`, or `out_hex`
///  -2  `head_len == 0`, `captured_at_len == 0`, OR `captured_at_ptr`
///       does not decode as valid UTF-8 (the hash hashes its UTF-8 byte
///       view, so non-UTF-8 input is rejected up front rather than hashed)
#[no_mangle]
pub extern "C" fn maple_id_primary(
    head_ptr: *const u8,
    head_len: usize,
    captured_at_ptr: *const u8,
    captured_at_len: usize,
    serial_ptr: *const u8,
    serial_len: usize,
    shutter_count: u64,
    out_hex: *mut u8,
) -> i32 {
    if head_ptr.is_null() || captured_at_ptr.is_null() || out_hex.is_null() {
        return -1;
    }
    if head_len == 0 || captured_at_len == 0 {
        return -2;
    }
    let head = unsafe { std::slice::from_raw_parts(head_ptr, head_len) };
    let captured_at_bytes = unsafe { std::slice::from_raw_parts(captured_at_ptr, captured_at_len) };
    let Ok(captured_at) = std::str::from_utf8(captured_at_bytes) else {
        return -2;
    };
    // Treat null pointer OR zero length OR non-UTF-8 as "no serial". Hashing
    // ignores serial in that case (matches MapleId::primary(_, _, None, _)).
    let serial: Option<&str> = if serial_ptr.is_null() || serial_len == 0 {
        None
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(serial_ptr, serial_len) };
        std::str::from_utf8(bytes).ok()
    };
    let id = raw_core::MapleId::primary(head, captured_at, serial, Some(shutter_count));
    let hex = id.to_hex();
    let hex_bytes = hex.as_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(hex_bytes.as_ptr(), out_hex, 32);
    }
    0
}

/// Compute the spec-form **fallback** maple_id over a file's full bytes.
/// Output is the 32-character lowercase hex of the 16-byte tagged id
/// (`0x02 || BLAKE3(SHA1(all_bytes) || u64_le(filesize))[..15]`).
///
/// `filesize` is typically `bytes_len` but is passed separately so callers
/// streaming or aliasing buffers can pass the canonical file size
/// independently (matches the spec formula).
///
/// `out_hex` must point to at least 32 writable bytes. No null terminator.
///
/// Returns:
///   0  success
///  -1  null pointer for `bytes_ptr` or `out_hex`
///  -2  `bytes_len == 0`
#[no_mangle]
pub extern "C" fn maple_id_fallback(
    bytes_ptr: *const u8,
    bytes_len: usize,
    filesize: u64,
    out_hex: *mut u8,
) -> i32 {
    if bytes_ptr.is_null() || out_hex.is_null() {
        return -1;
    }
    if bytes_len == 0 {
        return -2;
    }
    let bytes = unsafe { std::slice::from_raw_parts(bytes_ptr, bytes_len) };
    let id = raw_core::MapleId::fallback(bytes, filesize);
    let hex = id.to_hex();
    let hex_bytes = hex.as_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(hex_bytes.as_ptr(), out_hex, 32);
    }
    0
}

/// Opaque streaming fallback-form id hasher (#1995): lets
/// `maple_id_fallback`'s `sha1_full` term be built from chunks arriving over
/// time (an SMB byte-range read, a bytes-per-tick copy loop) instead of
/// requiring the whole file already resident as one buffer.
///
/// ABI shape mirrors [`crate::cancel::MapleCancelFlag`] /
/// [`crate::handle::MapleRawHandle`] exactly: `#[repr(C)]` with a single
/// `*mut c_void` field pointing at a heap-boxed `raw_core::FallbackIdHasher`
/// the C/Swift side never sees the layout of. cbindgen emits this as an
/// opaque typedef, same as those two.
///
/// Lifecycle (host responsibility):
///   1. [`maple_fallback_id_hasher_new`] — allocate.
///   2. [`maple_fallback_id_hasher_update`] — any number of times, in file
///      order, as chunks arrive.
///   3. Exactly one of:
///      - [`maple_fallback_id_hasher_finalize`] — consumes and frees the
///        handle, writing the 32-char hex id.
///      - [`maple_fallback_id_hasher_free`] — abandons the hash (e.g. the
///        caller cancelled a chunked read partway through) without
///        computing an id.
///
/// A handle must not be used again after either `_finalize` or `_free` has
/// consumed it — same caller obligation as `MapleRawHandle` /
/// `MapleCancelFlag` (this crate does not, and cannot, guard against reuse
/// of an already-freed raw pointer; the null checks below only cover the
/// caller passing a genuinely null pointer, not a dangling one).
#[repr(C)]
pub struct MapleFallbackIdHasher {
    /// Opaque pointer to a heap-allocated `raw_core::FallbackIdHasher`. Not
    /// introspected by callers.
    inner: *mut std::ffi::c_void,
}

/// Allocate a fresh streaming fallback-id hasher (no bytes fed yet). Never
/// returns null. Free it with either `maple_fallback_id_hasher_finalize`
/// (normal completion) or `maple_fallback_id_hasher_free` (early abort).
#[no_mangle]
pub extern "C" fn maple_fallback_id_hasher_new() -> *mut MapleFallbackIdHasher {
    let inner = Box::new(raw_core::FallbackIdHasher::new());
    let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
    Box::into_raw(Box::new(MapleFallbackIdHasher { inner: inner_ptr }))
}

/// Feed the next chunk of file bytes into the running hash. Chunks must be
/// fed **in file order**; length is caller-defined and may vary call to
/// call. `chunk_len == 0` is a valid no-op (matches
/// `raw_core::FallbackIdHasher::update`'s empty-chunk contract) — in that
/// case `chunk_ptr` may be null.
///
/// Returns:
///   0  success
///  -1  null `handle`, a `handle` whose inner state is null (freed/invalid),
///      or null `chunk_ptr` while `chunk_len > 0`
#[no_mangle]
pub unsafe extern "C" fn maple_fallback_id_hasher_update(
    handle: *mut MapleFallbackIdHasher,
    chunk_ptr: *const u8,
    chunk_len: usize,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    if chunk_ptr.is_null() && chunk_len > 0 {
        return -1;
    }
    let inner_ptr = (*handle).inner as *mut raw_core::FallbackIdHasher;
    if inner_ptr.is_null() {
        return -1;
    }
    let chunk: &[u8] = if chunk_len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(chunk_ptr, chunk_len)
    };
    (*inner_ptr).update(chunk);
    0
}

/// Finish the hash. **Always** consumes and frees a non-null `handle`
/// before returning — including on every error path below — so the
/// lifecycle rule is a single, unconditional sentence: after calling this
/// function once, `handle` is gone, full stop; never call
/// `maple_fallback_id_hasher_update`, `_finalize`, or `_free` on it again,
/// regardless of the return code. (An earlier revision only freed on the
/// success path and on the "inner state already null" error path, silently
/// leaking the handle when `out_hex` was null — a real bug caught by
/// review: a caller reading only the "0 success" line of a doc comment,
/// not every error branch, would reasonably assume freeing was always
/// handled and never call `_free` themselves.) On a null `handle`, this is
/// a no-op (nothing to free) — same as `maple_fallback_id_hasher_free`'s
/// null-is-noop convention.
///
/// Writes the 32-character lowercase hex fallback-form id to `out_hex`
/// (must point to at least 32 writable bytes; no null terminator) — only
/// on success.
///
/// `filesize` is passed explicitly — same contract as `maple_id_fallback` /
/// `raw_core::MapleId::fallback` / `raw_core::FallbackIdHasher::finalize`:
/// typically equal to the total bytes fed via `update`, but callers may
/// pass a different value (the spec formula's `filesize` term is
/// independent of the hashed byte count).
///
/// Returns:
///   0  success
///  -1  null `handle` (no-op), a `handle` whose inner state is null
///      (freed/invalid), or null `out_hex` — `handle` is freed in every
///      case except "null `handle`" itself, which has nothing to free
#[no_mangle]
pub unsafe extern "C" fn maple_fallback_id_hasher_finalize(
    handle: *mut MapleFallbackIdHasher,
    filesize: u64,
    out_hex: *mut u8,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let boxed = Box::from_raw(handle);
    if boxed.inner.is_null() {
        return -1;
    }
    let inner = Box::from_raw(boxed.inner as *mut raw_core::FallbackIdHasher);
    if out_hex.is_null() {
        // `inner` (and `boxed`) drop here regardless — the handle is
        // consumed even though this call reports failure.
        return -1;
    }
    let id = inner.finalize(filesize);
    let hex = id.to_hex();
    let hex_bytes = hex.as_bytes();
    std::ptr::copy_nonoverlapping(hex_bytes.as_ptr(), out_hex, 32);
    0
}

/// Abandon a streaming hash without finishing it — e.g. the caller cancelled
/// a chunked read partway through. Frees `handle` and its inner state. A
/// null pointer is a no-op (matches `maple_cancel_flag_free` /
/// `maple_close_raw_handle`'s null-is-noop convention).
#[no_mangle]
pub unsafe extern "C" fn maple_fallback_id_hasher_free(handle: *mut MapleFallbackIdHasher) {
    if handle.is_null() {
        return;
    }
    let boxed = Box::from_raw(handle);
    if !boxed.inner.is_null() {
        drop(Box::from_raw(
            boxed.inner as *mut raw_core::FallbackIdHasher,
        ));
    }
}
