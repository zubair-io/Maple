//! Gate for the second-generation raster C ABI entry points (#3498):
//! `maple_raster_render_buf`, `maple_raster_from_raw_render_buf`, and
//! `maple_raster_decode_rgb8_buf`.
//!
//! Calls the actual C-ABI externs (re-exported from the crate root, same
//! pattern as `render_develop_jpeg.rs`) and asserts the too-small-buffer
//! protocol and the encoded/decoded output.

use std::ffi::CString;

use raw_ffi::{
    maple_raster_decode_rgb8_buf, maple_raster_from_raw_render_buf, maple_raster_render_buf,
};

fn solid_png(w: u32, h: u32) -> Vec<u8> {
    let rgb = vec![90u8; (w * h * 3) as usize];
    let raster = raw_core::raster::RasterImage::new_rgb(w, h, rgb);
    raw_core::export::encode_raster(&raster, raw_core::export::ExportFormat::Png, 0).unwrap()
}

#[test]
fn render_buf_covers_and_reports_needed_size() {
    let png = solid_png(40, 20);
    let fmt = CString::new("jpeg").unwrap();
    let mut len = 0usize;
    let rc = unsafe {
        maple_raster_render_buf(
            png.as_ptr(),
            png.len(),
            10,
            10,
            0b1000,
            1,
            fmt.as_ptr(),
            80,
            0,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    assert_eq!(rc, 100);
    assert!(len > 100);
    let mut out = vec![0u8; len];
    let rc = unsafe {
        maple_raster_render_buf(
            png.as_ptr(),
            png.len(),
            10,
            10,
            0b1000,
            1,
            fmt.as_ptr(),
            80,
            0,
            out.as_mut_ptr(),
            out.len(),
            &mut len,
        )
    };
    assert_eq!(rc, 0);
    let meta = raw_core::raster::probe_raster_metadata(&out[..len]).unwrap();
    assert_eq!((meta.width, meta.height), (10, 10));
}

#[test]
fn from_raw_render_buf_encodes_caller_pixels() {
    let pixels = vec![200u8; 8 * 4 * 4];
    let fmt = CString::new("png").unwrap();
    let mut len = 0usize;
    let mut out = vec![0u8; 1 << 16];
    let rc = unsafe {
        maple_raster_from_raw_render_buf(
            pixels.as_ptr(),
            pixels.len(),
            8,
            4,
            4,
            4,
            2,
            0,
            0,
            fmt.as_ptr(),
            0,
            0,
            out.as_mut_ptr(),
            out.len(),
            &mut len,
        )
    };
    assert_eq!(rc, 0);
    let meta = raw_core::raster::probe_raster_metadata(&out[..len]).unwrap();
    assert_eq!(
        (meta.width, meta.height, meta.format.as_str()),
        (4, 2, "png")
    );
}

#[test]
fn decode_rgb8_buf_returns_native_size_pixels() {
    let png = solid_png(6, 5);
    let (mut w, mut h, mut len) = (0u32, 0u32, 0usize);
    let rc = unsafe {
        maple_raster_decode_rgb8_buf(
            png.as_ptr(),
            png.len(),
            1,
            std::ptr::null_mut(),
            0,
            &mut len,
            &mut w,
            &mut h,
        )
    };
    assert_eq!((rc, w, h, len), (100, 6, 5, 6 * 5 * 3));
    let mut out = vec![0u8; len];
    let rc = unsafe {
        maple_raster_decode_rgb8_buf(
            png.as_ptr(),
            png.len(),
            1,
            out.as_mut_ptr(),
            out.len(),
            &mut len,
            &mut w,
            &mut h,
        )
    };
    assert_eq!(rc, 0);
    assert!(out.iter().all(|&b| b == 90));
}
