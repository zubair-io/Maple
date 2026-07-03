//! Tests for the scene-linear fp16 RGBA FFI entries (simple, sized,
//! and tile variants) plus the strip-related cross-language sanity
//! check that proves Swift's `XMPSerializer` output round-trips
//! through Rust's `xmp::parse` to the same model.
//!
//! Most cases are fixture-gated on `test_0002.dng`; the null-arg /
//! geometry checks fire before any I/O and run unconditionally.

use crate::buffers::{maple_free_scene_linear_buffer, MapleSceneLinearBuffer};
use crate::error::maple_last_error;
use crate::scene_linear::{
    maple_render_bytes_scene_linear_tile, maple_render_file_scene_linear,
    maple_render_file_scene_linear_sized, maple_render_file_scene_linear_tile,
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

#[test]
fn render_scene_linear_default_model_via_ffi() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    let rc =
        unsafe { maple_render_file_scene_linear(raw_cstr.as_ptr(), std::ptr::null(), 1, &mut buf) };
    assert_eq!(rc, 0, "render rc = {}", rc);
    assert!(buf.width > 0 && buf.height > 0);
    assert_eq!(buf.channels, 4);
    assert_eq!(buf.bytes_per_pixel, 8);
    assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
    unsafe { maple_free_scene_linear_buffer(&mut buf) };
    assert!(buf.fp16_rgba.is_null());
}

#[test]
fn scene_linear_null_arg_sets_error() {
    let mut buf = empty_buf();
    let rc =
        unsafe { maple_render_file_scene_linear(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
    assert_eq!(rc, 1);
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"));
}

#[test]
fn render_scene_linear_sized_via_ffi_caps_long_edge() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    let max_long_edge: u32 = 800;
    let rc = unsafe {
        maple_render_file_scene_linear_sized(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            max_long_edge,
            1,
            &mut buf,
        )
    };
    assert_eq!(rc, 0, "render rc = {}", rc);
    assert!(
        buf.width.max(buf.height) <= max_long_edge,
        "size cap not respected: {}x{}",
        buf.width,
        buf.height
    );
    assert_eq!(buf.bytes_per_pixel, 8);
    assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
    unsafe { maple_free_scene_linear_buffer(&mut buf) };
    assert!(buf.fp16_rgba.is_null());
}

#[test]
fn sized_zero_long_edge_sets_error() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_file_scene_linear_sized(raw_cstr.as_ptr(), std::ptr::null(), 0, 1, &mut buf)
    };
    assert_eq!(rc, 9);
}

// -----------------------------------------------------------------
// Tile FFI entry tests (Plan deep-zoom-tile-rendering Task 2).
// -----------------------------------------------------------------

/// Null pointer to `maple_render_file_scene_linear_tile` returns 1
/// (no fixture required — null check fires before any I/O).
#[test]
fn tile_null_arg_sets_error() {
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            std::ptr::null(),
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
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"));
}

/// Zero-dimensioned src/out arguments return 9. We need a non-null
/// pointer for the path so the null check passes; the bad-geometry
/// check fires before the path is read.
#[test]
fn tile_zero_dim_sets_error() {
    let dummy = CString::new("/dev/null").unwrap();
    let mut buf = empty_buf();
    // src_w == 0
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            dummy.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            512,
            256,
            256,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 9, "src_w=0 should be rc=9, got {}", rc);
    // out_h == 0
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            dummy.as_ptr(),
            std::ptr::null(),
            0,
            0,
            512,
            512,
            256,
            0,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 9, "out_h=0 should be rc=9, got {}", rc);
}

