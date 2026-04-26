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
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
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
        let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = bytes.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n)
        });
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
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
        let (rgb, len) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = out_bytes.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n)
        });
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
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
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
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
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
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

/// Sized scene-linear render — same as `maple_render_file_scene_linear`
/// but downsamples to fit within `max_long_edge` on its long edge,
/// preserving aspect ratio, never upscaling. Same return / error
/// conventions and the same `MapleSceneLinearBuffer` output struct.
///
/// API choice: a single `max_long_edge` u32 instead of `max_width/
/// max_height` simplifies WASM/Web parity (Plan 3 will mirror this on
/// the Web FFI; one scalar keeps the JS binding signature shorter).
/// Aspect math is local to the Rust renderer because it knows the
/// source dimensions.
///
/// Plan 1 v2 — see docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md
/// Task 8 and docs/tickets/06-viewport-sized-rust-ffi-preview.md
/// Milestone 2.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_sized(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
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
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

/// Sized scene-linear render from a byte slice — bytes equivalent of
/// `maple_render_file_scene_linear_sized`. Same args + `raw_bytes` /
/// `raw_len` / `hint_ext`.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_sized(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

/// Tile scene-linear render — same fp16 RGBA output struct as the sized
/// variant, but renders only the source-pixel rectangle
/// `(src_x, src_y, src_w, src_h)`. Pads internally by 35 px to satisfy
/// the development chain's stencil radii (clarity is the binding
/// constraint), then trims to the inner rect, downsamples to
/// `(out_w, out_h)`, orients, and packs to fp16 RGBA.
///
/// Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
/// plus:
///   - 9:  `src_w/src_h/out_w/out_h == 0` — bad tile geometry.
///   - 10: `model.dehaze != 0` — tile path is not supported (radius 67
///     exceeds the 35 px overlap pad). Caller should fall back to
///     fit-zoom rendering.
///   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
///
/// Plan 3 — see docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
/// Task 2 and docs/tickets/06-viewport-sized-rust-ffi-preview.md M4.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_tile(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
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
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

