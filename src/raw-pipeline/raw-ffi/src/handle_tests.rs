//! Tests for the `MapleRawHandle` opaque-handle FFI entries
//! (Plan deep-zoom-tile-rendering Task 3).

use crate::buffers::{maple_free_scene_linear_buffer, MapleSceneLinearBuffer};
use crate::error::maple_last_error;
use crate::handle::{
    maple_close_raw_handle, maple_open_raw_handle, maple_open_raw_handle_bytes,
    maple_render_handle_scene_linear_tile, MapleRawHandle,
};
use std::ffi::{CStr, CString};

fn empty_buf() -> MapleSceneLinearBuffer {
    MapleSceneLinearBuffer {
        fp16_rgba: std::ptr::null_mut(),
        len_bytes: 0,
        channels: 0,
        bytes_per_pixel: 0,
        width: 0,
        height: 0,
    }
}

/// Null pointer to `maple_open_raw_handle` returns 1; the out
/// pointer is initialized to null on error.
#[test]
fn open_raw_handle_null_arg_sets_error() {
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(std::ptr::null(), std::ptr::null(), &mut handle) };
    assert_eq!(rc, 1);
    assert!(handle.is_null());
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"));
}

/// Null handle to `maple_render_handle_scene_linear_tile` returns 1.
#[test]
fn render_handle_null_arg_sets_error() {
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            std::ptr::null(),
            0,
            0,
            512,
            512,
            256,
            256,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 1);
}

/// `maple_close_raw_handle(null)` is a no-op (no crash).
#[test]
fn close_raw_handle_null_is_noop() {
    unsafe { maple_close_raw_handle(std::ptr::null_mut()) };
}

/// Open a handle, render a tile, close. Verifies the round-trip
/// works end-to-end. Fixture-gated.
#[test]
fn raw_handle_round_trip_renders_tile() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle) };
    assert_eq!(rc, 0, "open rc = {}", rc);
    assert!(!handle.is_null());
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle, 1024, 1024, 512, 512, 256, 256, 0, 0.0, 0.0, &mut buf,
        )
    };
    assert_eq!(rc, 0, "render rc = {}", rc);
    assert_eq!(buf.width, 256);
    assert_eq!(buf.height, 256);
    assert_eq!(buf.channels, 4);
    assert_eq!(buf.bytes_per_pixel, 8);
    assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
    // Verify alpha lane is fp16 1.0 in every pixel.
    let n_lanes = buf.len_bytes / std::mem::size_of::<u16>();
    let lanes = unsafe { std::slice::from_raw_parts(buf.fp16_rgba, n_lanes) };
    let alpha_ok = lanes.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
    assert_eq!(alpha_ok, (buf.width * buf.height) as usize);
    unsafe {
        maple_free_scene_linear_buffer(&mut buf);
        maple_close_raw_handle(handle);
    }
}

/// Multiple tile renders against the same handle reuse the cached
/// decoded mosaic. Sanity check on the lifecycle: open once, render
/// 3 different tiles, close once.
#[test]
fn raw_handle_renders_multiple_tiles() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle) };
    assert_eq!(rc, 0);
    // Render three non-overlapping tiles.
    let coords: [(u32, u32); 3] = [(0, 0), (1024, 0), (0, 1024)];
    for (sx, sy) in coords.iter() {
        let mut buf = empty_buf();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, *sx, *sy, 512, 512, 256, 256, 0, 0.0, 0.0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "tile ({},{}) rc = {}", sx, sy, rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
    }
    unsafe { maple_close_raw_handle(handle) };
}

/// Handle opened with an XMP that sets dehaze != 0 propagates the
/// dehaze rejection (rc=10) on tile render — the model is locked
/// at handle-open time. Fixture-gated.
#[test]
fn raw_handle_with_dehaze_xmp_returns_rc10() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let xmp_path = std::env::temp_dir().join("handle-dehaze.xmp");
    std::fs::write(
        &xmp_path,
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
    ).unwrap();
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(raw_cstr.as_ptr(), xmp_cstr.as_ptr(), &mut handle) };
    assert_eq!(rc, 0, "open rc = {}", rc);
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle, 1024, 1024, 512, 512, 256, 256, 0, 0.0, 0.0, &mut buf,
        )
    };
    assert_eq!(rc, 10, "expected dehaze rc=10, got {}", rc);
    unsafe {
        maple_free_scene_linear_buffer(&mut buf);
        maple_close_raw_handle(handle);
    }
    let _ = std::fs::remove_file(&xmp_path);
}

/// Render handle rejects upscale (out > src) with rc=11.
#[test]
fn raw_handle_upscale_returns_rc11() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle) };
    assert_eq!(rc, 0);
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle, 1024, 1024, 256, 256, 512, 256, 0, 0.0, 0.0, &mut buf,
        )
    };
    assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
    unsafe { maple_close_raw_handle(handle) };
}

/// Render handle rejects mismatched aspect (out aspect ≠ src aspect)
/// with rc=12. Fixture-gated.
#[test]
fn raw_handle_mismatched_aspect_returns_rc12() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe { maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle) };
    assert_eq!(rc, 0);
    let mut buf = empty_buf();
    // src 512×512 (1:1), out 512×256 (2:1) — strict mismatch.
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle, 1024, 1024, 512, 512, 512, 256, 0, 0.0, 0.0, &mut buf,
        )
    };
    assert_eq!(rc, 12, "mismatched aspect must rc=12, got {}", rc);
    unsafe { maple_close_raw_handle(handle) };
}

/// Bytes-variant open + render + close round-trip. Fixture-gated.
#[test]
fn raw_handle_bytes_round_trip() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let bytes = std::fs::read(&path).unwrap();
    let ext = CString::new("dng").unwrap();
    let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
    let rc = unsafe {
        maple_open_raw_handle_bytes(
            bytes.as_ptr(),
            bytes.len(),
            ext.as_ptr(),
            std::ptr::null(),
            &mut handle,
        )
    };
    assert_eq!(rc, 0, "open_bytes rc = {}", rc);
    assert!(!handle.is_null());
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_handle_scene_linear_tile(
            handle, 1024, 1024, 512, 512, 256, 256, 0, 0.0, 0.0, &mut buf,
        )
    };
    assert_eq!(rc, 0);
    assert_eq!(buf.width, 256);
    assert_eq!(buf.height, 256);
    unsafe {
        maple_free_scene_linear_buffer(&mut buf);
        maple_close_raw_handle(handle);
    }
}
