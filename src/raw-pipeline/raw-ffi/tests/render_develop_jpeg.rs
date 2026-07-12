//! Gate for `maple_render_develop_jpeg_to_file` (#1950) — the developed
//! (sidecar-applied) JPEG-to-file extern behind the self-hosted
//! `display-preview` stage.
//!
//! Calls the actual C-ABI entry point and asserts it writes a valid,
//! correctly-sized JPEG. Skip-passes when the RAW fixture is absent (CI
//! without the gitignored `test-fixtures/raws/`).
//!
//! Run locally:
//! ```text
//! cargo test -p raw-ffi --test render_develop_jpeg -- --nocapture
//! ```

use std::ffi::{c_char, CString};
use std::path::PathBuf;

use raw_ffi::maple_render_develop_jpeg_to_file;

fn repo_root() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        if dir.join("test-fixtures").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap()
}

/// Neutral develop (null XMP) of a real RAW writes a valid JPEG at the
/// requested long-edge target.
#[test]
fn develops_neutral_jpeg_at_target_size() {
    let Some(root) = repo_root() else {
        eprintln!("render_develop_jpeg: SKIP-PASS — no test-fixtures dir");
        return;
    };
    let raw = root.join("test-fixtures/raws/test_0002.dng");
    if !raw.is_file() {
        eprintln!(
            "render_develop_jpeg: SKIP-PASS — fixture {} absent",
            raw.display()
        );
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("dev.jpg");
    let raw_c = cstr(raw.to_str().unwrap());
    let out_c = cstr(out.to_str().unwrap());

    let rc = unsafe {
        maple_render_develop_jpeg_to_file(
            raw_c.as_ptr(),
            std::ptr::null::<c_char>(), // null XMP → neutral develop
            1280,
            82,
            out_c.as_ptr(),
        )
    };
    assert_eq!(rc, 0, "expected success rc, got {rc}");
    assert!(out.is_file(), "output JPEG was not written");

    let img = image::open(&out).expect("output must be a decodable JPEG");
    let long_edge = img.width().max(img.height());
    assert!(long_edge > 0, "degenerate output");
    assert!(
        long_edge <= 1280,
        "long edge {long_edge} exceeds the 1280 target"
    );
    // A 1280 develop of a multi-MP RAW should hit the target, not stay tiny.
    assert!(
        long_edge >= 640,
        "long edge {long_edge} suspiciously small — expected downscale to ~1280"
    );
}

/// Argument validation: a zero `max_px` is rejected without writing a file.
#[test]
fn rejects_zero_max_px() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("nope.jpg");
    let raw_c = cstr("/nonexistent.dng");
    let out_c = cstr(out.to_str().unwrap());
    let rc = unsafe {
        maple_render_develop_jpeg_to_file(
            raw_c.as_ptr(),
            std::ptr::null::<c_char>(),
            0,
            82,
            out_c.as_ptr(),
        )
    };
    assert_ne!(rc, 0, "zero max_px must be rejected");
    assert!(
        !out.exists(),
        "no file should be written on a validation error"
    );
}

/// A null out_path is rejected.
#[test]
fn rejects_null_out_path() {
    let raw_c = cstr("/nonexistent.dng");
    let rc = unsafe {
        maple_render_develop_jpeg_to_file(
            raw_c.as_ptr(),
            std::ptr::null::<c_char>(),
            1280,
            82,
            std::ptr::null::<c_char>(),
        )
    };
    assert_ne!(rc, 0, "null out_path must be rejected");
}
