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

use raw_core::{
    decode::decode_bytes,
    pipeline::{render_from_raw_with_quality, RenderQuality},
    xmp,
};
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

/// Stack size for the worker thread that runs RAW decode + develop. Rawler's
/// per-format decoders (CR3 in particular) allocate several MB of Huffman /
/// JPEG-LS scratch on the stack, and Swift's cooperative-pool threads start
/// with ~512 KB — which trips an EXC_BAD_ACCESS / stack overflow on real RAWs.
/// 16 MB is plenty; physical memory is only committed on demand.
const WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

/// Run a render closure on a dedicated thread with a large stack, then
/// propagate both its return value and any `LAST_ERROR` it set back to the
/// caller. Each FFI entrypoint uses this wrapper so callers don't need to
/// think about stack sizes.
fn with_large_stack<F>(work: F) -> i32
where
    F: FnOnce() -> i32 + Send + 'static,
{
    let handle = std::thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .name("maple-ffi-decode".to_string())
        .spawn(move || {
            let rc = work();
            // Ferry the worker's thread-local last error out to the caller
            // thread so `maple_last_error` still reports useful messages.
            let err = LAST_ERROR.with(|e| e.borrow().clone());
            (rc, err)
        });
    match handle {
        Ok(h) => match h.join() {
            Ok((rc, err)) => {
                if let Some(cstr) = err {
                    LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
                }
                rc
            }
            Err(_) => {
                set_last_error("render worker panicked".into());
                99
            }
        },
        Err(e) => {
            set_last_error(format!("spawn worker failed: {}", e));
            98
        }
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
///
/// `quality_preview` selects the internal demosaic / downsample strategy:
///   0 → `RenderQuality::Full`    (bilinear or HA demosaic, full resolution;
///                                  export path, matches the parity harness)
///   1 → `RenderQuality::Preview` (half-res quad demosaic; the returned
///                                  buffer is at half the sensor's dimensions
///                                  in both axes — caller must scale for
///                                  display; use for interactive fast-phase
///                                  so a 100MP RAW decodes in seconds)
#[no_mangle]
pub unsafe extern "C" fn maple_render_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // Pull the paths into owned Strings so the worker thread can own them.
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;  // Send across the thread as a usize, cast back inside.
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_bytes = match std::fs::read(raw_path) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match decode_bytes(&raw_bytes, ext) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        let (w, h, bytes) = match render_from_raw_with_quality(&raw_img, &model, quality) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let mut boxed = bytes.into_boxed_slice();
        let rgb = boxed.as_mut_ptr();
        let len = boxed.len();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleImageBuffer) =
                MapleImageBuffer { rgb, len, width: w, height: h };
        }
        0
    })
}

/// Render a RAW from a byte slice (PhotoKit, self-hosted API, etc.) through
/// the pipeline. Identical to `maple_render_file` except the caller hands us
/// bytes instead of a path, and supplies an extension hint (e.g. "dng", "cr2",
/// "arw") so the decoder can dispatch.
///
/// `xmp_path` may be null, in which case `AdjustmentModel::default()` is used.
/// `hint_ext` must be a UTF-8 C string naming the RAW extension (without dot).
/// `quality_preview` mirrors `maple_render_file` — 1 = half-res preview
/// demosaic for the fast interactive path (returned buffer is at half the
/// sensor's dimensions in both axes; caller must scale for display),
/// 0 = full export quality.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleImageBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let ext_owned: String = if hint_ext.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(hint_ext).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => { set_last_error(format!("hint_ext not UTF-8: {}", e)); return 2; }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    // Copy input bytes into a Vec the worker can own — the caller's pointer
    // may not live past the join() on a slow decode.
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match decode_bytes(&input, &ext_owned) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            RenderQuality::Preview
        } else {
            RenderQuality::Full
        };
        let (w, h, out_bytes) = match render_from_raw_with_quality(&raw_img, &model, quality) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let mut boxed = out_bytes.into_boxed_slice();
        let rgb = boxed.as_mut_ptr();
        let len = boxed.len();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleImageBuffer) =
                MapleImageBuffer { rgb, len, width: w, height: h };
        }
        0
    })
}

