//! Owned UTF-8 LCP import/resolution boundary for native hosts (#2435).
use crate::error::{set_last_error, with_large_stack};
use std::ffi::{c_char, CStr, CString};

/// Release imported profiles between jobs in an isolated native worker.
#[no_mangle]
pub extern "C" fn maple_lens_profile_clear_cache() -> i32 {
    match raw_core::lens_profile::clear_cache() {
        Ok(()) => 0,
        Err(error) => {
            set_last_error(error);
            8
        }
    }
}
unsafe fn output_json(out: *mut *mut c_char, result: Result<String, String>) -> i32 {
    match result {
        Ok(value) => {
            *out = CString::new(value).expect("JSON escapes NUL").into_raw();
            0
        }
        Err(error) => {
            set_last_error(error);
            8
        }
    }
}

/// Register bounded, user-owned LCP bytes. On success the host owns `out_json`
/// and must free it exactly once with `maple_free_lens_profile_json`.
#[no_mangle]
pub unsafe extern "C" fn maple_lens_profile_register(
    xml: *const u8,
    length: usize,
    out_json: *mut *mut c_char,
) -> i32 {
    if out_json.is_null() {
        return 1;
    }
    *out_json = std::ptr::null_mut();
    if xml.is_null() || length == 0 || length > 32 * 1024 * 1024 {
        set_last_error("Invalid LCP input length".into());
        return 1;
    }
    let xml = match std::str::from_utf8(std::slice::from_raw_parts(xml, length)) {
        Ok(xml) => xml,
        Err(error) => {
            set_last_error(error.to_string());
            return 2;
        }
    };
    output_json(
        out_json,
        raw_core::lens_profile::register(xml).map(|value| value.to_string()),
    )
}

#[no_mangle]
pub unsafe extern "C" fn maple_free_lens_profile_json(json: *mut c_char) {
    if !json.is_null() {
        drop(CString::from_raw(json));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_paths_clear_output_and_null_free_is_safe() {
        unsafe {
            let mut output = std::ptr::dangling_mut();
            assert_eq!(
                maple_lens_profile_register(std::ptr::null(), 0, &mut output),
                1
            );
            assert!(output.is_null());
            let invalid = [0xff];
            assert_eq!(
                maple_lens_profile_register(invalid.as_ptr(), 1, &mut output),
                2
            );
            assert!(output.is_null());
            maple_free_lens_profile_json(output);
        }
    }
}
