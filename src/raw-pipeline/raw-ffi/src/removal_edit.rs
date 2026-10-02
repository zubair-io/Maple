//! Cold saved-operation controls (#3984), with checked UTF-8 and output probes.
use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

unsafe fn write(
    result: Result<String, String>,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    match result {
        Err(error) => {
            set_last_error(error);
            5
        }
        Ok(value) => {
            *length = value.len();
            if output.is_null() || cap < value.len() {
                return 100;
            }
            std::ptr::copy_nonoverlapping(value.as_ptr(), output, value.len());
            0
        }
    }
}

/// List supported saved operations, including enable and dependency-review state.
/// Codes: 0 success, 1 null input, 5 invalid records, 99 panic, 100 size probe.
/// # Safety
/// records is NUL-terminated UTF-8; length is writable. Non-null output is
/// writable for cap bytes and disjoint from both input and length.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_list_buf(
    records: *const c_char,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_saved_list_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        if records.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(records)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(raw_core::pipeline::saved_removal_list);
        write(result, output, cap, length)
    })
}

/// Produce one proposed enable/delete/replace transition; no asset or XMP I/O.
/// Return codes and buffer semantics match maple_removal_saved_list_buf.
/// # Safety
/// records/request are NUL-terminated UTF-8; length is writable. Non-null
/// output is writable for cap bytes and disjoint from inputs and length.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_edit_buf(
    records: *const c_char,
    request: *const c_char,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_saved_edit_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        if records.is_null() || request.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(records)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|records| {
                CStr::from_ptr(request)
                    .to_str()
                    .map_err(|e| e.to_string())
                    .and_then(|request| raw_core::pipeline::edit_saved_removal(records, request))
            });
        write(result, output, cap, length)
    })
}

/// Return only the preceding generation stack for an in-place replacement.
/// Return codes and buffer semantics match maple_removal_saved_list_buf.
/// # Safety
/// records/id are NUL-terminated UTF-8; length is writable. Non-null output
/// is writable for cap bytes and disjoint from inputs and length.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_prefix_buf(
    records: *const c_char,
    id: *const c_char,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_saved_prefix_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        if records.is_null() || id.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(records)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|records| {
                CStr::from_ptr(id)
                    .to_str()
                    .map_err(|e| e.to_string())
                    .and_then(|id| raw_core::pipeline::saved_removal_prefix(records, id))
            });
        write(result, output, cap, length)
    })
}

#[cfg(test)]
#[path = "removal_edit_tests.rs"]
mod tests;
