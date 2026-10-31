//! A DNG whose embedded-preview IFD declares a zero dimension (#5580): the
//! Auto profile's preview probe used to panic inside rawler, which surfaced as
//! rc 99 ("render worker panicked: chunk size must be non-zero") from
//! `maple_render_develop_jpeg_to_file`. The raw itself is intact, so the
//! develop must succeed without a preview.

use crate::error::maple_last_error;
use crate::render_develop::maple_render_develop_jpeg_to_file;
use raw_core::test_support::synth_dng_preview::{dng_with_preview_sub_ifd, PreviewStrip};
use std::ffi::{CStr, CString};

fn c_path(path: &std::path::Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

fn develop(dng: &[u8]) -> (i32, Option<String>, bool) {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("PANO0009.dng");
    std::fs::write(&raw, dng).unwrap();
    let out = dir.path().join("develop.jpg");
    let rc = unsafe {
        maple_render_develop_jpeg_to_file(
            c_path(&raw).as_ptr(),
            std::ptr::null(),
            1280,
            0,
            c_path(&out).as_ptr(),
        )
    };
    let error = unsafe { maple_last_error().as_ref() }.map(|message| {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    });
    (rc, error, out.is_file())
}

#[test]
fn jpeg_preview_ifd_declaring_zero_width_develops_without_a_preview() {
    let (rc, error, written) = develop(&dng_with_preview_sub_ifd(PreviewStrip::Jpeg, 0, 4));
    assert_eq!((rc, error), (0, None));
    assert!(written);
}

#[test]
fn uncompressed_preview_ifd_declaring_zero_height_develops_without_a_preview() {
    let (rc, error, written) = develop(&dng_with_preview_sub_ifd(PreviewStrip::Uncompressed, 8, 0));
    assert_eq!((rc, error), (0, None));
    assert!(written);
}
