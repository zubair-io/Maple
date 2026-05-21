//! Tests for the embedded-JPEG thumbnail fast-path
//! (`maple_render_thumbnail_jpeg` / `maple_render_thumbnail_jpeg_to_file`).
//!
//! The fast-path extracts a multi-MP JPEG preview that every modern RAW
//! container embeds, then resizes + re-encodes it as JPEG — bypassing
//! the full decode → pipeline → downsample chain. The Bun API exercises
//! this indirectly via its thumbnail route integration tests; this file
//! adds a Rust-side gate so a regression in rawler-slot selection,
//! resize, or encode is caught without booting the full API stack.
//!
//! Mix of:
//!   - synth-generated tests (always run; cover error paths)
//!   - fixture-gated tests (skip-pass when `test-fixtures/raws/` is empty;
//!     cover the happy path against a real DNG that ships an embedded JPEG).

use crate::buffers::{maple_free_byte_buffer, MapleByteBuffer};
use crate::error::maple_last_error;
use crate::thumbnail::{maple_render_thumbnail_jpeg, maple_render_thumbnail_jpeg_to_file};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use std::ffi::{CStr, CString};

/// JPEG Start-Of-Image marker — every JPEG begins with these three bytes.
const JPEG_SOI: [u8; 3] = [0xFF, 0xD8, 0xFF];

fn empty_byte_buf() -> MapleByteBuffer {
    MapleByteBuffer { bytes: std::ptr::null_mut(), len: 0 }
}

fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng")
}

// ─── No-fixture tests (always run) ──────────────────────────────────────────

/// `maple_render_thumbnail_jpeg` with null `raw_path` returns rc=1 and
/// sets `LAST_ERROR` to a "null" message. Does not crash.
#[test]
fn render_thumbnail_jpeg_null_raw_path_returns_rc1() {
    let mut out = empty_byte_buf();
    let rc = unsafe {
        maple_render_thumbnail_jpeg(std::ptr::null(), 512, 0, &mut out)
    };
    assert_eq!(rc, 1);
    assert!(out.bytes.is_null());
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"), "expected null-ptr msg, got: {}", msg);
}

/// `maple_render_thumbnail_jpeg` with null `out` returns rc=1.
#[test]
fn render_thumbnail_jpeg_null_out_returns_rc1() {
    let path = CString::new("/tmp/does-not-matter").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg(path.as_ptr(), 512, 0, std::ptr::null_mut())
    };
    assert_eq!(rc, 1);
}

/// `maple_render_thumbnail_jpeg_to_file` with null pointers returns rc=1.
#[test]
fn render_thumbnail_to_file_null_args_return_rc1() {
    let some_path = CString::new("/tmp/does-not-matter").unwrap();
    let rc1 = unsafe {
        maple_render_thumbnail_jpeg_to_file(std::ptr::null(), some_path.as_ptr(), 512, 0)
    };
    assert_eq!(rc1, 1);
    let rc2 = unsafe {
        maple_render_thumbnail_jpeg_to_file(some_path.as_ptr(), std::ptr::null(), 512, 0)
    };
    assert_eq!(rc2, 1);
}

/// `max_px == 0` returns rc=9 — guarded before any I/O so the path
/// doesn't need to exist.
#[test]
fn render_thumbnail_jpeg_zero_max_px_returns_rc9() {
    let path = CString::new("/tmp/does-not-matter").unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe { maple_render_thumbnail_jpeg(path.as_ptr(), 0, 0, &mut out) };
    assert_eq!(rc, 9);
}

/// `max_px == 0` returns rc=9 for the file variant too.
#[test]
fn render_thumbnail_to_file_zero_max_px_returns_rc9() {
    let raw = CString::new("/tmp/in.dng").unwrap();
    let out = CString::new("/tmp/out.jpg").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg_to_file(raw.as_ptr(), out.as_ptr(), 0, 0)
    };
    assert_eq!(rc, 9);
}

/// Bad path (file does not exist) returns rc=6 ("raw read" error).
#[test]
fn render_thumbnail_jpeg_missing_file_returns_rc6() {
    let path = CString::new("/tmp/maple-ffi-no-such-file-xyz.dng").unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe { maple_render_thumbnail_jpeg(path.as_ptr(), 512, 0, &mut out) };
    assert_eq!(rc, 6, "expected rc=6 for missing file, got {}", rc);
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("raw read"), "got: {}", msg);
}

