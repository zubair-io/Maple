//! Tests for the legacy 8-bit sRGB `maple_render_file` /
//! `maple_render_bytes` FFI entries. Fixture-gated (require
//! `test_0002.dng` to exist) — they skip cleanly when absent.

use crate::buffers::{maple_free_buffer, MapleImageBuffer};
use crate::error::maple_last_error;
use crate::render::{
    maple_compute_look_lut, maple_compute_profile_curve, maple_compute_profile_lut,
    maple_render_bytes, maple_render_file,
};
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

// ---------------------------------------------------------------------------
// maple_compute_profile_lut (#817) — bakes the per-image Auto Profile curve
// into a display-space 3D LUT for the Apple Metal (#812) + Web WebGL2 (#394)
// samplers. The FFI delegates to `raw_core::view::auto_profile::bake_profile_lut`
// so the GPU path can never drift from the CPU `apply_curve`.
// ---------------------------------------------------------------------------

/// Distinct per-channel monotone curve — same construction as the raw-core
/// golden test, kept in sync here so the FFI byte-identity assertion exercises
/// a non-trivial LUT.
fn ffi_test_curve() -> raw_core::view::auto_profile::ProfileCurve {
    use raw_core::view::auto_profile::{ChannelCurve, ProfileCurve};
    let mut c = ProfileCurve::identity();
    let shape = |i: usize, exp: f32, lift: f32| {
        let x = i as f32 / 31.0;
        let y = lift + (1.0 - lift) * x.powf(exp);
        (x, y.clamp(0.0, 1.0))
    };
    let mut r = ChannelCurve::identity();
    let mut g = ChannelCurve::identity();
    let mut b = ChannelCurve::identity();
    for i in 0..32 {
        r.anchors[i] = shape(i, 0.7, 0.05);
        g.anchors[i] = shape(i, 1.0, 0.0);
        b.anchors[i] = shape(i, 1.4, 0.0);
    }
    c.r = r;
    c.g = g;
    c.b = b;
    c
}

/// Byte-identity: the FFI LUT MUST equal `bake_profile_lut` (the core fn the
/// WASM binding also calls), so all three platforms get identical bytes by
/// construction. The WASM crate can't be linked into a raw-ffi test, so we
/// assert it transitively — FFI == core, and (in raw-wasm) WASM == core.
#[test]
fn profile_lut_matches_raw_core_bake() {
    use raw_core::view::auto_profile::{bake_profile_lut, DEFAULT_LUT_SIZE};
    let curve = ffi_test_curve();
    let flat = curve.to_flat();
    let n = DEFAULT_LUT_SIZE;
    let mut out = vec![0.0f32; n * n * n * 3];
    let rc = unsafe {
        maple_compute_profile_lut(flat.as_ptr(), flat.len(), n as u32, out.as_mut_ptr())
    };
    assert_eq!(rc, 0, "profile lut rc = {rc}");
    let expected = bake_profile_lut(&curve, n);
    assert_eq!(out, expected, "FFI LUT must be byte-identical to core bake");
}

#[test]
fn profile_lut_null_pointer_returns_error() {
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
    let flat = vec![0.0f32; PROFILE_CURVE_FLAT_LEN];
    let mut out = vec![0.0f32; 2 * 2 * 2 * 3];
    // Null curve.
    let rc = unsafe { maple_compute_profile_lut(std::ptr::null(), flat.len(), 2, out.as_mut_ptr()) };
    assert_eq!(rc, -1);
    // Null out.
    let rc = unsafe { maple_compute_profile_lut(flat.as_ptr(), flat.len(), 2, std::ptr::null_mut()) };
    assert_eq!(rc, -1);
}

#[test]
fn profile_lut_wrong_curve_len_returns_error() {
    let flat = [0.0f32; 4]; // not PROFILE_CURVE_FLAT_LEN
    let mut out = vec![0.0f32; 2 * 2 * 2 * 3];
    let rc = unsafe { maple_compute_profile_lut(flat.as_ptr(), flat.len(), 2, out.as_mut_ptr()) };
    assert_eq!(rc, -1);
}

