//! Tests for the embedded-preview thumbnail fast-path's two sibling externs:
//! `maple_render_thumbnail_avif_to_file` (256px grid thumb) and
//! `maple_render_thumbnail_preview_jpeg_to_file` (1280px VLM describe
//! preview).
//!
//! The fast-path extracts a multi-MP JPEG preview that every modern RAW
//! container embeds, then resizes + re-encodes it — bypassing the full
//! decode → pipeline → downsample chain. The Bun API exercises this
//! indirectly via its thumbnail/preview route integration tests; this file
//! adds a Rust-side gate so a regression in rawler-slot selection, resize,
//! or either encode path is caught without booting the full API stack.
//!
//! Mix of:
//!   - synth-generated tests (always run; cover error paths)
//!   - fixture-gated tests (skip-pass when `test-fixtures/raws/` is empty;
//!     cover the happy path against a real DNG that ships an embedded JPEG).

use crate::error::maple_last_error;
use crate::thumbnail::{
    maple_render_thumbnail_avif_to_file, maple_render_thumbnail_preview_jpeg_to_file,
};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use std::ffi::{CStr, CString};

/// AVIF's ISOBMFF `ftyp` box tag — every AVIF file has this at byte offset 4.
const AVIF_FTYP: [u8; 4] = *b"ftyp";

fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng")
}

/// Read the encoded width/height straight out of an AVIF file's `ispe`
/// (ImageSpatialExtents) box, without a full AV1 decode — this crate only
/// enables the `image` crate's `avif` (encode) feature, deliberately not
/// `avif-native` (decode, which pulls in `dav1d` via a C toolchain build —
/// exactly the dependency-fragility risk this migration's pure-Rust encoder
/// choice avoids). Walks just enough of the ISOBMFF box tree
/// (`meta` → `iprp` → `ipco` → `ispe`) to find the primary item's
/// dimensions, which is all a single-image AVIF (the only kind
/// `raw_core::avif::encode` ever produces) needs. Cross-validated against a
/// known encode in `avif_dimensions_parser_matches_known_encode` below.
fn avif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // Returns (content_start, content_len) of the first child box named
    // `want`, both relative to `data`. `content_start` already points past
    // the 8-byte size+type header.
    fn find_box(data: &[u8], want: &[u8; 4]) -> Option<(usize, usize)> {
        let mut i = 0;
        while i + 8 <= data.len() {
            let size = u32::from_be_bytes(data[i..i + 4].try_into().ok()?) as usize;
            let kind = &data[i + 4..i + 8];
            if size < 8 || i + size > data.len() {
                return None;
            }
            if kind == want {
                return Some((i + 8, size - 8));
            }
            i += size;
        }
        None
    }

    let (meta_start, meta_len) = find_box(bytes, b"meta")?;
    // `meta` is a FullBox (1-byte version + 3-byte flags before children).
    let meta_body = bytes.get(meta_start + 4..meta_start + meta_len)?;
    let (iprp_start, iprp_len) = find_box(meta_body, b"iprp")?;
    let iprp_body = meta_body.get(iprp_start..iprp_start + iprp_len)?;
    let (ipco_start, ipco_len) = find_box(iprp_body, b"ipco")?;
    let ipco_body = iprp_body.get(ipco_start..ipco_start + ipco_len)?;
    let (ispe_start, _) = find_box(ipco_body, b"ispe")?;
    // `ispe` is a FullBox: 1-byte version + 3-byte flags, then width, height
    // (big-endian u32 each).
    let w = u32::from_be_bytes(
        ipco_body
            .get(ispe_start + 4..ispe_start + 8)?
            .try_into()
            .ok()?,
    );
    let h = u32::from_be_bytes(
        ipco_body
            .get(ispe_start + 8..ispe_start + 12)?
            .try_into()
            .ok()?,
    );
    Some((w, h))
}