/// Free a buffer populated by `maple_render_file` or `maple_render_bytes`.
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

/// Scene-linear FFI buffer — Rec.2020 fp16 RGBA, straight alpha, row-major.
///
/// `bytes_per_pixel` is always 8 (4 channels × 2 bytes per fp16 lane). It
/// is exposed in the struct so the Apple consumer can read the layout
/// without hard-coding the constant; future plans (e.g. higher bit depth
/// for HDR) can change it without breaking the ABI.
#[repr(C)]
pub struct MapleSceneLinearBuffer {
    /// Pointer to heap-allocated fp16 RGBA buffer. Free via
    /// `maple_free_scene_linear_buffer`.
    pub fp16_rgba: *mut u16,
    /// Bytes in the buffer (= 4 * 2 * width * height = 8 * width * height).
    pub len_bytes: usize,
    /// Channels per pixel (always 4: R, G, B, A).
    pub channels: u32,
    /// Bytes per pixel (always 8 for fp16 RGBA).
    pub bytes_per_pixel: u32,
    pub width: u32,
    pub height: u32,
}

impl MapleSceneLinearBuffer {
    fn empty() -> Self {
        Self {
            fp16_rgba: std::ptr::null_mut(),
            len_bytes: 0,
            channels: 0,
            bytes_per_pixel: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Render a RAW+XMP to a scene-linear Rec.2020 fp16 RGBA buffer. Returns
/// 0 on success, non-zero on error (call `maple_last_error`). The output
/// pre-AgX, pre-Rec.2020->sRGB — the caller is expected to apply a view
/// transform and gamut convert before display.
///
/// `quality_preview` mirrors `maple_render_file` — 1 = half-res preview,
/// 0 = full export.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_bytes = match std::fs::read(raw_path) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match decode_bytes(&raw_bytes, ext) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        // Box the Vec<u16> so we can hand the raw pointer + len to the caller.
        let mut boxed = fp16.into_boxed_slice();
        let fp16_ptr = boxed.as_mut_ptr();
        let len_lanes = boxed.len();
        let len_bytes = len_lanes * std::mem::size_of::<u16>();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Render a RAW from a byte slice to a scene-linear Rec.2020 fp16 RGBA
/// buffer. Mirrors `maple_render_bytes` for the new path.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let ext_owned: String = if hint_ext.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(hint_ext).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => { set_last_error(format!("hint_ext not UTF-8: {}", e)); return 2; }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match decode_bytes(&input, &ext_owned) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let mut boxed = fp16.into_boxed_slice();
        let fp16_ptr = boxed.as_mut_ptr();
        let len_lanes = boxed.len();
        let len_bytes = len_lanes * std::mem::size_of::<u16>();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Free a buffer populated by `maple_render_*_scene_linear`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_scene_linear_buffer(buffer: *mut MapleSceneLinearBuffer) {
    if buffer.is_null() { return; }
    let b = &mut *buffer;
    if !b.fp16_rgba.is_null() {
        let len_lanes = b.len_bytes / std::mem::size_of::<u16>();
        let slice = std::slice::from_raw_parts_mut(b.fp16_rgba, len_lanes);
        drop(Box::from_raw(slice as *mut [u16]));
    }
    *b = MapleSceneLinearBuffer::empty();
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
        let mut buf = MapleImageBuffer::empty();
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
        let mut buf = MapleImageBuffer::empty();
        let rc = unsafe { maple_render_file(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    #[test]
    fn render_scene_linear_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear(raw_cstr.as_ptr(), std::ptr::null(), 1, &mut buf)
        };
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
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe { maple_render_file_scene_linear(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }
}
