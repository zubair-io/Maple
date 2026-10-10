//! Pure host marshalling for shared Paint/Subtract selection (#3934). No
//! inference, edit commit, filesystem access or render-loop integration here.

use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

/// Replay source-framed Add/Subtract strokes over a detected native mask.
/// Returns the selection return codes; a fully erased mask has out_len=0.
/// # Safety
/// base is readable for base_len; protected is readable for protected_len when
/// nonzero. request is NUL-terminated UTF-8, out_len is
/// writable, and non-null output is writable for out_cap and disjoint from inputs.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_refine_selection_buf(
    base: *const u8,
    base_len: usize,
    protected: *const u8,
    protected_len: usize,
    request: *const c_char,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_refine_selection_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if base.is_null() || request.is_null() {
            return 1;
        }
        if base_len > isize::MAX as usize
            || protected_len > isize::MAX as usize
            || (protected_len > 0 && protected.is_null())
            || out_cap > isize::MAX as usize
        {
            set_last_error("invalid refinement buffer length".into());
            return 5;
        }
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("removal refinement: invalid UTF-8: {e}"))
            .and_then(|request| {
                raw_core::stages::removal_selection::refine_json(
                    std::slice::from_raw_parts(base, base_len),
                    if protected_len == 0 {
                        &[]
                    } else {
                        std::slice::from_raw_parts(protected, protected_len)
                    },
                    request,
                )
            });
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(e) => {
                set_last_error(e);
                return 5;
            }
        };
        *out_len = bytes.len();
        if bytes.is_empty() {
            return 0;
        }
        if out_buf.is_null() || out_cap < bytes.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
        0
    })
}

/// Union reviewed source masks, or subtract protected intent. Empty input or
/// output means no selection, never a zero-sized MIMF. Geometry and binary
/// mask validation use the same core as WASM. Return codes match selection.
/// # Safety
/// Non-null inputs are readable for their lengths. out_len is writable and
/// non-null out_buf writable for out_cap bytes, disjoint from every input.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_combine_masks_buf(
    left: *const u8,
    left_len: usize,
    right: *const u8,
    right_len: usize,
    subtract: i32,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_combine_masks_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if !matches!(subtract, 0 | 1) || out_cap > isize::MAX as usize {
            set_last_error("invalid combined mask operation/capacity".into());
            return 5;
        }
        let input = |pointer: *const u8, length: usize| -> Result<&[u8], String> {
            if length > isize::MAX as usize || (length > 0 && pointer.is_null()) {
                return Err("invalid combined mask input".into());
            }
            Ok(if length == 0 {
                &[]
            } else {
                std::slice::from_raw_parts(pointer, length)
            })
        };
        let result = input(left, left_len).and_then(|left| {
            input(right, right_len).and_then(|right| {
                raw_core::stages::removal_selection::combine_masks(left, right, subtract == 1)
            })
        });
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(e) => {
                set_last_error(e);
                return 5;
            }
        };
        *out_len = bytes.len();
        if bytes.is_empty() {
            return 0;
        }
        if out_buf.is_null() || out_cap < bytes.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
        0
    })
}

/// Rasterize a schema-1 JSON gesture request into a lossless MIMF asset.
/// Returns 0 success (out_len=0 means empty selection), 1 null pointer,
/// 5 invalid request, 99 caught panic, 100 size probe/insufficient capacity.
///
/// # Safety
/// request_json is NUL-terminated UTF-8; out_len is writable. Non-null out_buf
/// is writable for out_cap bytes and does not overlap the request or out_len.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_selection_buf(
    source_width: u32,
    source_height: u32,
    request_json: *const c_char,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_selection_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request_json.is_null() {
            return 1;
        }
        let bytes = match CStr::from_ptr(request_json)
            .to_str()
            .map_err(|e| format!("removal selection: invalid UTF-8: {e}"))
            .and_then(|request| {
                raw_core::stages::removal_selection::rasterize_json(
                    source_width,
                    source_height,
                    request,
                )
            }) {
            Ok(bytes) => bytes,
            Err(e) => {
                set_last_error(e);
                return 5;
            }
        };
        *out_len = bytes.len();
        if bytes.is_empty() {
            return 0;
        }
        if out_buf.is_null() || out_cap < bytes.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
        0
    })
}

/// Decode MIMF to a binary UI/inference plane plus native geometry. window
/// holds six u32s: source_width, source_height, x, y, width, height.
/// Same return codes as maple_removal_selection_buf; malformed assets return 5.
///
/// # Safety
/// input is readable for input_len; window is writable for six u32s; out_len
/// is writable. Non-null out_buf is writable for out_cap. Buffers do not overlap.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_mask_decode_buf(
    input: *const u8,
    input_len: usize,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
    window: *mut u32,
) -> i32 {
    catch_panic_rc("maple_removal_mask_decode_buf", || {
        if out_len.is_null() || window.is_null() {
            return 1;
        }
        *out_len = 0;
        std::slice::from_raw_parts_mut(window, 6).fill(0);
        if input.is_null() || input_len == 0 {
            return 1;
        }
        let mask = match raw_core::pipeline::removal_mask_from_bytes(std::slice::from_raw_parts(
            input, input_len,
        )) {
            Ok(mask) => mask,
            Err(e) => {
                set_last_error(e);
                return 5;
            }
        };
        *out_len = mask.pixels.len();
        std::slice::from_raw_parts_mut(window, 6).copy_from_slice(&[
            mask.source_width,
            mask.source_height,
            mask.x,
            mask.y,
            mask.width,
            mask.height,
        ]);
        if out_buf.is_null() || out_cap < mask.pixels.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(mask.pixels.as_ptr(), out_buf, mask.pixels.len());
        0
    })
}

#[cfg(test)]
#[path = "removal_selection_tests.rs"]
mod tests;
