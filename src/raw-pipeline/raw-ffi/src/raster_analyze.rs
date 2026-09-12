//! `maple_raster_analyze_buf` (#3507, Task G4): the read-only companion to
//! `maple_raster_pipeline_buf`. JSON request in, JSON reply out — see
//! `raw_core::raster_analyze` for the schema.
//!
//! Return codes: 0 ok, 1 null argument, 3 decode/probe failed, 5 request
//! parse failed, 99 panic caught, 100 `out_buf` too small (`*out_len` is set,
//! so a null-buffer call is a size probe). rc 3 vs 5 is picked by whether
//! `raw_core::raster_analyze::analyze`'s error message names the request
//! (a bad/unversioned/unknown request) or the container (a decode/probe
//! failure) — see the `message.contains("request")` check below.

use crate::error::{catch_panic_rc, set_last_error};
use raw_core::raster_analyze::analyze;
use std::ffi::{c_char, CStr};

const NEED_LARGER_BUFFER: i32 = 100;

/// # Safety
/// `input` must be valid for `input_len` bytes, `request_json` must be a
/// NUL-terminated string, and `out_len` must be non-null.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_analyze_buf(
    input: *const u8,
    input_len: usize,
    request_json: *const c_char,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_raster_analyze_buf", || {
        if input.is_null() || input_len == 0 || request_json.is_null() || out_len.is_null() {
            set_last_error("input, request or out_len is null".into());
            return 1;
        }
        let request = match CStr::from_ptr(request_json).to_str() {
            Ok(s) => s,
            Err(_) => {
                set_last_error("analyze request is not valid UTF-8".into());
                return 5;
            }
        };
        let reply = match analyze(std::slice::from_raw_parts(input, input_len), request) {
            Ok(json) => json,
            Err(e) => {
                let message = format!("{e}");
                set_last_error(message.clone());
                return if message.contains("request") { 5 } else { 3 };
            }
        };
        let bytes = reply.as_bytes();
        *out_len = bytes.len();
        if out_buf.is_null() || out_cap < bytes.len() {
            return NEED_LARGER_BUFFER;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
        0
    })
}

#[cfg(test)]
#[path = "raster_analyze_tests.rs"]
mod tests;