/// Tile scene-linear render from a byte slice — bytes equivalent of
/// `maple_render_file_scene_linear_tile`. Same arguments + `raw_bytes` /
/// `raw_len` / `hint_ext` (mirroring the bytes-variant convention from
/// `maple_render_bytes_scene_linear_sized`).
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_tile(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            &raw_img, &model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

// =====================================================================
// Opaque handle for cached rawler-decoded RawImage + parsed XMP.
// =====================================================================
//
// Plan 3 (Ticket 06 M4) — see
// docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md Task 3.
//
// The handle keeps the decoded `RawImage` plus the parsed
// `AdjustmentModel` alive across multiple tile renders so a 100 MP
// rawler decode (~3-5 s cold) runs once per asset open instead of once
// per tile. Apple side wraps the opaque pointer in a `MapleRawHandleBox`
// final class whose `deinit` calls `maple_close_raw_handle`. Rust side
// owns a `Box<MapleRawHandleInner>`.
//
// Deliberate design choices:
//
//   - The xmp file is parsed once at `maple_open_raw_handle` time and
//     stored alongside the RawImage. Tile renders therefore don't
//     need a per-call model serialization (no serde / json dep on
//     raw-ffi). To re-render with a different model the caller closes
//     the handle and reopens with a new xmp path.
//
//   - The struct exposed in the C ABI is `#[repr(C)]` with a single
//     `*mut c_void` field, identical in shape to a forward-declared
//     opaque struct. cbindgen emits a typedef for callers.
//
//   - Same error code semantics as the file/bytes tile entries: 10 for
//     dehaze-active, 11 for upscale-attempt, 9 for bad geometry.

/// Internal state behind the opaque pointer. Not exposed in the C ABI.
struct MapleRawHandleInner {
    raw: raw_core::image::RawImage,
    model: xmp::AdjustmentModel,
}

/// Opaque handle to a decoded RawImage + parsed AdjustmentModel.
/// Allocate via `maple_open_raw_handle` (or
/// `maple_open_raw_handle_bytes`); free via `maple_close_raw_handle`.
/// The pointee layout is intentionally undocumented; callers must treat
/// `*mut MapleRawHandle` as opaque.
#[repr(C)]
pub struct MapleRawHandle {
    /// Opaque pointer to a heap-allocated `MapleRawHandleInner`. Not
    /// introspected by callers.
    inner: *mut std::ffi::c_void,
}

/// Open a RAW + optional XMP sidecar into an opaque handle suitable for
/// repeated tile rendering. The handle owns the rawler-decoded mosaic
/// and the parsed AdjustmentModel; subsequent calls to
/// `maple_render_handle_scene_linear_tile` skip both.
///
/// `xmp_path` may be null — in that case `AdjustmentModel::default()`
/// is stored in the handle.
///
/// Returns 0 on success and writes the handle pointer into
/// `*handle_out`. Non-zero on error (call `maple_last_error` for the
/// message). The output handle pointer is always written: it is null
/// on error and non-null on success.
///
/// The caller must eventually free the handle via
/// `maple_close_raw_handle`. Failing to do so leaks the underlying
/// `RawImage` (~30-300 MB depending on sensor resolution).
#[no_mangle]
pub unsafe extern "C" fn maple_open_raw_handle(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    handle_out: *mut *mut MapleRawHandle,
) -> i32 {
    if raw_path.is_null() || handle_out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    // Initialize the out pointer to null defensively so callers that
    // ignore the rc and read the slot still see a sentinel value.
    *handle_out = std::ptr::null_mut();
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
    let handle_out_addr = handle_out as usize;
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
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let inner = Box::new(MapleRawHandleInner { raw: raw_img, model });
        let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner: inner_ptr });
        unsafe {
            *(handle_out_addr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}

/// Bytes-variant of `maple_open_raw_handle`. Decodes from an in-memory
/// RAW byte slice (PhotoKit / network-source codepaths). `hint_ext` is
/// the extension without the leading dot (e.g. `"dng"`); pass null or
/// empty for content-sniff fallback.
#[no_mangle]
pub unsafe extern "C" fn maple_open_raw_handle_bytes(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    handle_out: *mut *mut MapleRawHandle,
) -> i32 {
    if raw_bytes.is_null() || handle_out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    *handle_out = std::ptr::null_mut();
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
    let handle_out_addr = handle_out as usize;
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
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let inner = Box::new(MapleRawHandleInner { raw: raw_img, model });
        let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner: inner_ptr });
        unsafe {
            *(handle_out_addr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}

/// Render a tile from a previously opened raw handle. Same arguments
/// and error codes as `maple_render_file_scene_linear_tile` minus the
/// path / xmp handling — the handle already carries the decoded
/// `RawImage` and parsed `AdjustmentModel`.
///
/// Error codes:
///   - 1: null pointer argument
///   - 9: bad tile geometry (src_w/src_h/out_w/out_h == 0)
///   - 10: dehaze active in the handle's model — tile path unsafe
///   - 11: upscale attempt (out > src) — tile path is downscale-only
///   - 8: any other error from the core tile renderer
#[no_mangle]
pub unsafe extern "C" fn maple_render_handle_scene_linear_tile(
    handle: *const MapleRawHandle,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if handle.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        set_last_error("src_w/src_h/out_w/out_h must be > 0".into());
        return 9;
    }
    let inner_ptr = (*handle).inner as *const MapleRawHandleInner;
    if inner_ptr.is_null() {
        set_last_error("handle has been freed".into());
        return 1;
    }
    let inner: &MapleRawHandleInner = &*inner_ptr;
    let raw_addr = (&inner.raw) as *const _ as usize;
    let model_addr = (&inner.model) as *const _ as usize;
    let out_ptr = out as usize;
    let quality = if quality_preview != 0 {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    with_large_stack(move || {
        // SAFETY: caller guarantees the handle is alive for the
        // duration of this call (caller is the actor-isolated
        // RawImageCache; see Task 5). The references read here live in
        // the heap-boxed `MapleRawHandleInner` whose lifetime is tied
        // to the matching `maple_close_raw_handle` call.
        let raw_img: &raw_core::image::RawImage = unsafe { &*(raw_addr as *const raw_core::image::RawImage) };
        let model: &xmp::AdjustmentModel = unsafe { &*(model_addr as *const xmp::AdjustmentModel) };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality(
            raw_img, model, src_x, src_y, src_w, src_h, out_w, out_h, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                let msg = format!("{}", e);
                set_last_error(msg.clone());
                if msg.contains("dehaze") { return 10; }
                if msg.contains("upscale") || msg.contains("downscale-only") { return 11; }
                return 8;
            }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
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

/// Free a `MapleRawHandle` and its inner `RawImage` + `AdjustmentModel`.
/// No-op when `handle` is null. Apple's `MapleRawHandleBox.deinit` calls
/// this on cache eviction or asset switch.
#[no_mangle]
pub unsafe extern "C" fn maple_close_raw_handle(handle: *mut MapleRawHandle) {
    if handle.is_null() { return; }
    let h = Box::from_raw(handle);
    if !h.inner.is_null() {
        let inner = h.inner as *mut MapleRawHandleInner;
        drop(Box::from_raw(inner));
    }
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

    #[test]
    fn render_scene_linear_sized_via_ffi_caps_long_edge() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let max_long_edge: u32 = 800;
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), max_long_edge, 1, &mut buf,
            )
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width.max(buf.height) <= max_long_edge,
            "size cap not respected: {}x{}", buf.width, buf.height);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    #[test]
    fn sized_zero_long_edge_sets_error() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), 0, 1, &mut buf,
            )
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
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                std::ptr::null(), std::ptr::null(),
                0, 0, 512, 512, 256, 256, 0, &mut buf,
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
        let mut buf = MapleSceneLinearBuffer::empty();
        // src_w == 0
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                dummy.as_ptr(), std::ptr::null(),
                0, 0, 0, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 9, "src_w=0 should be rc=9, got {}", rc);
        // out_h == 0
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                dummy.as_ptr(), std::ptr::null(),
                0, 0, 512, 512, 256, 0, 0, &mut buf,
            )
        };
        assert_eq!(rc, 9, "out_h=0 should be rc=9, got {}", rc);
    }

    /// Bytes-variant null pointer returns 1.
    #[test]
    fn tile_bytes_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let ext = CString::new("dng").unwrap();
        let rc = unsafe {
            maple_render_bytes_scene_linear_tile(
                std::ptr::null(), 0, ext.as_ptr(), std::ptr::null(),
                0, 0, 512, 512, 256, 256, 0, &mut buf,
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
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 512, 512, 256, 256,
                /* quality_preview = */ 0, &mut buf,
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
        assert_eq!(alpha_ok, (buf.width * buf.height) as usize,
            "all alpha lanes must be fp16 1.0");
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    /// Bytes-variant tile render with default model — same shape checks
    /// as the file-path test. Fixture-gated.
    #[test]
    fn render_tile_default_model_via_bytes_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let ext = CString::new("dng").unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_bytes_scene_linear_tile(
                bytes.as_ptr(), bytes.len(), ext.as_ptr(), std::ptr::null(),
                1024, 1024, 512, 512, 256, 256,
                0, &mut buf,
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
        if !path.exists() { return; }
        // Synthesize an XMP file with dehaze=50.
        let xmp_path = std::env::temp_dir().join("tile-dehaze-ffi.xmp");
        std::fs::write(
            &xmp_path,
            r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
        ).unwrap();
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), xmp_cstr.as_ptr(),
                1024, 1024, 512, 512, 256, 256, 0, &mut buf,
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
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        // out_w > src_w
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 256, 256, 512, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
        // out_h > src_h
        let rc = unsafe {
            maple_render_file_scene_linear_tile(
                raw_cstr.as_ptr(), std::ptr::null(),
                1024, 1024, 256, 256, 256, 512, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_h>src_h must rc=11, got {}", rc);
    }

    // -----------------------------------------------------------------
    // MapleRawHandle FFI tests (Plan deep-zoom-tile-rendering Task 3).
    // -----------------------------------------------------------------

    /// Null pointer to `maple_open_raw_handle` returns 1; the out
    /// pointer is initialized to null on error.
    #[test]
    fn open_raw_handle_null_arg_sets_error() {
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(std::ptr::null(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 1);
        assert!(handle.is_null());
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }

    /// Null handle to `maple_render_handle_scene_linear_tile` returns 1.
    #[test]
    fn render_handle_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                std::ptr::null(), 0, 0, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 1);
    }

    /// `maple_close_raw_handle(null)` is a no-op (no crash).
    #[test]
    fn close_raw_handle_null_is_noop() {
        unsafe { maple_close_raw_handle(std::ptr::null_mut()) };
    }

    /// Open a handle, render a tile, close. Verifies the round-trip
    /// works end-to-end. Fixture-gated.
    #[test]
    fn raw_handle_round_trip_renders_tile() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0, "open rc = {}", rc);
        assert!(!handle.is_null());
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        // Verify alpha lane is fp16 1.0 in every pixel.
        let n_lanes = buf.len_bytes / std::mem::size_of::<u16>();
        let lanes = unsafe { std::slice::from_raw_parts(buf.fp16_rgba, n_lanes) };
        let alpha_ok = lanes.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (buf.width * buf.height) as usize);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
    }

    /// Multiple tile renders against the same handle reuse the cached
    /// decoded mosaic. Sanity check on the lifecycle: open once, render
    /// 3 different tiles, close once.
    #[test]
    fn raw_handle_renders_multiple_tiles() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0);
        // Render three non-overlapping tiles.
        let coords: [(u32, u32); 3] = [(0, 0), (1024, 0), (0, 1024)];
        for (sx, sy) in coords.iter() {
            let mut buf = MapleSceneLinearBuffer::empty();
            let rc = unsafe {
                maple_render_handle_scene_linear_tile(
                    handle, *sx, *sy, 512, 512, 256, 256, 0, &mut buf,
                )
            };
            assert_eq!(rc, 0, "tile ({},{}) rc = {}", sx, sy, rc);
            assert_eq!(buf.width, 256);
            assert_eq!(buf.height, 256);
            unsafe { maple_free_scene_linear_buffer(&mut buf) };
        }
        unsafe { maple_close_raw_handle(handle) };
    }

    /// Handle opened with an XMP that sets dehaze != 0 propagates the
    /// dehaze rejection (rc=10) on tile render — the model is locked
    /// at handle-open time. Fixture-gated.
    #[test]
    fn raw_handle_with_dehaze_xmp_returns_rc10() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let xmp_path = std::env::temp_dir().join("handle-dehaze.xmp");
        std::fs::write(
            &xmp_path,
            r#"<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Dehaze="50"/></rdf:RDF></x:xmpmeta>"#,
        ).unwrap();
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let xmp_cstr = CString::new(xmp_path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), xmp_cstr.as_ptr(), &mut handle)
        };
        assert_eq!(rc, 0, "open rc = {}", rc);
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 10, "expected dehaze rc=10, got {}", rc);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
        let _ = std::fs::remove_file(&xmp_path);
    }

    /// Render handle rejects upscale (out > src) with rc=11.
    #[test]
    fn raw_handle_upscale_returns_rc11() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle(raw_cstr.as_ptr(), std::ptr::null(), &mut handle)
        };
        assert_eq!(rc, 0);
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 256, 256, 512, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 11, "out_w>src_w must rc=11, got {}", rc);
        unsafe { maple_close_raw_handle(handle) };
    }

    /// Bytes-variant open + render + close round-trip. Fixture-gated.
    #[test]
    fn raw_handle_bytes_round_trip() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).unwrap();
        let ext = CString::new("dng").unwrap();
        let mut handle: *mut MapleRawHandle = std::ptr::null_mut();
        let rc = unsafe {
            maple_open_raw_handle_bytes(
                bytes.as_ptr(), bytes.len(), ext.as_ptr(), std::ptr::null(), &mut handle,
            )
        };
        assert_eq!(rc, 0, "open_bytes rc = {}", rc);
        assert!(!handle.is_null());
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_handle_scene_linear_tile(
                handle, 1024, 1024, 512, 512, 256, 256, 0, &mut buf,
            )
        };
        assert_eq!(rc, 0);
        assert_eq!(buf.width, 256);
        assert_eq!(buf.height, 256);
        unsafe {
            maple_free_scene_linear_buffer(&mut buf);
            maple_close_raw_handle(handle);
        }
    }
}

