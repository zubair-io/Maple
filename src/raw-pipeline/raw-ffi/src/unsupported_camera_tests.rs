//! A RAW from a camera body the decoder has no definition for (#5499): the
//! server's thumbnail still extracts its embedded preview, and the develop
//! reports the dedicated unsupported-camera rc instead of a generic decode
//! failure, so the API can tell it apart from a damaged original.

use crate::error::maple_last_error;
use crate::render_develop::maple_render_develop_jpeg_to_file;
use crate::thumbnail::maple_render_thumbnail_avif_to_file;
use raw_core::test_support::synth_unknown_body::{unknown_body_3fr, MODEL};
use std::ffi::{CStr, CString};

fn c_path(path: &std::path::Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

#[test]
fn unknown_body_thumbnail_comes_from_the_embedded_preview() {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("frame.3fr");
    std::fs::write(&raw, unknown_body_3fr()).unwrap();
    let out = dir.path().join("thumb.avif");
    let rc = unsafe {
        maple_render_thumbnail_avif_to_file(c_path(&raw).as_ptr(), c_path(&out).as_ptr(), 256, 0)
    };
    assert_eq!(rc, 0);
    assert_eq!(&std::fs::read(&out).unwrap()[4..8], b"ftyp");
}

#[test]
fn unknown_body_develop_returns_the_unsupported_camera_rc() {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("frame.3fr");
    std::fs::write(&raw, unknown_body_3fr()).unwrap();
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
    assert_eq!(rc, raw_core::Error::UNSUPPORTED_CAMERA_FFI_CODE);
    assert!(!out.exists());
    let message = unsafe { CStr::from_ptr(maple_last_error()).to_str().unwrap() };
    assert_eq!(
        message,
        format!(
            "{}Hasselblad {MODEL}",
            raw_core::Error::UNSUPPORTED_CAMERA_MESSAGE_PREFIX
        )
    );
}
