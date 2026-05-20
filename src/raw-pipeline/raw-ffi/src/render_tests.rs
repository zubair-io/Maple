//! Tests for the legacy 8-bit sRGB `maple_render_file` /
//! `maple_render_bytes` FFI entries. Fixture-gated (require
//! `test_0002.dng` to exist) — they skip cleanly when absent.

use crate::buffers::{maple_free_buffer, MapleImageBuffer};
use crate::error::maple_last_error;
use crate::render::{maple_render_bytes, maple_render_file};
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