// =============================================================================
// Panorama FFI surface (T2.3 accessors + T5.1 full lifecycle)
// Gated behind `--features pano`.  Without the feature: zero new symbols,
// zero new deps, byte-identical output.
//
// Error codes for pano_stitch (T5.1):
//   0   success
//  -1   invalid arguments (null pointers, n_inputs < 2)
//  -2   decode failure for one of the inputs
//  -3   stitch failure (ORB, matching, BA, warp, seam, blend pipeline error)
//  -4   output write failure (currently unused; reserved for future export path)
//
// DCP byte arrays (`dcps` / `dcp_lens`):
//   Accepted in the C ABI per spec § 6.2 but currently passed through as
//   `None` on the Rust side.  rawler reads embedded DCPs from the DNG
//   container itself; per-frame DCP override is a P5+ refinement.  The
//   parameters exist in the ABI to avoid a breaking change when that
//   refinement lands.
// =============================================================================

#[cfg(feature = "pano")]
pub mod pano {
    use half::f16;
    use pano_core::{
        ba::{homography::ransac_homography, lm::solve_with_keypoints},
        features::OrbDetector,
        matching::BruteForceMatcher,
        types::{Camera, Distortion, PanoImage},
        Blender, CpuWarper, FeatureDetector, FeatureMatcher, GraphCutSeamFinder,
        Matches, Projection, SeamFinder, Warper,
    };

