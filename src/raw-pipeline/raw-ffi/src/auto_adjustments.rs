//! Auto Adjustments FFI — one-shot eight-slider recommendation from a RAW file.
//!
//! Phase M0: all eight fields populated from a single AE-Off/D65 probe.
//! See the design contract in `raw-core/src/stages/auto_adjustments.rs`.
//!
//! Entry point: `maple_compute_auto_adjustments` — a raw-path entry that
//! accepts a RAW file path + optional XMP sidecar path, decodes the RAW,
//! runs the AE-Off/D65 probe develop internally (Apple cannot hand in an
//! AE-Off buffer; the file-path API lets the core own the full decode),
//! and returns all eight slider recommendations in a flat C struct.
//!
//! Mirrors `auto_tone.rs` structurally but returns eight f32 fields
//! (exposure + temperature + tint + five tone sliders) vs the six in
//! `MapleAutoTone`.
//!
//! AE-Off probe / exposure-replaces-anchor contract:
//!   The returned `exposure` is relative to the AE-Off base. The Apple
//!   consumer **must** set `auto_exposure = Off` together with
//!   `exposure = out.exposure` — see the raw-core module doc.

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::stages::auto_adjustments::{compute_auto_adjustments, AutoAdjustments};
use std::ffi::c_char;

/// FFI return type for [`maple_compute_auto_adjustments`]. Plain C struct so
/// the Apple Swift binding (`MapleCore`) can mirror it 1:1. Eight f32 fields
/// in display-range units: exposure in EV, temperature in Kelvin, tint and
/// the five tone sliders in ±100 slider units.
///
/// The `#[repr(C)]` layout is:
///   offset 0  f32 exposure
///   offset 4  f32 temperature
///   offset 8  f32 tint
///   offset 12 f32 contrast
///   offset 16 f32 highlights
///   offset 20 f32 shadows
///   offset 24 f32 whites
///   offset 28 f32 blacks
#[repr(C)]
pub struct MapleAutoAdjustments {
    pub exposure: f32,
    pub temperature: f32,
    pub tint: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
}

/// Compute Auto Adjustment slider values for a RAW file.
///
/// Decodes the RAW at `raw_path`, optionally loads the XMP sidecar at
/// `xmp_path` (pass NULL for a fresh-open recommendation), then develops
/// a single AE-Off/D65 probe buffer and derives all eight fields.
///
/// `quality_preview` controls the develop quality:
///   - `1` → Preview (half-res, fast — recommended for UI integration).
///   - `0` → Full (full-res, slower but more accurate for high-MP bodies).
///
/// Returns:
/// - `0` on success — `*out` is populated with all eight finite fields.
/// - `1` on a null pointer for `raw_path` or `out`.
/// - `2` when `raw_path` is not valid UTF-8.
/// - `3` when the RAW file cannot be read or decoded (check `maple_last_error`).
/// - `4` when the XMP file cannot be parsed (check `maple_last_error`).
/// - `5` when the XMP file cannot be read (check `maple_last_error`).
///
/// On error, `maple_last_error()` returns a UTF-8 description.
///
/// # Safety
/// - `raw_path` must be a valid, NUL-terminated C string for the duration
///   of the call.
/// - `xmp_path` must be a valid, NUL-terminated C string **or** NULL.
/// - `out` must be a pointer to a writable `MapleAutoAdjustments`.
#[no_mangle]
pub unsafe extern "C" fn maple_compute_auto_adjustments(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleAutoAdjustments,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        return 1;
    }

    // Convert raw_path to a Rust &str.
    let raw_cstr = unsafe { std::ffi::CStr::from_ptr(raw_path) };
    let raw_str = match raw_cstr.to_str() {
        Ok(s) => s,
        Err(_) => {
            set_last_error("raw_path is not valid UTF-8".into());
            return 2;
        }
    };
    let raw_path_owned = raw_str.to_owned();

    // Convert xmp_path (nullable) to an Option<String>.
    let xmp_path_owned: Option<String> = if xmp_path.is_null() {
        None
    } else {
        let xmp_cstr = unsafe { std::ffi::CStr::from_ptr(xmp_path) };
        match xmp_cstr.to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(_) => {
                set_last_error("xmp_path is not valid UTF-8".into());
                return 2;
            }
        }
    };

    let quality_preview_flag = quality_preview != 0;
    // Cast `out` to `usize` so it can cross the thread boundary in `with_large_stack`.
    // The pointer remains valid for the lifetime of the function because the C caller
    // must keep the `MapleAutoAdjustments` allocated until the call returns.
    let out_usize = out as usize;

    with_large_stack(move || {
        // Safety: cast the usize back to the original pointer. The caller
        // guarantees that `out` remains valid for the duration of this call
        // (same as every other FFI entry in this crate).
        let out_ptr = out_usize as *mut MapleAutoAdjustments;

        // Load the XMP model (or default).
        let model = match load_xmp_model_owned(xmp_path_owned.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(code) => return code,
        };

        // Read the RAW file.
        let raw_bytes = match std::fs::read(&raw_path_owned) {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 3;
            }
        };

        let raw_path_buf = std::path::Path::new(&raw_path_owned);
        let ext = raw_path_buf
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        // Decode the RAW.
        let raw_img = match raw_core::decode::decode_bytes(&raw_bytes, ext) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("raw decode: {}", e));
                return 3;
            }
        };

        // `compute_auto_adjustments` always uses Preview quality internally
        // for speed. The `quality_preview` arg is accepted for API forward-
        // compat but is not plumbed past this point in M0.
        let _ = quality_preview_flag; // reserved for future use

        // Compute the recommendations.
        let result: AutoAdjustments = match compute_auto_adjustments(&raw_img, &model) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("auto_adjustments: {}", e));
                return 3;
            }
        };

        // Write out via the reconstructed pointer.
        unsafe {
            *out_ptr = MapleAutoAdjustments {
                exposure: result.exposure,
                temperature: result.temperature,
                tint: result.tint,
                contrast: result.contrast,
                highlights: result.highlights,
                shadows: result.shadows,
                whites: result.whites,
                blacks: result.blacks,
            };
        }
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn null_raw_path_returns_error() {
        let mut out = MapleAutoAdjustments {
            exposure: 0.0,
            temperature: 6500.0,
            tint: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
        };
        let rc = unsafe {
            maple_compute_auto_adjustments(
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut out as *mut MapleAutoAdjustments,
            )
        };
        assert_eq!(rc, 1);
    }

    #[test]
    fn null_out_returns_error() {
        let raw_path = CString::new("/nonexistent.dng").unwrap();
        let rc = unsafe {
            maple_compute_auto_adjustments(
                raw_path.as_ptr(),
                std::ptr::null(),
                1,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(rc, 1);
    }

    #[test]
    fn nonexistent_raw_returns_error() {
        let raw_path = CString::new("/nonexistent_auto_adj_test.dng").unwrap();
        let mut out = MapleAutoAdjustments {
            exposure: 0.0,
            temperature: 6500.0,
            tint: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
        };
        let rc = unsafe {
            maple_compute_auto_adjustments(
                raw_path.as_ptr(),
                std::ptr::null(),
                1,
                &mut out as *mut MapleAutoAdjustments,
            )
        };
        // Should return 3 (RAW read/decode error).
        assert_eq!(rc, 3, "expected rc=3 for nonexistent RAW, got {}", rc);
    }
}
