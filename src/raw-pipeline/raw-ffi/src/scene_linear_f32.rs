//! Scene-linear Rec.2020 f32 RGBA render entries (#482).
//!
//! f32 sibling of `scene_linear.rs`. Mirrors the four fp16 entries
//! (file/bytes × full/sized) returning `MapleSceneLinearBufferF32` so
//! consumers can hold the scene-linear buffer at full f32 precision
//! end-to-end (#416). The fp16 entries are kept intact — Apple still
//! consumes them today; the per-tick FFI chain is fp16 in/out, so
//! migrating Apple's render path alone would silently round-trip back
//! to fp16 every slider tick. Apple migration is tracked as a separate
//! ticket once `maple_apply_scene_linear_chain` grows an f32 sibling.
//! Web consumes f32 directly (RGBA32F FBOs).
//!
//! Split out of `scene_linear.rs` so each file stays under the 600-LOC
//! budget. The strip / dehaze-guard contract documented in
//! `scene_linear.rs` applies here too.

use crate::buffers::MapleSceneLinearBufferF32;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::decode::decode_bytes;
use std::ffi::{CStr, c_char};

// The module-level doc-comment above captures the rationale; the
// detailed prose that lived here in the pre-split file has been folded
// into it to avoid duplication.

/// f32 sibling of [`maple_render_file_scene_linear`]. Identical inputs
/// and error codes; the output buffer is [`MapleSceneLinearBufferF32`]
/// (16 bytes per pixel) instead of the fp16 surface.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBufferF32,
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
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
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
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(out_ptr, w, h, f32_rgba);
        0
    })
}

/// f32 sibling of [`maple_render_bytes_scene_linear`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBufferF32,
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
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
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
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality_f32(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(out_ptr, w, h, f32_rgba);
        0
    })
}

/// f32 sibling of [`maple_render_file_scene_linear_sized`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_sized_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBufferF32,
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
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
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
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(out_ptr, w, h, f32_rgba);
        0
    })
}

/// f32 sibling of [`maple_render_bytes_scene_linear_sized`].
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_sized_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBufferF32,
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
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
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
        let (w, h, f32_rgba) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        write_scene_linear_buf_f32(out_ptr, w, h, f32_rgba);
        0
    })
}

/// f32 counterpart to [`write_scene_linear_buf`]. Boxes the `Vec<f32>` and
/// hands the raw parts to the caller in a [`MapleSceneLinearBufferF32`].
pub(crate) fn write_scene_linear_buf_f32(out_ptr: usize, w: u32, h: u32, f32_rgba: Vec<f32>) {
    let (f32_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack_f32", || {
        let mut boxed = f32_rgba.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n, n * std::mem::size_of::<f32>())
    });
    unsafe {
        *(out_ptr as *mut MapleSceneLinearBufferF32) =
            MapleSceneLinearBufferF32 {
                f32_rgba: f32_ptr,
                len_bytes,
                channels: 4,
                bytes_per_pixel: 16,
                width: w,
                height: h,
            };
    }
}