/// Cross-validates `avif_dimensions` against a known encode — no external
/// decoder needed since we control both sides.
#[test]
fn avif_dimensions_parser_matches_known_encode() {
    let rgb = vec![128u8; 6 * 4 * 3]; // 6x4 solid grey
    let bytes = raw_core::avif::encode(6, 4, &rgb, 55).unwrap();
    assert_eq!(avif_dimensions(&bytes), Some((6, 4)));
}

// ─── No-fixture tests (always run) ──────────────────────────────────────────

/// Null pointers (either arg) return rc=1 and set `LAST_ERROR`.
#[test]
fn render_thumbnail_to_file_null_args_return_rc1() {
    let some_path = CString::new("/tmp/does-not-matter").unwrap();
    let rc1 = unsafe {
        maple_render_thumbnail_avif_to_file(std::ptr::null(), some_path.as_ptr(), 512, 0)
    };
    assert_eq!(rc1, 1);
    let rc2 = unsafe {
        maple_render_thumbnail_avif_to_file(some_path.as_ptr(), std::ptr::null(), 512, 0)
    };
    assert_eq!(rc2, 1);
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("null"), "expected null-ptr msg, got: {}", msg);
}

/// `max_px == 0` returns rc=9 — guarded before any I/O so the path
/// doesn't need to exist.
#[test]
fn render_thumbnail_to_file_zero_max_px_returns_rc9() {
    let raw = CString::new("/tmp/in.dng").unwrap();
    let out = CString::new("/tmp/out.avif").unwrap();
    let rc = unsafe { maple_render_thumbnail_avif_to_file(raw.as_ptr(), out.as_ptr(), 0, 0) };
    assert_eq!(rc, 9);
}

/// Bad path (file does not exist) returns rc=6 ("raw read" error).
#[test]
fn render_thumbnail_to_file_missing_input_returns_rc6() {
    let raw = CString::new("/tmp/maple-ffi-no-such-file-xyz.dng").unwrap();
    let out_dir = tempfile::tempdir().unwrap();
    let out_path = out_dir.path().join("thumb.avif");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc =
        unsafe { maple_render_thumbnail_avif_to_file(raw.as_ptr(), out_cstr.as_ptr(), 512, 0) };
    assert_eq!(rc, 6);
    assert!(!out_path.exists(), "output must not be created on rc=6");
    let err = unsafe { maple_last_error() };
    assert!(!err.is_null());
    let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
    assert!(msg.contains("raw read"), "got: {}", msg);
}

/// Synthetic DNG has no embedded JPEG preview / SubIFD / thumbnail —
/// `extract_embedded_preview` exhausts all three rawler slots and the
/// FFI returns rc=8 ("no embedded preview"). No output file is created
/// (the encode never ran) and no `.tmp` is leaked.
#[test]
fn render_thumbnail_to_file_synth_dng_no_preview_returns_rc8() {
    let dir = tempfile::tempdir().unwrap();
    let dng_path = dir.path().join("synth-no-preview.dng");
    SyntheticGreyDng::default().write_to(&dng_path).unwrap();
    let out_path = dir.path().join("thumb.avif");
    let raw_cstr = CString::new(dng_path.to_str().unwrap()).unwrap();
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), 512, 0)
    };
    assert_eq!(rc, 8);
    assert!(
        !out_path.exists(),
        "must not write output on extract failure"
    );
    let tmp_path = out_path.with_extension("avif.tmp");
    assert!(!tmp_path.exists(), "must not leak .tmp on extract failure");
}

/// Pass a path that exists but contains garbage bytes — rawler's
/// `get_decoder` fails to identify the format, which falls through the
/// `try_slot` chain to the "no embedded preview" branch and returns
/// rc=8. (Verifies the panic-catch + error-mapping path doesn't trip.)
#[test]
fn render_thumbnail_to_file_garbage_bytes_returns_rc8() {
    let dir = tempfile::tempdir().unwrap();
    let raw_path = dir.path().join("garbage.dng");
    std::fs::write(&raw_path, b"not a real raw file, just some bytes").unwrap();
    let out_path = dir.path().join("thumb.avif");
    let raw_cstr = CString::new(raw_path.to_str().unwrap()).unwrap();
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), 256, 0)
    };
    assert_eq!(
        rc, 8,
        "garbage bytes should fall through to rc=8, got {}",
        rc
    );
    assert!(!out_path.exists());
}

