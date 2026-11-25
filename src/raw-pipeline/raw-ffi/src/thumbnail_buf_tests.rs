//! `maple_render_thumbnail_preview_jpeg_buf` (#6018): the in-memory sibling
//! must return the same bytes as the file extern, report the size it needs
//! when the caller's buffer is short, and reject null arguments.

use crate::thumbnail::{
    maple_render_thumbnail_preview_jpeg_buf, maple_render_thumbnail_preview_jpeg_to_file,
};
use raw_core::test_support::synth_dng_preview::dng_with_jpeg_preview;
use std::ffi::CString;

fn staged_dng(dir: &std::path::Path) -> CString {
    let photo = image::RgbImage::from_fn(640, 480, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
    });
    let jpeg = raw_core::jpeg::encode(640, 480, photo.as_raw(), 90).unwrap();
    let path = dir.join("preview.dng");
    std::fs::write(&path, dng_with_jpeg_preview(&jpeg, 640, 480)).unwrap();
    CString::new(path.to_str().unwrap()).unwrap()
}

#[test]
fn buffer_bytes_match_the_file_extern() {
    let dir = tempfile::tempdir().unwrap();
    let raw = staged_dng(dir.path());
    let out_path = dir.path().join("preview.jpg");
    let out = CString::new(out_path.to_str().unwrap()).unwrap();
    let rc =
        unsafe { maple_render_thumbnail_preview_jpeg_to_file(raw.as_ptr(), out.as_ptr(), 320, 0) };
    assert_eq!(rc, 0);
    let from_file = std::fs::read(&out_path).unwrap();

    let mut needed = 0usize;
    let probe = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            raw.as_ptr(),
            320,
            0,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_eq!(probe, 100);
    assert_eq!(needed, from_file.len());

    let mut buf = vec![0u8; needed + 16];
    let mut len = 0usize;
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            raw.as_ptr(),
            320,
            0,
            buf.as_mut_ptr(),
            buf.len(),
            &mut len,
        )
    };
    assert_eq!(rc, 0);
    assert_eq!(&buf[..len], from_file.as_slice());
}

#[test]
fn short_buffer_is_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let raw = staged_dng(dir.path());
    let mut buf = vec![7u8; 8];
    let mut len = 0usize;
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            raw.as_ptr(),
            320,
            0,
            buf.as_mut_ptr(),
            buf.len(),
            &mut len,
        )
    };
    assert_eq!(rc, 100);
    assert!(len > buf.len());
    assert!(buf.iter().all(|&b| b == 7));
}

#[test]
fn null_arguments_return_rc1() {
    let mut len = 0usize;
    let path = CString::new("/nonexistent.dng").unwrap();
    let null_path = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            std::ptr::null(),
            320,
            0,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    let null_len = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            path.as_ptr(),
            320,
            0,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
        )
    };
    assert_eq!((null_path, null_len), (1, 1));
}

#[test]
fn zero_max_px_returns_rc9() {
    let mut len = 0usize;
    let path = CString::new("/nonexistent.dng").unwrap();
    let rc = unsafe {
        maple_render_thumbnail_preview_jpeg_buf(
            path.as_ptr(),
            0,
            0,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    assert_eq!(rc, 9);
}