/// Bytes-variant null pointer returns 1.
#[test]
fn tile_bytes_null_arg_sets_error() {
    let mut buf = empty_buf();
    let ext = CString::new("dng").unwrap();
    let rc = unsafe {
        maple_render_bytes_scene_linear_tile(
            std::ptr::null(),
            0,
            ext.as_ptr(),
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

/// File-path tile render with default model returns a 256×256 fp16
/// RGBA buffer with alpha = 1.0 in every pixel and the documented
/// channel/bytes-per-pixel layout. Fixture-gated.
#[test]
fn render_tile_default_model_via_ffi() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            1024,
            1024,
            512,
            512,
            256,
            256,
            /* quality_preview = */ 0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 0, "tile render rc = {}", rc);
    assert_eq!(buf.width, 256);
    assert_eq!(buf.height, 256);
    assert_eq!(buf.channels, 4);
    assert_eq!(buf.bytes_per_pixel, 8);
    assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
    // Verify alpha lane is fp16 1.0 (= 0x3c00) for every pixel.
    let n_lanes = buf.len_bytes / std::mem::size_of::<u16>();
    let lanes = unsafe { std::slice::from_raw_parts(buf.fp16_rgba, n_lanes) };
    let alpha_ok = lanes.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
    assert_eq!(
        alpha_ok,
        (buf.width * buf.height) as usize,
        "all alpha lanes must be fp16 1.0"
    );
    unsafe { maple_free_scene_linear_buffer(&mut buf) };
    assert!(buf.fp16_rgba.is_null());
}

/// Bytes-variant tile render with default model — same shape checks
/// as the file-path test. Fixture-gated.
#[test]
fn render_tile_default_model_via_bytes_ffi() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let bytes = std::fs::read(&path).unwrap();
    let ext = CString::new("dng").unwrap();
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_bytes_scene_linear_tile(
            bytes.as_ptr(),
            bytes.len(),
            ext.as_ptr(),
            std::ptr::null(),
            1024,
            1024,
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
    assert_eq!(rc, 0, "tile bytes render rc = {}", rc);
    assert_eq!(buf.width, 256);
    assert_eq!(buf.height, 256);
    assert_eq!(buf.channels, 4);
    assert_eq!(buf.bytes_per_pixel, 8);
    assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
    unsafe { maple_free_scene_linear_buffer(&mut buf) };
    assert!(buf.fp16_rgba.is_null());
}

/// Tile FFI rejects active dehaze with rc=10. Fixture-gated because
/// the rejection happens after rawler decodes the RAW (the dehaze
/// gate lives in `render_scene_linear_tile_from_raw_with_quality`).
#[test]
fn render_tile_dehaze_active_returns_error_code_10() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    // Synthesize an XMP file with dehaze=50.
    let xmp_path = std::env::temp_dir().join("tile-dehaze-ffi.xmp");
    std::fs::write(
        &xmp_path,
        r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
    ).unwrap();
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            raw_cstr.as_ptr(),
            xmp_cstr.as_ptr(),
            1024,
            1024,
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
    assert_eq!(rc, 10, "expected dehaze-unsupported rc=10, got {}", rc);
    unsafe { maple_free_scene_linear_buffer(&mut buf) };
    let _ = std::fs::remove_file(&xmp_path);
}

/// Tile FFI rejects out > src (upscale) with rc=11. Fixture-gated
/// because the upscale gate runs inside the post-decode core call.
#[test]
fn render_tile_upscale_returns_error_code_11() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    // out_w > src_w
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            1024,
            1024,
            256,
            256,
            512,
            256,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
    // out_h > src_h
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            1024,
            1024,
            256,
            256,
            256,
            512,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 11, "out_h>src_h must rc=11, got {}", rc);
}

/// Tile FFI rejects mismatched aspect (`out_w/out_h` ≠ `src_w/src_h`)
/// with rc=12. Fixture-gated — the aspect gate lives inside the
/// post-decode core call.
#[test]
fn render_tile_mismatched_aspect_returns_error_code_12() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let mut buf = empty_buf();
    // src 512×512 (1:1), out 512×256 (2:1) — strict aspect mismatch.
    let rc = unsafe {
        maple_render_file_scene_linear_tile(
            raw_cstr.as_ptr(),
            std::ptr::null(),
            1024,
            1024,
            512,
            512,
            512,
            256,
            0,
            0.0,
            0.0,
            &mut buf,
        )
    };
    assert_eq!(rc, 12, "mismatched aspect must rc=12, got {}", rc);
}