#[test]
fn profile_lut_degenerate_n_returns_error() {
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
    let flat = vec![0.0f32; PROFILE_CURVE_FLAT_LEN];
    let mut out = vec![0.0f32; 3];
    let rc = unsafe { maple_compute_profile_lut(flat.as_ptr(), flat.len(), 1, out.as_mut_ptr()) };
    assert_eq!(rc, -1);
}

#[test]
fn profile_lut_oversized_n_returns_error() {
    use raw_core::view::auto_profile::{MAX_LUT_SIZE, PROFILE_CURVE_FLAT_LEN};
    let flat = vec![0.0f32; PROFILE_CURVE_FLAT_LEN];
    // Tiny out buffer: the guard must reject `n > MAX_LUT_SIZE` before any
    // bake / copy, so `out` is never touched.
    let mut out = vec![0.0f32; 3];
    let n = (MAX_LUT_SIZE + 1) as u32;
    let rc = unsafe { maple_compute_profile_lut(flat.as_ptr(), flat.len(), n, out.as_mut_ptr()) };
    assert_eq!(rc, -1);
}

// ---------------------------------------------------------------------------
// maple_compute_profile_curve (#812) — surfaces the FITTED Auto Profile curve
// across FFI (the gap #840 flagged). The Apple Metal host calls this once per
// image, then feeds the result into `maple_compute_profile_lut` to bake the
// GPU 3D LUT. The curve MUST match what `fit_profile_curve_from_raw` — the
// core fn the CPU render path also uses — produces, or the GPU Auto render
// drifts from the CPU/CLI render.
// ---------------------------------------------------------------------------

#[test]
fn profile_curve_null_pointer_returns_error() {
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
    let mut out = vec![0.0f32; PROFILE_CURVE_FLAT_LEN];
    // Null raw_path.
    let rc = unsafe { maple_compute_profile_curve(std::ptr::null(), std::ptr::null(), 0, out.as_mut_ptr()) };
    assert_eq!(rc, -1);
    // Null out.
    let raw_cstr = CString::new("/nonexistent.dng").unwrap();
    let rc = unsafe { maple_compute_profile_curve(raw_cstr.as_ptr(), std::ptr::null(), 0, std::ptr::null_mut()) };
    assert_eq!(rc, -1);
}

/// Auto Profile is the default model, so the fixture render (no XMP) fits a
/// curve. The FFI result MUST equal `fit_profile_curve_from_raw` (the shared
/// core entry the CPU `render_from_raw` Auto path also drives) — the tight
/// gate that keeps the Apple GPU Auto render from drifting off the CPU/CLI
/// reference. Skips cleanly when the fixture is absent.
#[test]
fn profile_curve_matches_core_fit() {
    use raw_core::pipeline::{fit_profile_curve_from_raw, RawInput, RenderQuality};
    use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() { return; }

    // Core reference (shares the LRU cache with the FFI call below; identical
    // either way — the cache returns the same fitted curve).
    let bytes = std::fs::read(&path).unwrap();
    let raw_img = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let model = raw_core::xmp::AdjustmentModel::default();
    let core_curve = fit_profile_curve_from_raw(
        &raw_img, &model, RenderQuality::Full, RawInput::Path(&path),
    );

    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut out = vec![0.0f32; PROFILE_CURVE_FLAT_LEN];
    let rc = unsafe {
        maple_compute_profile_curve(raw_cstr.as_ptr(), std::ptr::null(), 0, out.as_mut_ptr())
    };

    match core_curve {
        Some(c) => {
            assert_eq!(rc, 0, "expected fitted curve (rc=0), got {rc}");
            let expected = c.to_flat();
            assert_eq!(out, expected, "FFI curve must equal the core fit");
        }
        None => {
            // No embedded JPEG / degenerate fit on this fixture — the host
            // falls back to AgX. The FFI must report rc=1, not write `out`.
            assert_eq!(rc, 1, "expected no-curve fallback (rc=1), got {rc}");
        }
    }
}
