//! Tests for the legacy 8-bit sRGB `maple_render_file` /
//! `maple_render_bytes` FFI entries. Fixture-gated (require
//! `test_0002.dng` to exist) — they skip cleanly when absent.

use crate::buffers::{maple_free_buffer, MapleImageBuffer};
use crate::error::maple_last_error;
use crate::render::{maple_compute_look_lut, maple_render_bytes, maple_render_file};
use std::ffi::{CStr, CString};

#[test]
fn render_default_model_via_ffi() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() { return; }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = MapleImageBuffer { rgb: std::ptr::null_mut(), len: 0, width: 0, height: 0 };
    let rc = unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), 0, &mut buf) };
    assert_eq!(rc, 0, "render rc = {}", rc);
    assert!(buf.width > 0 && buf.height > 0);
    assert_eq!(buf.len as u32, buf.width * buf.height * 3);
    unsafe { maple_free_buffer(&mut buf) };
    assert!(buf.rgb.is_null());
}

#[test]
fn render_bytes_via_ffi() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() { return; }
    let bytes = std::fs::read(&path).unwrap();
    let ext = CString::new("dng").unwrap();
    let mut buf = MapleImageBuffer { rgb: std::ptr::null_mut(), len: 0, width: 0, height: 0 };
    let rc = unsafe {
        maple_render_bytes(bytes.as_ptr(), bytes.len(), ext.as_ptr(),
                           std::ptr::null(), 0, &mut buf)
    };
    assert_eq!(rc, 0, "render_bytes rc = {}", rc);
    assert!(buf.width > 0 && buf.height > 0);
    assert_eq!(buf.len as u32, buf.width * buf.height * 3);
    unsafe { maple_free_buffer(&mut buf) };
    assert!(buf.rgb.is_null());
}

#[test]
fn null_arg_sets_error() {
    let mut buf = MapleImageBuffer { rgb: std::ptr::null_mut(), len: 0, width: 0, height: 0 };
    let rc = unsafe { maple_render_file(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
    assert_eq!(rc, 1);
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"));
}

// ---------------------------------------------------------------------------
// maple_compute_look_lut (#515) — FFI surface that seeds the Apple Metal +
// Web WebGL DisplayLookCurve LUT texture. These tests assert byte-for-byte
// agreement with the raw-core source of truth so the GPU path can never
// drift from the CPU `view::look::apply` path.
// ---------------------------------------------------------------------------

#[test]
fn look_lut_default_matches_raw_core_bytes() {
    let mut buf = [0u8; 768];
    let rc = unsafe { maple_compute_look_lut(1, buf.as_mut_ptr()) };
    assert_eq!(rc, 0);
    assert_eq!(&buf[0..256], &raw_core::view::look::LUT_R);
    assert_eq!(&buf[256..512], &raw_core::view::look::LUT_G);
    assert_eq!(&buf[512..768], &raw_core::view::look::LUT_B);
}

#[test]
fn look_lut_neutral_is_identity() {
    let mut buf = [0u8; 768];
    let rc = unsafe { maple_compute_look_lut(0, buf.as_mut_ptr()) };
    assert_eq!(rc, 0);
    for c in 0..3 {
        for i in 0..256 {
            assert_eq!(
                buf[c * 256 + i],
                i as u8,
                "Neutral LUT must be identity at channel {c} index {i}"
            );
        }
    }
}

#[test]
fn look_lut_null_pointer_returns_error() {
    let rc = unsafe { maple_compute_look_lut(1, std::ptr::null_mut()) };
    assert_eq!(rc, -1);
}

#[test]
fn look_lut_unknown_mode_returns_error() {
    let mut buf = [0u8; 768];
    let rc = unsafe { maple_compute_look_lut(99, buf.as_mut_ptr()) };
    assert_eq!(rc, -1);
    // Error path must NOT mutate the output buffer — the caller may use
    // a stale LUT in that case and we don't want a half-written one.
    assert!(buf.iter().all(|&b| b == 0));
}
