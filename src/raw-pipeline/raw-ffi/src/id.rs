//! Hashing + maple_id FFI entries — `maple_blake3_hex`,
//! `maple_id_primary`, `maple_id_fallback`. Pure functions over byte
//! slices; no rawler, no allocator dance, no thread-local error state.

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
    if bytes_ptr.is_null() || out_hex.is_null() { return -1; }
    if bytes_len == 0 { return -2; }
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
    let captured_at_bytes = unsafe {
        std::slice::from_raw_parts(captured_at_ptr, captured_at_len)
    };
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
    if bytes_ptr.is_null() || out_hex.is_null() { return -1; }
    if bytes_len == 0 { return -2; }
    let bytes = unsafe { std::slice::from_raw_parts(bytes_ptr, bytes_len) };
    let id = raw_core::MapleId::fallback(bytes, filesize);
    let hex = id.to_hex();
    let hex_bytes = hex.as_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(hex_bytes.as_ptr(), out_hex, 32);
    }
    0
}
