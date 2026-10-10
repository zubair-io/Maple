//! Cold RAW/companion preparation for the retained tile owner (#3955).
use super::*;
use crate::model::{load_xmp_model_owned, LoadModel};
use raw_core::decode::decode_bytes;
use std::ffi::{c_char, CStr};

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
    let handle_out_addr = handle_out as usize;
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
        let saved = match crate::removal_file::prepare_saved(
            &raw_img,
            &raw_bytes,
            &model,
            raw_path.parent(),
        ) {
            None => None,
            Some(Ok((saved, _))) => Some(saved),
            Some(Err(error)) => {
                set_last_error(error.to_string());
                return 8;
            }
        };
        let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(&raw_bytes);
        let inner = Box::new(MapleRawHandleInner::new(raw_img, model, original, saved));
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
    let handle_out_addr = handle_out as usize;
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
        let saved = match crate::removal_file::prepare_saved(
            &raw_img,
            &input,
            &model,
            xmp_path_str
                .as_deref()
                .and_then(|path| std::path::Path::new(path).parent()),
        ) {
            None => None,
            Some(Ok((saved, _))) => Some(saved),
            Some(Err(error)) => {
                set_last_error(error.to_string());
                return 8;
            }
        };
        let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(&input);
        let inner = Box::new(MapleRawHandleInner::new(raw_img, model, original, saved));
        let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
        let handle = Box::new(MapleRawHandle { inner: inner_ptr });
        unsafe {
            *(handle_out_addr as *mut *mut MapleRawHandle) = Box::into_raw(handle);
        }
        0
    })
}