// -----------------------------------------------------------------
// Cross-language strip round-trip (ticket #124 follow-up).
//
// The Apple Swift binding (RawCoreBridge.withStrippedXMP) writes a
// temp XMP using Swift's XMPSerializer and hands the path to the
// raw-ffi scene-linear entries. Rust's xmp::parse must reconstruct
// the same model — otherwise the strip is silently lossy on fields
// the strip deliberately KEPT (highlight_recovery / sharpen_radius /
// sharpen_detail / sharpen_masking).
//
// This test pins the agreement directly: hardcode a Swift-shaped XMP
// the bridge would produce, parse it via raw-core, assert the model
// matches the expected stripped values byte-for-byte.
// -----------------------------------------------------------------

/// Reproduces what `RawCoreBridge.withStrippedXMP` writes when the
/// upstream sidecar carries non-default sharpen + highlight-recovery
/// values: every "GPU re-applied" field zero'd, every "kept" field
/// preserved. The string format mirrors `XMPSerializer.serialize`
/// at `AdjustmentModel.swift` byte-for-byte.
const SWIFT_STRIPPED_XMP: &str = r#"<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Temperature="6500"
      crs:Tint="0"
      crs:Exposure2012="0.00"
      crs:Contrast2012="0"
      crs:Highlights2012="0"
      crs:Shadows2012="0"
      crs:Whites2012="0"
      crs:Blacks2012="0"
      crs:Vibrance="0"
      crs:Saturation="0"
      crs:Clarity2012="0"
      crs:Texture="0"
      crs:Dehaze="0"
      crs:Sharpness="45"
      crs:SharpenRadius="1.5"
      crs:SharpenDetail="60"
      crs:SharpenEdgeMasking="20"
      papp:CaptureSharpeningAmount="55"
      papp:CaptureSharpeningRadius="1.5"
      crs:LuminanceSmoothing="0"
      crs:ColorNoiseReduction="25"
      xmp:Rating="0"
      papp:HighlightRecoveryMode="Blend"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

#[test]
fn swift_stripped_xmp_round_trips_to_rust_model() {
    let model =
        raw_core::xmp::parse(SWIFT_STRIPPED_XMP).expect("Swift-shaped XMP must parse in raw-core");

    // GPU-replayed fields — must all be zero (strip target).
    assert_eq!(model.temperature, 6500.0);
    assert_eq!(model.tint, 0.0);
    assert_eq!(model.exposure, 0.0);
    assert_eq!(model.contrast, 0.0);
    assert_eq!(model.highlights, 0.0);
    assert_eq!(model.shadows, 0.0);
    assert_eq!(model.whites, 0.0);
    assert_eq!(model.blacks, 0.0);
    assert_eq!(model.vibrance, 0.0);
    assert_eq!(model.saturation, 0.0);
    assert_eq!(model.clarity, 0.0);
    assert_eq!(model.texture, 0.0);
    assert_eq!(model.dehaze, 0.0);
    assert_eq!(model.nr_luminance, 0.0);
    // sharpen_amount is stripped; the Swift default is 45 (capture
    // sharpening), which is the value the stripped XMP carries.
    assert_eq!(model.sharpen_amount, 45.0);
    // nr_color stripped — Swift default is 25.
    assert_eq!(model.nr_color, 25.0);

    // KEPT fields — the strip leaves these alone, so they appear in
    // the temp XMP with the user's original values and must survive
    // the Rust parse byte-for-byte (or the strip is silently lossy).
    assert_eq!(model.sharpen_radius, 1.5);
    assert_eq!(model.sharpen_detail, 60.0);
    assert_eq!(model.sharpen_masking, 20.0);
    // Capture sharpening (#271) runs inside the Rust decode and has no
    // Apple Metal equivalent — kept by the strip and must round-trip.
    // The XMP sidecar in this test carries the legacy
    // `papp:CaptureSharpeningRadius` attribute (#456: PR #452 swapped the
    // PSF for a true Gaussian; the read-path now routes the legacy key
    // into `capture_sharpening_sigma` unchanged).
    assert_eq!(model.capture_sharpening_amount, 55.0);
    assert_eq!(model.capture_sharpening_sigma, 1.5);
    assert_eq!(
        model.highlight_recovery,
        raw_core::xmp::HighlightRecoveryMode::Blend,
        "papp:HighlightRecoveryMode must parse to Blend, not Off"
    );
}