/// Bad path (file does not exist) returns rc=6 for the file variant.
#[test]
fn render_thumbnail_to_file_missing_input_returns_rc6() {
    let raw = CString::new("/tmp/maple-ffi-no-such-file-xyz.dng").unwrap();
    let out_dir = tempfile::tempdir().unwrap();
    let out_path = out_dir.path().join("thumb.jpg");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg_to_file(raw.as_ptr(), out_cstr.as_ptr(), 512, 0)
    };
    assert_eq!(rc, 6);
    assert!(!out_path.exists(), "output must not be created on rc=6");
}

/// Synthetic DNG has no embedded JPEG preview / SubIFD / thumbnail —
/// `extract_embedded_preview` exhausts all three rawler slots and the
/// FFI returns rc=8 ("no embedded preview"). Also asserts the error
/// message is set so the caller can surface it.
#[test]
fn render_thumbnail_jpeg_synth_dng_no_preview_returns_rc8() {
    let dir = tempfile::tempdir().unwrap();
    let dng_path = dir.path().join("synth-no-preview.dng");
    SyntheticGreyDng::default().write_to(&dng_path).unwrap();
    let raw_cstr = CString::new(dng_path.to_str().unwrap()).unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), 512, 0, &mut out)
    };
    assert_eq!(rc, 8, "synth DNG should hit rc=8, got {}", rc);
    assert!(out.bytes.is_null());
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
}

/// Same coverage for the file-output variant — synth DNG → rc=8, and
/// crucially no output file is created (the encode never ran).
#[test]
fn render_thumbnail_to_file_synth_dng_no_preview_returns_rc8() {
    let dir = tempfile::tempdir().unwrap();
    let dng_path = dir.path().join("synth-no-preview.dng");
    SyntheticGreyDng::default().write_to(&dng_path).unwrap();
    let out_path = dir.path().join("thumb.jpg");
    let raw_cstr = CString::new(dng_path.to_str().unwrap()).unwrap();
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), 512, 0)
    };
    assert_eq!(rc, 8);
    assert!(!out_path.exists(), "must not write output on extract failure");
    let tmp_path = out_path.with_extension("jpg.tmp");
    assert!(!tmp_path.exists(), "must not leak .tmp on extract failure");
}

/// Pass a path that exists but contains garbage bytes — rawler's
/// `get_decoder` fails to identify the format, which falls through the
/// `try_slot` chain to the "no embedded preview" branch and returns
/// rc=8. (Verifies the panic-catch + error-mapping path doesn't trip.)
#[test]
fn render_thumbnail_jpeg_garbage_bytes_returns_rc8() {
    let dir = tempfile::tempdir().unwrap();
    let raw_path = dir.path().join("garbage.dng");
    std::fs::write(&raw_path, b"not a real raw file, just some bytes").unwrap();
    let raw_cstr = CString::new(raw_path.to_str().unwrap()).unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), 256, 0, &mut out)
    };
    assert_eq!(rc, 8, "garbage bytes should fall through to rc=8, got {}", rc);
    assert!(out.bytes.is_null());
}

// ─── Fixture-gated tests (skip-pass when fixtures absent) ───────────────────

/// Happy path: real DNG with an embedded preview → rc=0, non-empty JPEG
/// buffer whose first three bytes are the JPEG SOI marker. The output's
/// long edge must be `<= max_px` (resize never upscales). Frees via
/// `maple_free_byte_buffer` and asserts the buffer is zeroed afterwards.
#[test]
fn render_thumbnail_jpeg_fixture_round_trip() {
    let path = fixture_path();
    if !path.exists() { return; }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut out = empty_byte_buf();
    let max_px: u32 = 512;
    let rc = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), max_px, 0, &mut out)
    };
    assert_eq!(rc, 0, "thumbnail rc = {}", rc);
    assert!(!out.bytes.is_null());
    assert!(out.len > 3, "JPEG should be longer than the SOI marker");
    let bytes = unsafe { std::slice::from_raw_parts(out.bytes, out.len) };
    assert_eq!(&bytes[..3], &JPEG_SOI, "missing JPEG SOI marker");

    // Decode to verify dimensions are within the max_px ceiling.
    let decoded = image::load_from_memory(bytes).expect("decodable JPEG");
    use image::GenericImageView;
    let (w, h) = decoded.dimensions();
    assert!(w > 0 && h > 0);
    assert!(w.max(h) <= max_px,
        "long edge {} exceeds max_px={}", w.max(h), max_px);

    // Free via the FFI free fn — must zero out the buffer.
    unsafe { maple_free_byte_buffer(&mut out) };
    assert!(out.bytes.is_null());
    assert_eq!(out.len, 0);
}

