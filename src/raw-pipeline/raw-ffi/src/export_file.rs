//! Multi-format developed export FFI (#2584) — `maple_export_developed_to_file`.
//!
//! The canonical exporter (`raw_core::export`, #943 — JPEG / 16-bit TIFF /
//! PNG with ICC tagging and a long-edge cap) was reachable from the web via
//! `raw_wasm::export_bytes` and from Apple via platform encoders, but had no
//! C-ABI shim — so the WinUI export dialog was stuck on the JPEG-only
//! developed-preview entry. This wraps it with the same string contracts the
//! wasm entry uses (`format`, `color_space`), so `ExportFormat::from_str`
//! stays the single parser, plus the file-output convention of
//! `maple_render_develop_jpeg_to_file` (atomic .tmp + rename, Rust owns every
//! allocation).

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::export::{export_from_raw, ExportFormat, ExportOptions};
use raw_core::pipeline::RawInput;
use raw_core::view::encode::TargetPrimaries;
use std::ffi::{c_char, CStr};

/// Develop `raw_path` with `xmp_path` applied (null = neutral defaults) and
/// encode to `out_path` in the requested deliverable format.
///
/// - `format` — `"jpeg"`, `"tiff"` (16-bit) or `"png"` (case per
///   `ExportFormat::from_str`).
/// - `quality` — JPEG quality in [1, 100]; 0 selects the canonical dialog
///   default (92). Ignored by the lossless formats.
/// - `color_space` — `"display-p3"` selects Display P3 primaries (and ICC
///   tag); anything else selects sRGB. Same spelling as the wasm entry.
/// - `max_long_edge` — long-edge cap in pixels; 0 renders native resolution.
///   Never upscales.
///
/// Always `RenderQuality::Amaze` (inside `export_from_raw`) — export favours
/// quality over latency. Returns 0 on success; non-zero on error (call
/// `maple_last_error`). The parent dir of `out_path` must exist.
///
/// # Safety
/// All pointer arguments must be valid NUL-terminated strings (or null where
/// documented) for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_export_developed_to_file(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    format: *const c_char,
    quality: u8,
    color_space: *const c_char,
    max_long_edge: u32,
    out_path: *const c_char,
) -> i32 {
    if raw_path.is_null() || format.is_null() || out_path.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if quality > 100 {
        set_last_error(format!("quality must be in [1, 100] (got {})", quality));
        return 14;
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
    let out_path_str = match CStr::from_ptr(out_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("out_path not UTF-8: {}", e));
            return 4;
        }
    };
    let format_str = match CStr::from_ptr(format).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("format not UTF-8: {}", e));
            return 5;
        }
    };
    let color_space_str = if color_space.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(color_space).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => {
                set_last_error(format!("color_space not UTF-8: {}", e));
                return 5;
            }
        }
    };
    let Some(export_format) = ExportFormat::from_str(&format_str) else {
        set_last_error(format!(
            "unsupported format '{}' (expected jpeg | tiff | png)",
            format_str
        ));
        return 5;
    };
    let q = if quality == 0 { 92 } else { quality };

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
            raw_core::decode::decode_bytes(&raw_bytes, ext)
        }) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("decode: {}", e));
                return 7;
            }
        };
        let options = ExportOptions {
            format: export_format,
            quality: q,
            target: if color_space_str == "display-p3" {
                TargetPrimaries::P3
            } else {
                TargetPrimaries::Srgb
            },
            max_long_edge: (max_long_edge > 0).then_some(max_long_edge),
        };
        let exported = match export_from_raw(
            &raw_img,
            &model,
            Some(RawInput::Bytes {
                bytes: &raw_bytes,
                ext,
            }),
            &options,
        ) {
            Ok(e) => e,
            Err(e) => {
                set_last_error(format!("export: {}", e));
                return 8;
            }
        };

        // Atomic write: .tmp + rename, matching the develop-JPEG entry.
        let out_path = std::path::Path::new(&out_path_str);
        let mut tmp_path = std::ffi::OsString::from(out_path);
        tmp_path.push(".tmp");
        let tmp_path = std::path::PathBuf::from(tmp_path);
        if let Err(e) = std::fs::write(&tmp_path, &exported.bytes) {
            set_last_error(format!("tmp write: {}", e));
            return 12;
        }
        if let Err(e) = std::fs::rename(&tmp_path, out_path) {
            let _ = std::fs::remove_file(&tmp_path);
            set_last_error(format!("rename: {}", e));
            return 13;
        }
        0
    })
}
