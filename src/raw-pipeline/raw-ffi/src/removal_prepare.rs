//! Host marshalling for shared accepted-record preparation (#3936).
use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

/// Hash immutable source/model/companion bytes once at the preparation boundary.
/// Returns 0 success, 1 null input/output, 5 oversized input, 100 capacity <71.
/// Writes 71 UTF-8 bytes (blake3: plus lowercase hex), without a NUL terminator.
///
/// # Safety
/// input is readable for len bytes; output is writable for cap bytes and does
/// not overlap input. Null input is allowed only when len=0.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_content_digest(
    input: *const u8,
    len: usize,
    output: *mut u8,
    cap: usize,
) -> i32 {
    catch_panic_rc("maple_removal_content_digest", || {
        if (input.is_null() && len != 0) || output.is_null() {
            return 1;
        }
        if len > isize::MAX as usize {
            return 5;
        }
        if cap < 71 {
            return 100;
        }
        let bytes = if len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(input, len)
        };
        let digest = raw_core::types::accepted_removal::ContentDigest::for_bytes(bytes);
        std::ptr::copy_nonoverlapping(digest.as_str().as_ptr(), output, 71);
        0
    })
}

/// Prepare a complete proposed InpaintRemovals attribute, after asset checks.
/// Returns 0 success, 1 null, 5 invalid input, 99 caught panic, 100 size probe.
/// out_len is the UTF-8 byte length; no terminating NUL is included.
///
/// # Safety
/// request and prior are NUL-terminated UTF-8; mask and patch are readable for
/// their lengths. out_len is writable, and non-null output is writable for cap
/// bytes. All buffers are disjoint and lengths do not exceed isize::MAX.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_prepare_buf(
    request: *const c_char,
    prior: *const c_char,
    mask: *const u8,
    mask_len: usize,
    patch: *const u8,
    patch_len: usize,
    output: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_prepare_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() || prior.is_null() || mask.is_null() || patch.is_null() {
            return 1;
        }
        if mask_len > isize::MAX as usize || patch_len > isize::MAX as usize {
            return 5;
        }
        let result = CStr::from_ptr(request)
            .to_str()
            .and_then(|request| CStr::from_ptr(prior).to_str().map(|prior| (request, prior)))
            .map_err(|e| format!("removal preparation: invalid UTF-8: {e}"))
            .and_then(|(request, prior)| {
                raw_core::pipeline::prepare_accepted_removal(
                    request,
                    prior,
                    std::slice::from_raw_parts(mask, mask_len),
                    std::slice::from_raw_parts(patch, patch_len),
                )
            });
        match result {
            Err(e) => {
                set_last_error(e);
                5
            }
            Ok(value) => {
                *out_len = value.len();
                if output.is_null() || cap < value.len() {
                    return 100;
                }
                std::ptr::copy_nonoverlapping(value.as_ptr(), output, value.len());
                0
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_digest_uses_identical_bytes_and_never_writes_past_capacity() {
        let mut output = [42; 72];
        unsafe {
            assert_eq!(
                maple_removal_content_digest(
                    b"immutable source".as_ptr(),
                    16,
                    output.as_mut_ptr(),
                    70
                ),
                100
            );
            assert_eq!(output, [42; 72]);
            assert_eq!(
                maple_removal_content_digest(
                    b"immutable source".as_ptr(),
                    16,
                    output.as_mut_ptr(),
                    71
                ),
                0
            );
        }
        assert_eq!(
            &output[..71],
            raw_core::types::accepted_removal::ContentDigest::for_bytes(b"immutable source")
                .as_str()
                .as_bytes()
        );
        assert_eq!(output[71], 42);
    }

    #[test]
    fn invalid_preparation_clears_length_without_touching_output() {
        let mut len = 123;
        let mut output = [42; 16];
        unsafe {
            assert_eq!(
                maple_removal_prepare_buf(
                    c"{}".as_ptr(),
                    c"[]".as_ptr(),
                    b"bad mask".as_ptr(),
                    8,
                    b"bad patch".as_ptr(),
                    9,
                    output.as_mut_ptr(),
                    16,
                    &mut len
                ),
                5
            );
            assert_eq!(len, 0);
            assert_eq!(output, [42; 16]);
            assert_eq!(
                maple_removal_prepare_buf(
                    std::ptr::null(),
                    c"[]".as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    output.as_mut_ptr(),
                    16,
                    &mut len
                ),
                1
            );
            assert_eq!(len, 0);
        }
    }
}