    /// Configuration passed to `pano_stitch`.
    ///
    /// Fields mirror the C ABI struct so cbindgen/the build-script heredoc
    /// emits the right layout:
    ///   - `projection`:    0 = Rectilinear, 1 = Cylindrical, 2 = Spherical
    ///   - `parallax_mode`: 0 = Homography, 1 = TpsMesh (TPS unimplemented; ignored)
    ///   - `max_dimension`: long-edge clamp in pixels, 0 = unconstrained
    #[repr(C)]
    pub struct PanoOptions {
        pub projection: u32,
        pub parallax_mode: u32,
        pub max_dimension: u32,
    }

    /// Opaque handle wrapping a stitched panorama image and a precomputed
    /// f16 RGB pixel cache.
    ///
    /// # Safety
    /// All FFI functions that accept `*const PanoHandle` require that the
    /// pointer is non-null and that the pointed-to handle was constructed by
    /// `pano_stitch` (or `handle_from_image` in tests).  A null pointer
    /// always returns a null/zero result rather than dereferencing.
    pub struct PanoHandle {
        pub(crate) image: PanoImage,
        /// Eagerly-populated f16 interleaved RGB cache.
        /// Length == image.width * image.height * 3 (3 channels × f16).
        pub(crate) f16_cache: Vec<u16>,
    }

