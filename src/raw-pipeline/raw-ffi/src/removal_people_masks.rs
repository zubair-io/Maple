//! Thin binary-mask role boundary; policy/codec stay in raw-core.
use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

/// Refine reviewed person suggestions using concatenated MIMF masks. The
/// schema-1 request supplies mask_lengths in detection order. Output is JSON.
/// Codes: 0 success, 1 null required input, 5 invalid request, 100 size probe.
/// # Safety
/// request is NUL-terminated UTF-8. Nonempty masks is readable for masks_len;
/// out_len is writable. Non-null out is writable for cap and disjoint from inputs.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_people_mask_suggestions_buf(
    request: *const c_char,
    masks: *const u8,
    masks_len: usize,
    out: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_people_mask_suggestions_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() || (masks_len > 0 && masks.is_null()) {
            return 1;
        }
        if masks_len > isize::MAX as usize || cap > isize::MAX as usize {
            set_last_error("person mask suggestions: invalid buffer lengths".into());
            return 5;
        }
        let bytes = if masks_len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(masks, masks_len)
        };
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("person mask suggestions: invalid UTF-8: {e}"))
            .and_then(|request| {
                raw_core::stages::removal_people_masks::suggest_json(request, bytes)
            });
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                set_last_error(error);
                return 5;
            }
        };
        *out_len = result.len();
        if out.is_null() || cap < result.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(result.as_ptr(), out, result.len());
        0
    })
}

#[cfg(test)]
#[path = "removal_people_masks_tests.rs"]
mod tests;
