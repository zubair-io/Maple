//! One-shot native hole/coverage preparation (#3943), outside live grading.
use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

/// Two f32 planes: binary hole (0/1), then coverage (0..1), both row-major at
/// the JSON request's native context dimensions. out_len counts f32 elements.
/// Returns 0 success, 1 null input, 5 invalid input, 99 panic, 100 size probe.
///
/// # Safety
/// request is NUL-terminated UTF-8. intent/protected are readable for their
/// declared byte lengths; null protected is allowed only with length zero.
/// out_len is writable; non-null output is writable for cap f32s. All buffers
/// are disjoint. Input lengths must describe valid allocations.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_generation_masks_f32(
    request: *const c_char,
    intent: *const u8,
    intent_len: usize,
    protected: *const u8,
    protected_len: usize,
    output: *mut f32,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_generation_masks_f32", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if request.is_null() || intent.is_null() || (protected.is_null() && protected_len != 0) {
            return 1;
        }
        if intent_len == 0
            || intent_len > isize::MAX as usize
            || protected_len > isize::MAX as usize
        {
            set_last_error("generation masks: invalid asset length".into());
            return 5;
        }
        let protected = if protected_len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(protected, protected_len)
        };
        let result = CStr::from_ptr(request)
            .to_str()
            .map_err(|e| format!("generation masks: invalid UTF-8: {e}"))
            .and_then(|request| {
                raw_core::stages::removal_generation::prepare_json(
                    request,
                    std::slice::from_raw_parts(intent, intent_len),
                    protected,
                )
            });
        let values = match result {
            Ok(values) => values,
            Err(error) => {
                set_last_error(error);
                return 5;
            }
        };
        *out_len = values.len();
        if output.is_null() || cap < values.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(values.as_ptr(), output, values.len());
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::types::removal_mask::RemovalMask;
    use std::ffi::CString;

    #[test]
    fn probe_and_real_output_match_shared_planes_and_failure_cannot_touch_output() {
        let mask = raw_core::pipeline::removal_mask_to_bytes(&RemovalMask {
            source_width: 9,
            source_height: 9,
            x: 4,
            y: 4,
            width: 1,
            height: 1,
            pixels: vec![255],
        })
        .unwrap();
        let request = CString::new(r#"{"schema":1,"window":{"x":0,"y":0,"width":9,"height":9},"hole_radius":3,"fringe_radius":2}"#).unwrap();
        let expected = raw_core::stages::removal_generation::prepare_json(
            request.to_str().unwrap(),
            &mask,
            &[],
        )
        .unwrap();
        let mut output = vec![42.0; expected.len()];
        let mut len = 42;
        unsafe {
            assert_eq!(
                maple_removal_generation_masks_f32(
                    request.as_ptr(),
                    mask.as_ptr(),
                    mask.len(),
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut len
                ),
                100
            );
            assert_eq!(len, 162);
            assert_eq!(
                maple_removal_generation_masks_f32(
                    request.as_ptr(),
                    mask.as_ptr(),
                    mask.len(),
                    std::ptr::null(),
                    0,
                    output.as_mut_ptr(),
                    output.len() - 1,
                    &mut len
                ),
                100
            );
            assert!(output.iter().all(|v| *v == 42.0));
            assert_eq!(
                maple_removal_generation_masks_f32(
                    request.as_ptr(),
                    mask.as_ptr(),
                    mask.len(),
                    std::ptr::null(),
                    0,
                    output.as_mut_ptr(),
                    output.len(),
                    &mut len
                ),
                0
            );
            assert_eq!(output, expected);
            assert_eq!(
                maple_removal_generation_masks_f32(
                    request.as_ptr(),
                    mask.as_ptr(),
                    mask.len(),
                    mask.as_ptr(),
                    mask.len(),
                    output.as_mut_ptr(),
                    output.len(),
                    &mut len
                ),
                5
            );
            assert_eq!(len, 0);
            assert_eq!(output, expected);
            assert_eq!(
                maple_removal_generation_masks_f32(
                    std::ptr::null(),
                    mask.as_ptr(),
                    mask.len(),
                    std::ptr::null(),
                    0,
                    output.as_mut_ptr(),
                    output.len(),
                    &mut len
                ),
                1
            );
            assert_eq!(len, 0);
        }
    }
}