#[test]
fn avif_to_file_quality_above_100_returns_rc_14() {
    let raw_path = CString::new("/dev/null").unwrap();
    let out_path = CString::new("/tmp/maple_test.avif").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_path.as_ptr(), out_path.as_ptr(), 512, 200)
    };
    assert_eq!(rc, 14, "quality=200 should be rejected at validation");
}

#[test]
fn avif_to_file_quality_255_returns_rc_14() {
    let raw_path = CString::new("/dev/null").unwrap();
    let out_path = CString::new("/tmp/maple_test.avif").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_path.as_ptr(), out_path.as_ptr(), 512, 255)
    };
    assert_eq!(rc, 14);
}

// ─── Fixture-gated tests (skip-pass when fixtures absent) ───────────────────

/// Happy path: real DNG with an embedded preview → rc=0, an AVIF file at
/// `out_path` whose `ftyp` box is present and whose `ispe`-declared long
/// edge is `<= max_px` (resize never upscales).
#[test]
fn render_thumbnail_to_file_fixture_round_trip() {
    let path = fixture_path();
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out_path = dir.path().join("thumb.avif");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let max_px: u32 = 512;
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), max_px, 0)
    };
    assert_eq!(rc, 0, "thumbnail rc = {}", rc);
    assert!(out_path.exists(), "output file must exist after rc=0");

    let bytes = std::fs::read(&out_path).unwrap();
    assert!(bytes.len() > 8, "AVIF should be longer than the ftyp box");
    assert_eq!(&bytes[4..8], &AVIF_FTYP, "missing AVIF ftyp box");

    let (w, h) = avif_dimensions(&bytes).expect("ispe box present");
    assert!(w > 0 && h > 0);
    assert!(
        w.max(h) <= max_px,
        "long edge {} exceeds max_px={}",
        w.max(h),
        max_px
    );

    // No .tmp left behind after a successful rename.
    let tmp_path = out_path.with_extension("avif.tmp");
    assert!(!tmp_path.exists(), ".tmp must be removed on rename success");
}

/// `quality == 0` selects the spec-pinned default of 55. Compare a
/// `quality=0` render against a `quality=55` render — same bytes.
#[test]
fn render_thumbnail_to_file_quality_zero_uses_default() {
    let path = fixture_path();
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let out_default = dir.path().join("default.avif");
    let out_default_cstr = CString::new(out_default.to_str().unwrap()).unwrap();
    let rc1 = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_default_cstr.as_ptr(), 256, 0)
    };
    assert_eq!(rc1, 0);

    let out_explicit = dir.path().join("explicit.avif");
    let out_explicit_cstr = CString::new(out_explicit.to_str().unwrap()).unwrap();
    let rc2 = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_explicit_cstr.as_ptr(), 256, 55)
    };
    assert_eq!(rc2, 0);

    let a = std::fs::read(&out_default).unwrap();
    let b = std::fs::read(&out_explicit).unwrap();
    assert_eq!(a, b, "quality=0 must equal quality=55");
}

/// Regression test for the embedded-preview orientation bug.
///
/// The FFI used to extract the embedded preview JPEG and re-encode it
/// without baking the EXIF orientation tag into the pixels, leaving
/// portrait shots sideways on disk. `raw_core::avif::encode` writes a bare
/// AVIF with no EXIF, same as the JPEG path it replaced, so baking
/// orientation into the pixels before encode is still the only fix.
///
/// `test_0003.CR2` is a portrait Canon shot (see decode.rs:
/// `decode_test_0003_reports_exif_orientation`), so after rotation the
/// thumb's long edge must be the height, not the width. If this assertion
/// flips, the FFI has stopped baking orientation again.
#[test]
fn render_thumbnail_to_file_applies_orientation_to_portrait_raw() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0003.CR2");
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out_path = dir.path().join("thumb.avif");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), 512, 0)
    };
    assert_eq!(rc, 0, "thumbnail rc = {}", rc);
    let bytes = std::fs::read(&out_path).unwrap();
    let (w, h) = avif_dimensions(&bytes).expect("ispe box present");
    assert!(
        h > w,
        "expected portrait thumb for a portrait-shot RAW, got {}x{}",
        w,
        h
    );
}

