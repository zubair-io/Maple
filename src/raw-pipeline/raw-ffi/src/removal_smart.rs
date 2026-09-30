//! Shared Smart paint boundary (#3942), outside live grading.
use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

unsafe fn write_result(
    result: Result<Vec<u8>, String>,
    out: *mut u8,
    cap: usize,
    len: *mut usize,
) -> i32 {
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            set_last_error(error);
            return 5;
        }
    };
    *len = bytes.len();
    if out.is_null() || cap < bytes.len() {
        return 100;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
    0
}

/// Return JSON model-space points/labels for a source-space Smart paint request.
/// Codes: 0 success, 1 null input, 5 invalid request, 99 panic, 100 size probe.
/// Output is length-delimited UTF-8, not NUL-terminated.
///
/// # Safety
/// request is NUL-terminated UTF-8, out_len is writable, and non-null out is
/// writable for cap bytes. All input/output buffers must be disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_smart_prompts_buf(
    request: *const c_char,
    out: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_smart_prompts_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("smart selection: invalid UTF-8: {e}"))
            .and_then(raw_core::stages::removal_smart::model_prompts_json)
            .map(String::into_bytes);
        write_result(result, out, cap, out_len)
    })
}

/// Prepare bounded add/erase prompts from ordered source-space brush gestures.
/// Output is a schema-1 request reused for model prompts and mask validation.
/// Same return codes as maple_removal_smart_prompts_buf.
///
/// # Safety
/// request is NUL-terminated UTF-8, out_len is writable, and non-null out is
/// writable for cap bytes. Input/output buffers must be disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_smart_strokes_buf(
    request: *const c_char,
    out: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_smart_strokes_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("smart selection: invalid UTF-8: {e}"))
            .and_then(raw_core::stages::removal_smart::prepare_strokes_json)
            .map(String::into_bytes);
        write_result(result, out, cap, out_len)
    })
}

/// Validate four 1024-square model candidates and return native MIMF intent.
/// A code-5 result must retain the previous UI selection. Same codes as above.
///
/// # Safety
/// request is NUL-terminated UTF-8; logits and scores are aligned readable f32
/// buffers of their declared lengths. out_len is writable; non-null out is
/// writable for cap bytes. Input/output buffers are disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_smart_mask_buf(
    request: *const c_char,
    logits: *const f32,
    logits_len: usize,
    scores: *const f32,
    scores_len: usize,
    out: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_smart_mask_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() || logits.is_null() || scores.is_null() {
            return 1;
        }
        // Validate lengths before constructing slices from external pointers.
        if logits_len != 4 * 1024 * 1024 || scores_len != 4 {
            set_last_error("smart selection: invalid candidate shape".into());
            return 5;
        }
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("smart selection: invalid UTF-8: {e}"))
            .and_then(|request| {
                raw_core::stages::removal_smart::mask_from_logits_json(
                    request,
                    std::slice::from_raw_parts(logits, logits_len),
                    std::slice::from_raw_parts(scores, scores_len),
                )
            });
        write_result(result, out, cap, out_len)
    })
}

#[cfg(test)]
#[path = "removal_smart_tests.rs"]
mod tests;
