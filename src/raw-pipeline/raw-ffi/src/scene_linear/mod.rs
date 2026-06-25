//! Scene-linear Rec.2020 fp16 RGBA render entries — full, sized, and tile.
//!
//! Output is pre-AgX, pre-Rec.2020→sRGB scene-linear; the caller is
//! expected to apply a view transform and gamut convert before display.
//!
//! Strip contract (moved from Rust to Swift in #124):
//! These entries deliberately do NOT mutate the parsed `AdjustmentModel`.
//! Apple's per-tick GPU chain re-applies several stages (white balance,
//! scene tone, vibrance, saturation, clarity, texture, dehaze,
//! nr_luminance, AgX, sharpen, nr_color); to avoid double-execution the
//! Apple Swift binding (`MapleCore/Sources/MapleCore/RawCoreBridge.swift`)
//! pre-strips those fields and writes a temp XMP that gets passed in via
//! `xmp_path`. The FFI honours whatever model the XMP contains; the
//! decision of what to strip lives where the GPU-chain knowledge lives
//! (i.e. the Swift side).
//!
//! Tile dehaze guard stays on the Rust side because it's a safety gate
//! (full-image dark-channel computation that can't run on a crop tile),
//! not GPU-chain knowledge.
//!
//! Auto Profile / auto-exposure contract (#871 × #927 — see #1174):
//! under `Profile::Auto` every entry in this module (and the f32
//! siblings) forces `auto_exposure: Off` when the file's embedded
//! preview is extractable (`force_ae_off_if_auto_will_fit_*`), because
//! the fitted Auto Profile tail owns the scene→JPEG brightness
//! re-anchor. Since #927 made preview extraction work in-process, that
//! is effectively *every* preview-bearing RAW on *every* platform — not
//! just shells with exiftool. Consumers of these buffers MUST therefore
//! apply the fitted tail (curve∘residual cube via
//! `maple_compute_auto_profile_lut`, as the Apple `EditSession` does)
//! before treating the render as display-faithful, or pass an XMP whose
//! profile is `Neutral` to keep auto-exposure in the decode. An Auto
//! buffer rendered without the tail is darker than the app by the full
//! AE anchor gain (typically 2–3×).

use crate::buffers::MapleSceneLinearBuffer;
use crate::error::{set_last_error, with_large_stack};
use crate::model::{
    force_ae_off_if_auto_will_fit_bytes, force_ae_off_if_auto_will_fit_path, load_xmp_model_owned,
    LoadModel,
};
use raw_core::decode::decode_bytes;
use std::ffi::{c_char, CStr};

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
        Err(e) => {
            set_last_error(format!("raw_path not UTF-8: {}", e));
            return 2;
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_path not UTF-8: {}", e));
                return 3;
            }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))
        {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 6;
            }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit,
        // so the Apple displayed buffer matches the CLI/WASM buffer the curve
        // was authored against (the cube applies the curve on top — without
        // this the AE-lift and curve-lift stack and Auto highlights blow out).
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        write_scene_linear_buf(out_ptr, w, h, fp16);
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
            Err(e) => {
                set_last_error(format!("hint_ext not UTF-8: {}", e));
                return 2;
            }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_path not UTF-8: {}", e));
                return 3;
            }
        }
    };
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&input, &ext_owned)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit
        // (see the file-source entry above for the rationale).
        let model = force_ae_off_if_auto_will_fit_bytes(&model, &input, &ext_owned);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        write_scene_linear_buf(out_ptr, w, h, fp16);
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
/// Plan 1 v2 — see .archived-plans/plans/2026-04-24-ffi-split-plan-1.md
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
        Err(e) => {
            set_last_error(format!("raw_path not UTF-8: {}", e));
            return 2;
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_path not UTF-8: {}", e));
                return 3;
            }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))
        {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 6;
            }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_path(&model, raw_path);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img,
            &model,
            quality,
            max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        write_scene_linear_buf(out_ptr, w, h, fp16);
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
            Err(e) => {
                set_last_error(format!("hint_ext not UTF-8: {}", e));
                return 2;
            }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => {
                set_last_error(format!("xmp_path not UTF-8: {}", e));
                return 3;
            }
        }
    };
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match load_xmp_model_owned(xmp_path_str.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(rc) => return rc,
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || {
            decode_bytes(&input, &ext_owned)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let quality = match quality_preview {
            1 => raw_core::pipeline::RenderQuality::Preview,
            2 => raw_core::pipeline::RenderQuality::Amaze,
            _ => raw_core::pipeline::RenderQuality::Full,
        };
        // #871: force auto_exposure Off when an Auto Profile curve will fit.
        let model = force_ae_off_if_auto_will_fit_bytes(&model, &input, &ext_owned);
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img,
            &model,
            quality,
            max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => {
                set_last_error(format!("render: {}", e));
                return 8;
            }
        };
        write_scene_linear_buf(out_ptr, w, h, fp16);
        0
    })
}

pub(crate) mod tile;
// Re-exported so `scene_linear_tests.rs` can import them as
// `crate::scene_linear::maple_render_{bytes,file}_scene_linear_tile`.
// Rust's unused-import lint fires because the parent module is private,
// but these are also `#[no_mangle] extern "C"` symbols (always exported
// to C) and are exercised by the test module above.
#[allow(unused_imports)]
pub use tile::{maple_render_bytes_scene_linear_tile, maple_render_file_scene_linear_tile};

/// Pack a (w, h, fp16) tuple into the caller-provided
/// `MapleSceneLinearBuffer`. Marked `pub(crate)` because the handle
/// module reuses it. The `out_ptr` is passed as `usize` (cast from
/// `*mut MapleSceneLinearBuffer`) so the worker thread can carry it
/// across the `Send` boundary.
pub(crate) fn write_scene_linear_buf(out_ptr: usize, w: u32, h: u32, fp16: Vec<u16>) {
    let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
        let mut boxed = fp16.into_boxed_slice();
        let p = boxed.as_mut_ptr();
        let n = boxed.len();
        std::mem::forget(boxed);
        (p, n, n * std::mem::size_of::<u16>())
    });
    unsafe {
        *(out_ptr as *mut MapleSceneLinearBuffer) = MapleSceneLinearBuffer {
            fp16_rgba: fp16_ptr,
            len_bytes,
            channels: 4,
            bytes_per_pixel: 8,
            width: w,
            height: h,
        };
    }
}