    // -----------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------

    /// Build a `PanoHandle` from a `PanoImage`, eagerly converting the f32 RGB
    /// pixels to f16 for the GPU-upload cache.
    pub fn handle_from_image(img: PanoImage) -> Box<PanoHandle> {
        let f16_cache: Vec<u16> = img.pixels
            .iter()
            .map(|&v| f16::from_f32(v).to_bits())
            .collect();
        Box::new(PanoHandle { image: img, f16_cache })
    }

    /// Run the classical stitching pipeline on two decoded `PanoImage`s.
    ///
    /// Mirrors the `stitch` function in `pano-smoke`'s binary.
    fn stitch_two(img_a: PanoImage, img_b: PanoImage) -> Result<PanoImage, String> {
        let image_size = (img_a.width.max(img_b.width), img_a.height.max(img_b.height));

        // Feature detection.
        let detector = OrbDetector::default();
        let feats_a = detector.detect(&img_a)
            .map_err(|e| format!("detect A: {e}"))?;
        let feats_b = detector.detect(&img_b)
            .map_err(|e| format!("detect B: {e}"))?;

        // Matching.
        let matcher = BruteForceMatcher::default();
        let matches = matcher.match_pairs(&feats_a, &feats_b)
            .map_err(|e| format!("match: {e}"))?;

        // Cameras — RANSAC + BA when enough matches, identity fallback otherwise.
        let cameras: Vec<Camera> = if matches.inliers.len() >= 8 {
            let (_, inlier_idxs) = ransac_homography(
                &feats_a.keypoints, &feats_b.keypoints, &matches.inliers, 3.0, 2000, 42,
            ).ok_or_else(|| "RANSAC failed".to_string())?;

            let ransac_matches = Matches {
                inliers: inlier_idxs.iter().map(|&i| matches.inliers[i]).collect(),
            };
            let pairs = vec![(
                0usize, 1usize,
                ransac_matches,
                feats_a.keypoints.clone(),
                feats_b.keypoints.clone(),
            )];
            solve_with_keypoints(2, &pairs, image_size, 42)
                .map_err(|e| format!("BA: {e}"))?
        } else {
            // Identity fallback — build the 3×3 identity matrix for both
            // cameras without pulling nalgebra into raw-ffi's direct deps.
            let focal = image_size.0.max(image_size.1) as f32;
            let identity = nalgebra::Matrix3::<f32>::identity();
            vec![
                Camera { focal, rotation: identity, distortion: Distortion::default() },
                Camera { focal, rotation: identity, distortion: Distortion::default() },
            ]
        };

        // Warp.
        let warper = CpuWarper::new();
        let warp = |img: &PanoImage, cam: &Camera| -> Result<PanoImage, String> {
            let warped = warper.warp(img, cam, Projection::Rectilinear)
                .map_err(|e| format!("warp: {e}"))?;
            // Embed into a canvas matching the input size if the warped result
            // is smaller (identity warp preserves dimensions).
            if warped.width == image_size.0 && warped.height == image_size.1 {
                return Ok(warped);
            }
            let mut canvas = PanoImage::new(image_size.0, image_size.1, img.color);
            for i in 0..(image_size.0 as usize * image_size.1 as usize) {
                canvas.validity.set(i, false);
            }
            let cw = warped.width.min(image_size.0) as usize;
            let ch = warped.height.min(image_size.1) as usize;
            for y in 0..ch {
                for x in 0..cw {
                    let si = y * warped.width as usize + x;
                    let di = y * image_size.0 as usize + x;
                    canvas.pixels[di * 3] = warped.pixels[si * 3];
                    canvas.pixels[di * 3 + 1] = warped.pixels[si * 3 + 1];
                    canvas.pixels[di * 3 + 2] = warped.pixels[si * 3 + 2];
                    if warped.validity[si] {
                        canvas.validity.set(di, true);
                    }
                }
            }
            Ok(canvas)
        };

        let warped_a = warp(&img_a, &cameras[0])?;
        let warped_b = warp(&img_b, &cameras[1])?;

        // Seam + blend.
        let seam_finder = GraphCutSeamFinder::new();
        let seams = seam_finder.seams(&[&warped_a, &warped_b])
            .map_err(|e| format!("seam: {e}"))?;

        let blender = pano_core::MultiBandBlender::default();
        let result = blender.blend(&[&warped_a, &warped_b], &seams)
            .map_err(|e| format!("blend: {e}"))?;

        Ok(result)
    }