// ─── maple_render_thumbnail_preview_jpeg_to_file (VLM describe preview) ────

/// Null pointers (either arg) return rc=1, same validation as the AVIF
/// sibling — both share `render_thumbnail_to_file`.
#[test]
fn preview_jpeg_to_file_null_args_return_rc1() {
    let some_path = CString::new("/tmp/does-not-matter").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(std::ptr::null(), some_path.as_ptr(), 512, 0)
    };
    assert_eq!(rc, 1);
}

#[test]
fn preview_jpeg_to_file_quality_above_100_returns_rc_14() {
    let raw_path = CString::new("/dev/null").unwrap();
    let out_path = CString::new("/tmp/maple_test_preview.jpg").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(raw_path.as_ptr(), out_path.as_ptr(), 512, 200)
    };
    assert_eq!(rc, 14, "quality=200 should be rejected at validation");
}

/// Happy path: real DNG with an embedded preview → rc=0, a real JPEG file
/// (decodes via the `image` crate — no custom box-walker needed since JPEG
/// decode carries none of AVIF's C-toolchain dependency-fragility risk)
/// whose long edge is `<= max_px`.
#[test]
fn preview_jpeg_to_file_fixture_round_trip() {
    let path = fixture_path();
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out_path = dir.path().join("preview.jpg");
    let out_cstr = CString::new(out_path.to_str().unwrap()).unwrap();
    let max_px: u32 = 1280;
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(raw_cstr.as_ptr(), out_cstr.as_ptr(), max_px, 0)
    };
    assert_eq!(rc, 0, "preview rc = {}", rc);
    assert!(out_path.exists(), "output file must exist after rc=0");

    let bytes = std::fs::read(&out_path).unwrap();
    assert_eq!(&bytes[0..2], &[0xff, 0xd8], "missing JPEG SOI marker");

    let decoded = image::load_from_memory(&bytes).expect("must decode as a real JPEG");
    use image::GenericImageView;
    let (w, h) = decoded.dimensions();
    assert!(w > 0 && h > 0);
    assert!(
        w.max(h) <= max_px,
        "long edge {} exceeds max_px={}",
        w.max(h),
        max_px
    );

    let tmp_path = out_path.with_extension("jpg.tmp");
    assert!(!tmp_path.exists(), ".tmp must be removed on rename success");
}

/// `quality == 0` selects the preview tier's default of 85 — distinct from
/// the AVIF sibling's default of 55.
#[test]
fn preview_jpeg_to_file_quality_zero_uses_default_85() {
    let path = fixture_path();
    if !path.exists() {
        return;
    }
    let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let out_default = dir.path().join("default.jpg");
    let out_default_cstr = CString::new(out_default.to_str().unwrap()).unwrap();
    let rc1 = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(
            raw_cstr.as_ptr(),
            out_default_cstr.as_ptr(),
            256,
            0,
        )
    };
    assert_eq!(rc1, 0);

    let out_explicit = dir.path().join("explicit.jpg");
    let out_explicit_cstr = CString::new(out_explicit.to_str().unwrap()).unwrap();
    let rc2 = unsafe {
        maple_render_thumbnail_preview_jpeg_to_file(
            raw_cstr.as_ptr(),
            out_explicit_cstr.as_ptr(),
            256,
            85,
        )
    };
    assert_eq!(rc2, 0);

    let a = std::fs::read(&out_default).unwrap();
    let b = std::fs::read(&out_explicit).unwrap();
    assert_eq!(a, b, "quality=0 must equal quality=85");
}