/// The bytes-variant and the path-variant must produce equivalent
/// output for the same inputs. They share `extract_embedded_preview` +
/// `resize_long_edge` + `raw_core::jpeg::encode` so the encoded bytes
/// are byte-for-byte equal.
#[test]
fn render_thumbnail_bytes_and_file_parity() {
    let path = fixture_path();
    if !path.exists() { return; }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let max_px: u32 = 384;
    let quality: u8 = 75;

    // Bytes variant.
    let mut out = empty_byte_buf();
    let rc_bytes = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), max_px, quality, &mut out)
    };
    assert_eq!(rc_bytes, 0);
    let bytes_jpeg = unsafe {
        std::slice::from_raw_parts(out.bytes, out.len).to_vec()
    };

    // File variant.
    let dir = tempfile::tempdir().unwrap();
    let out_path = dir.path().join("thumb.jpg");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc_file = unsafe {
        maple_render_thumbnail_jpeg_to_file(
            raw_cstr.as_ptr(), out_cstr.as_ptr(), max_px, quality,
        )
    };
    assert_eq!(rc_file, 0);
    assert!(out_path.exists(), "output file must exist after rc=0");
    let file_jpeg = std::fs::read(&out_path).unwrap();

    assert_eq!(bytes_jpeg, file_jpeg, "bytes-variant and file-variant must agree");
    // No .tmp left behind after a successful rename.
    let tmp_path = out_path.with_extension("jpg.tmp");
    assert!(!tmp_path.exists(), ".tmp must be removed on rename success");

    unsafe { maple_free_byte_buffer(&mut out) };
}

/// Calling `maple_free_byte_buffer` twice on the same buffer is a
/// no-op the second time — the free fn zeroes the struct, so the
/// second call sees a null `bytes` and returns without touching memory.
/// Guards against the double-free that motivated the file-output
/// variant in the first place.
#[test]
fn free_byte_buffer_is_idempotent_after_zeroing() {
    let path = fixture_path();
    if !path.exists() { return; }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), 256, 0, &mut out)
    };
    assert_eq!(rc, 0);
    unsafe { maple_free_byte_buffer(&mut out) };
    assert!(out.bytes.is_null());
    // Second free must be a no-op (no double-free, no crash).
    unsafe { maple_free_byte_buffer(&mut out) };
    assert!(out.bytes.is_null());
    assert_eq!(out.len, 0);
}

/// `quality == 0` selects the spec-pinned default of 82. Compare a
/// `quality=0` render against a `quality=82` render — same bytes.
#[test]
fn render_thumbnail_jpeg_quality_zero_uses_default() {
    let path = fixture_path();
    if !path.exists() { return; }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();

    let mut buf_default = empty_byte_buf();
    let rc1 = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), 256, 0, &mut buf_default)
    };
    assert_eq!(rc1, 0);

    let mut buf_explicit = empty_byte_buf();
    let rc2 = unsafe {
        maple_render_thumbnail_jpeg(raw_cstr.as_ptr(), 256, 82, &mut buf_explicit)
    };
    assert_eq!(rc2, 0);

    let a = unsafe { std::slice::from_raw_parts(buf_default.bytes, buf_default.len) };
    let b = unsafe { std::slice::from_raw_parts(buf_explicit.bytes, buf_explicit.len) };
    assert_eq!(a, b, "quality=0 must equal quality=82");

    unsafe {
        maple_free_byte_buffer(&mut buf_default);
        maple_free_byte_buffer(&mut buf_explicit);
    }
}

#[test]
fn jpeg_quality_above_100_returns_rc_14() {
    let path = CString::new("/dev/null").unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe { maple_render_thumbnail_jpeg(path.as_ptr(), 512, 200, &mut out) };
    assert_eq!(rc, 14, "quality=200 should be rejected at validation");
}

#[test]
fn jpeg_quality_255_returns_rc_14() {
    let path = CString::new("/dev/null").unwrap();
    let mut out = empty_byte_buf();
    let rc = unsafe { maple_render_thumbnail_jpeg(path.as_ptr(), 512, 255, &mut out) };
    assert_eq!(rc, 14);
}

#[test]
fn jpeg_to_file_quality_above_100_returns_rc_14() {
    let raw_path = CString::new("/dev/null").unwrap();
    let out_path = CString::new("/tmp/maple_test.jpg").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg_to_file(raw_path.as_ptr(), out_path.as_ptr(), 512, 200)
    };
    assert_eq!(rc, 14, "quality=200 should be rejected at validation");
}

#[test]
fn jpeg_to_file_quality_255_returns_rc_14() {
    let raw_path = CString::new("/dev/null").unwrap();
    let out_path = CString::new("/tmp/maple_test.jpg").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_jpeg_to_file(raw_path.as_ptr(), out_path.as_ptr(), 512, 255)
    };
    assert_eq!(rc, 14);
}