    // -----------------------------------------------------------------
    // Public FFI surface
    // -----------------------------------------------------------------

    /// Stitch `n_inputs` RAW/PNG/JPEG byte slices into a panorama.
    ///
    /// # Arguments
    /// * `inputs`      — array of `n_inputs` pointers, each to a byte slice.
    /// * `input_lens`  — array of `n_inputs` byte-slice lengths.
    /// * `n_inputs`    — number of inputs (must be ≥ 2).
    /// * `dcps` — parallel array of DCP byte-slice pointers (may be null
    ///   entries); accepted in the ABI but currently ignored —
    ///   rawler reads embedded DCPs from the DNG container.
    /// * `dcp_lens` — lengths of the DCP slices (ignored alongside `dcps`).
    /// * `options`     — stitch options struct; may be null (defaults applied).
    /// * `out_handle`  — on success, receives a heap-allocated `*mut PanoHandle`.
    ///
    /// # Return value
    ///   0  success; `*out_handle` is non-null and caller-owned.
    ///  -1  invalid arguments (null inputs/out_handle, n_inputs < 2, null
    ///      element pointer).
    ///  -2  decode failure for one of the inputs.
    ///  -3  stitch pipeline failure (ORB / match / BA / warp / blend error).
    ///
    /// # Safety
    /// All input pointers must be valid for `n_inputs` reads.  `out_handle` must
    /// be non-null.  On success the caller owns the handle and must eventually
    /// call `pano_free`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_stitch(
        inputs: *const *const u8,
        input_lens: *const usize,
        n_inputs: usize,
        _dcps: *const *const u8,       // accepted, ignored (see module comment)
        _dcp_lens: *const usize,       // accepted, ignored
        _options: *const PanoOptions,  // accepted; defaults used for MVP
        out_handle: *mut *mut PanoHandle,
    ) -> i32 {
        // Validate outer args.
        if inputs.is_null() || input_lens.is_null() || out_handle.is_null() {
            return -1;
        }
        if n_inputs < 2 {
            return -1;
        }
        // Initialize out pointer defensively.
        *out_handle = std::ptr::null_mut();

        // Copy each input slice into owned Vecs while validating pointers.
        let mut owned: Vec<Vec<u8>> = Vec::with_capacity(n_inputs);
        for i in 0..n_inputs {
            let ptr = *inputs.add(i);
            let len = *input_lens.add(i);
            if ptr.is_null() {
                return -1;
            }
            owned.push(std::slice::from_raw_parts(ptr, len).to_vec());
        }

        // Decode each input.
        let mut images: Vec<PanoImage> = Vec::with_capacity(n_inputs);
        for bytes in &owned {
            match pano_core::decode_bytes(bytes) {
                Ok(img) => images.push(img),
                Err(_) => return -2,
            }
        }

        // For the MVP: stitch the first two images.
        // N > 2 inputs: pairwise composition is a P4+ refinement.
        let img_a = images.remove(0);
        let img_b = images.remove(0);

        let result = match stitch_two(img_a, img_b) {
            Ok(r) => r,
            Err(_) => return -3,
        };

        let handle = handle_from_image(result);
        *out_handle = Box::into_raw(handle);
        0
    }

    /// Return the panorama width in pixels.
    ///
    /// Returns 0 if `handle` is null.
    ///
    /// # Safety
    /// `handle` must be a non-null pointer to a live `PanoHandle`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_get_width(handle: *const PanoHandle) -> u32 {
        if handle.is_null() { return 0; }
        (*handle).image.width
    }

    /// Return the panorama height in pixels.
    ///
    /// Returns 0 if `handle` is null.
    ///
    /// # Safety
    /// `handle` must be a non-null pointer to a live `PanoHandle`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_get_height(handle: *const PanoHandle) -> u32 {
        if handle.is_null() { return 0; }
        (*handle).image.height
    }

    /// Return the number of f16 elements in the pixel buffer
    /// (`width * height * 3`; **elements**, not bytes).
    ///
    /// Returns 0 if `handle` is null.
    ///
    /// # Safety
    /// `handle` must be a non-null pointer to a live `PanoHandle`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_get_pixels_len(handle: *const PanoHandle) -> usize {
        if handle.is_null() { return 0; }
        (*handle).f16_cache.len()
    }

    /// Return a pointer to the f16 (half-precision, stored as `u16`) RGB
    /// pixel buffer owned by `handle`.
    ///
    /// The buffer is interleaved RGB f16, row-major, with
    /// `pano_get_pixels_len(handle)` elements.  The pointer is valid for
    /// the lifetime of the handle.
    ///
    /// Returns null if `handle` is null or the buffer is empty.
    ///
    /// # Safety
    /// `handle` must be a non-null pointer to a live `PanoHandle`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_get_pixels_f16(handle: *const PanoHandle) -> *const u16 {
        if handle.is_null() {
            return std::ptr::null();
        }
        let h = &*handle;
        if h.f16_cache.is_empty() {
            return std::ptr::null();
        }
        h.f16_cache.as_ptr()
    }

    /// Return a pointer to the f32 RGB pixel data owned by `handle`.
    ///
    /// The pixel buffer is interleaved RGB f32, row-major, with
    /// `handle.image.width * handle.image.height * 3` elements.
    /// The pointer is valid for the lifetime of the handle.
    /// Returns null if `handle` is null.
    ///
    /// # Safety
    /// `handle` must be a non-null pointer to a live `PanoHandle`.
    #[no_mangle]
    pub unsafe extern "C" fn pano_get_pixels_f32(handle: *const PanoHandle) -> *const f32 {
        if handle.is_null() {
            return std::ptr::null();
        }
        let h = &*handle;
        h.image.pixels.as_ptr()
    }

    /// Free a `PanoHandle` allocated by `pano_stitch`.
    ///
    /// No-op when `handle` is null.
    ///
    /// # Safety
    /// `handle` must be null or a pointer returned by `pano_stitch` that has
    /// not already been freed.
    #[no_mangle]
    pub unsafe extern "C" fn pano_free(handle: *mut PanoHandle) {
        if !handle.is_null() {
            drop(Box::from_raw(handle));
        }
    }

    // -----------------------------------------------------------------
    // Unit tests (lib-internal, no fixture required)
    // -----------------------------------------------------------------

    #[cfg(test)]
    mod tests {
        use super::*;
        use pano_core::{ColorSpace, PanoImage};

        fn make_test_image() -> PanoImage {
            let mut img = PanoImage::new(3, 1, ColorSpace::rec2020_d65_linear());
            img.pixels = vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
            img
        }

        #[test]
        fn pano_get_pixels_f32_returns_correct_pointer() {
            let handle = handle_from_image(make_test_image());
            let ptr = unsafe { pano_get_pixels_f32(&*handle) };
            assert!(!ptr.is_null());
            let r = unsafe { *ptr };
            let g = unsafe { *ptr.add(1) };
            let b = unsafe { *ptr.add(2) };
            assert!((r - 0.1).abs() < 1e-6, "R mismatch: {r}");
            assert!((g - 0.2).abs() < 1e-6, "G mismatch: {g}");
            assert!((b - 0.3).abs() < 1e-6, "B mismatch: {b}");
        }

        #[test]
        fn pano_get_pixels_f32_null_handle_returns_null() {
            let ptr = unsafe { pano_get_pixels_f32(std::ptr::null()) };
            assert!(ptr.is_null());
        }

        #[test]
        fn pano_get_pixels_f16_populated_after_handle_from_image() {
            let handle = handle_from_image(make_test_image());
            let ptr = unsafe { pano_get_pixels_f16(&*handle) };
            assert!(!ptr.is_null(), "f16 cache should be populated by handle_from_image");
            let len = unsafe { pano_get_pixels_len(&*handle) };
            assert_eq!(len, 9, "3×1 image has 9 RGB f16 elements");
        }

        #[test]
        fn pano_get_pixels_f16_null_handle_returns_null() {
            let ptr = unsafe { pano_get_pixels_f16(std::ptr::null()) };
            assert!(ptr.is_null());
        }

        #[test]
        fn pano_get_width_height_correct() {
            let handle = handle_from_image(PanoImage::new(7, 3, ColorSpace::rec2020_d65_linear()));
            let w = unsafe { pano_get_width(&*handle) };
            let h = unsafe { pano_get_height(&*handle) };
            assert_eq!(w, 7);
            assert_eq!(h, 3);
        }

        #[test]
        fn pano_get_pixels_len_is_w_times_h_times_3() {
            let handle = handle_from_image(PanoImage::new(4, 5, ColorSpace::rec2020_d65_linear()));
            let len = unsafe { pano_get_pixels_len(&*handle) };
            assert_eq!(len, 4 * 5 * 3);
        }

        #[test]
        fn pano_free_null_is_noop() {
            unsafe { pano_free(std::ptr::null_mut()) };
        }

        #[test]
        fn handle_from_image_preserves_dimensions() {
            let handle = handle_from_image(make_test_image());
            assert_eq!(handle.image.width, 3);
            assert_eq!(handle.image.height, 1);
            assert_eq!(handle.image.pixels.len(), 9);
        }

        /// Null pointer to pano_stitch returns -1.
        #[test]
        fn pano_stitch_null_inputs_returns_minus1() {
            let mut out: *mut PanoHandle = std::ptr::null_mut();
            let rc = unsafe {
                pano_stitch(
                    std::ptr::null(), std::ptr::null(), 2,
                    std::ptr::null(), std::ptr::null(),
                    std::ptr::null(),
                    &mut out,
                )
            };
            assert_eq!(rc, -1);
            assert!(out.is_null());
        }

        /// n_inputs < 2 returns -1.
        #[test]
        fn pano_stitch_single_input_returns_minus1() {
            let dummy: Vec<u8> = vec![0u8; 4];
            let ptrs: Vec<*const u8> = vec![dummy.as_ptr()];
            let lens: Vec<usize> = vec![dummy.len()];
            let mut out: *mut PanoHandle = std::ptr::null_mut();
            let rc = unsafe {
                pano_stitch(
                    ptrs.as_ptr(), lens.as_ptr(), 1,
                    std::ptr::null(), std::ptr::null(),
                    std::ptr::null(),
                    &mut out,
                )
            };
            assert_eq!(rc, -1);
            assert!(out.is_null());
        }

        /// Invalid (non-image) bytes return -2.
        #[test]
        fn pano_stitch_invalid_bytes_returns_minus2() {
            let garbage_a: Vec<u8> = vec![0xDEu8; 64];
            let garbage_b: Vec<u8> = vec![0xADu8; 64];
            let ptrs: Vec<*const u8> = vec![garbage_a.as_ptr(), garbage_b.as_ptr()];
            let lens: Vec<usize> = vec![garbage_a.len(), garbage_b.len()];
            let mut out: *mut PanoHandle = std::ptr::null_mut();
            let rc = unsafe {
                pano_stitch(
                    ptrs.as_ptr(), lens.as_ptr(), 2,
                    std::ptr::null(), std::ptr::null(),
                    std::ptr::null(),
                    &mut out,
                )
            };
            assert_eq!(rc, -2);
            assert!(out.is_null());
        }
    }
}
