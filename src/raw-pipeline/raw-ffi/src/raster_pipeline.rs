//! Third-generation raster C ABI (#3505): ONE entry point that executes a
//! whole recipe, instead of one symbol per capability.
//!
//! `raster_v2.rs`'s three symbols keep their exact signatures — existing C
//! callers are unaffected. New capability lands as a new recipe op, which
//! costs no ABI change at all: that is the whole point of the design, and it
//! is what keeps the `bun:ffi` argument count at 11 rather than climbing past
//! the ~15 where Bun has historically crashed.
//!
//! Return codes: 0 ok, 1 null argument, 3 decode failed, 4 an op failed,
//! 5 recipe parse/validation failed, 6 encode failed, 99 panic caught,
//! 100 `out_buf` too small (`*out_len` and the three dimension outputs are
//! still written, so a null-buffer call is a size probe).

use crate::error::{catch_panic_rc, set_last_error};
use raw_core::raster_recipe::parse_recipe;
use raw_core::raster_recipe_exec::run_recipe;
use std::ffi::{c_char, CStr};

const NEED_LARGER_BUFFER: i32 = 100;

/// See module docs for the return codes. `recipe_json` is a NUL-terminated
/// UTF-8 recipe (schema v1); `aux` is the flat side-car buffer its `AuxRef`s
/// index into (pass null/0 when the recipe needs none).
///
/// # Safety
/// Every non-null pointer must be valid for the stated length for the
/// duration of the call, and the four out-pointers must be non-null.
#[no_mangle]
pub unsafe extern "C" fn maple_raster_pipeline_buf(
    input: *const u8,
    input_len: usize,
    recipe_json: *const c_char,
    aux: *const u8,
    aux_len: usize,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
    out_width: *mut u32,
    out_height: *mut u32,
    out_channels: *mut u32,
) -> i32 {
    catch_panic_rc("maple_raster_pipeline_buf", || {
        if input.is_null()
            || input_len == 0
            || recipe_json.is_null()
            || out_len.is_null()
            || out_width.is_null()
            || out_height.is_null()
            || out_channels.is_null()
        {
            set_last_error("input, recipe or an out pointer is null".into());
            return 1;
        }
        let recipe_str = match CStr::from_ptr(recipe_json).to_str() {
            Ok(s) => s,
            Err(_) => {
                set_last_error("recipe is not valid UTF-8".into());
                return 5;
            }
        };
        let recipe = match parse_recipe(recipe_str) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("{e}"));
                return 5;
            }
        };
        let input_slice = std::slice::from_raw_parts(input, input_len);
        let aux_slice = if aux.is_null() || aux_len == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(aux, aux_len)
        };
        let result = match run_recipe(&recipe, input_slice, aux_slice) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("{e}"));
                return 4;
            }
        };
        *out_width = result.width;
        *out_height = result.height;
        *out_channels = result.channels as u32;
        *out_len = result.bytes.len();
        if out_buf.is_null() || out_cap < result.bytes.len() {
            return NEED_LARGER_BUFFER;
        }
        std::ptr::copy_nonoverlapping(result.bytes.as_ptr(), out_buf, result.bytes.len());
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    const RGBA_TO_PNG: &str = r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":4},"ops":[],"output":{"format":"png"}}"#;

    fn call(
        input: &[u8],
        recipe: &str,
        aux: &[u8],
        out: Option<&mut [u8]>,
    ) -> (i32, usize, u32, u32, u32) {
        let recipe_c = CString::new(recipe).unwrap();
        let mut out_len = 0usize;
        let mut w = 0u32;
        let mut h = 0u32;
        let mut c = 0u32;
        let (ptr, cap) = match out {
            Some(buf) => (buf.as_mut_ptr(), buf.len()),
            None => (std::ptr::null_mut(), 0),
        };
        // SAFETY: every pointer below borrows a live local for the call.
        let rc = unsafe {
            maple_raster_pipeline_buf(
                input.as_ptr(),
                input.len(),
                recipe_c.as_ptr(),
                aux.as_ptr(),
                aux.len(),
                ptr,
                cap,
                &mut out_len,
                &mut w,
                &mut h,
                &mut c,
            )
        };
        (rc, out_len, w, h, c)
    }

    #[test]
    fn a_null_buffer_call_reports_the_size_and_dimensions() {
        let px = [255u8, 0, 0, 255, 0, 255, 0, 128];
        let (rc, len, w, h, c) = call(&px, RGBA_TO_PNG, &[], None);
        assert_eq!(rc, NEED_LARGER_BUFFER);
        assert!(len > 8, "PNG should be more than 8 bytes, got {len}");
        assert_eq!((w, h, c), (2, 1, 4));
    }

    #[test]
    fn a_sized_buffer_receives_the_png() {
        let px = [255u8, 0, 0, 255, 0, 255, 0, 128];
        let (_, len, ..) = call(&px, RGBA_TO_PNG, &[], None);
        let mut out = vec![0u8; len];
        let (rc, written, w, h, c) = call(&px, RGBA_TO_PNG, &[], Some(&mut out));
        assert_eq!(rc, 0);
        assert_eq!(written, len);
        assert_eq!((w, h, c), (2, 1, 4));
        assert_eq!(&out[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn a_malformed_recipe_reports_rc_5() {
        let (rc, ..) = call(&[0, 0, 0, 255], "{not json", &[], None);
        assert_eq!(rc, 5);
    }

    #[test]
    fn a_null_input_reports_rc_1() {
        let recipe = CString::new(RGBA_TO_PNG).unwrap();
        let mut out_len = 0usize;
        let (mut w, mut h, mut c) = (0u32, 0u32, 0u32);
        // SAFETY: deliberately passing a null input pointer to exercise the guard.
        let rc = unsafe {
            maple_raster_pipeline_buf(
                std::ptr::null(),
                0,
                recipe.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut out_len,
                &mut w,
                &mut h,
                &mut c,
            )
        };
        assert_eq!(rc, 1);
    }
}
