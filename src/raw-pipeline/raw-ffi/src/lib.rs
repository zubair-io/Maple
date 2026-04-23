//! C ABI surface for raw-core. Intended for consumption by Apple's
//! `MapleCore` Swift package via `RawPipeline.xcframework` (per spec § 00).
//!
//! Minimal v1 surface:
//!
//!   int maple_render_file(
//!       const char* raw_path,
//!       const char* xmp_path,            // may be null — uses AdjustmentModel::default()
//!       MapleImageBuffer* out            // receives width, height, rgb pointer
//!   );
//!
//!   void maple_free_buffer(MapleImageBuffer* buffer);
//!
//!   const char* maple_last_error(void);  // thread-local; cleared on next call
//!
//! Output is u8 sRGB RGB (length = 3 × width × height).

#![allow(clippy::missing_safety_doc)]

use raw_core::{decode::decode_bytes, pipeline::render_from_raw, xmp};
use std::ffi::{CStr, c_char};
use std::cell::RefCell;

thread_local! {
    static LAST_ERROR: RefCell<Option<std::ffi::CString>> = const { RefCell::new(None) };
}

fn set_last_error(msg: String) {
    if let Ok(cstr) = std::ffi::CString::new(msg) {
        LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
    }
}

#[repr(C)]
pub struct MapleImageBuffer {
    /// Pointer to heap-allocated RGB u8 buffer. Free via `maple_free_buffer`.
    pub rgb: *mut u8,
    /// Bytes in the buffer (= 3 * width * height).
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

impl MapleImageBuffer {
    fn empty() -> Self {
        Self { rgb: std::ptr::null_mut(), len: 0, width: 0, height: 0 }
    }
}

/// Render a RAW+XMP to an sRGB 8-bit RGB buffer. Returns 0 on success, non-zero
/// on error (call `maple_last_error` for a description). `xmp_path` may be null,
/// in which case AdjustmentModel::default() is used.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let raw_path = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => std::path::Path::new(s),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let model = if xmp_path.is_null() {
        xmp::AdjustmentModel::default()
    } else {
        let path = match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => std::path::Path::new(s),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        };
        match std::fs::read_to_string(path) {
            Ok(xml) => match xmp::parse(&xml) {
                Ok(m) => m,
                Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
            },
            Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
        }
    };
    // Shell owns the I/O — read the file here, then invoke the pure core.
    let raw_bytes = match std::fs::read(raw_path) {
        Ok(b) => b,
        Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
    };
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = match decode_bytes(&raw_bytes, ext) {
        Ok(r) => r,
        Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
    };
    let (w, h, bytes) = match render_from_raw(&raw_img, &model) {
        Ok(t) => t,
        Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
    };
    let mut boxed = bytes.into_boxed_slice();
    let rgb = boxed.as_mut_ptr();
    let len = boxed.len();
    std::mem::forget(boxed);
    *out = MapleImageBuffer { rgb, len, width: w, height: h };
    0
}

/// Free a buffer populated by `maple_render_file`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_buffer(buffer: *mut MapleImageBuffer) {
    if buffer.is_null() { return; }
    let b = &mut *buffer;
    if !b.rgb.is_null() {
        let slice = std::slice::from_raw_parts_mut(b.rgb, b.len);
        drop(Box::from_raw(slice as *mut [u8]));
    }
    *b = MapleImageBuffer::empty();
}

/// Returns the most recent error message for the current thread, or null.
/// The returned pointer remains valid until the next FFI call on this thread.
#[no_mangle]
pub unsafe extern "C" fn maple_last_error() -> *const c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(cstr) => cstr.as_ptr(),
        None => std::ptr::null(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn render_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe { maple_render_file(raw_cstr.as_ptr(), std::ptr::null(), &mut buf) };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width > 0 && buf.height > 0);
        assert_eq!(buf.len as u32, buf.width * buf.height * 3);
        unsafe { maple_free_buffer(&mut buf) };
        assert!(buf.rgb.is_null());
    }

    #[test]
    fn null_arg_sets_error() {
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe { maple_render_file(std::ptr::null(), std::ptr::null(), &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }
}
