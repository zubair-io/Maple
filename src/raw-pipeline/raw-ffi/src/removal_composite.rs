//! Source/stack-revision composition for retained CPU bases (#3935).
use crate::error::{catch_panic_rc, set_last_error};

/// Composite a MIPF patch blob onto an un-oriented scene-linear source window.
/// This operation runs when the source or accepted stack changes, before the
/// host retains the base for grading. Returns 0 success, 1 null pointer,
/// 5 malformed input, 99 caught panic, 100 insufficient output capacity.
///
/// # Safety
/// input is readable for input_len f32s; blob is readable for blob_len bytes;
/// window is readable for four f32s. output is writable for output_cap f32s.
/// All buffers are disjoint. Null blob is allowed only with blob_len=0.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_composite_window_f32(
    input: *const f32,
    input_len: usize,
    width: u32,
    height: u32,
    blob: *const u8,
    blob_len: usize,
    window: *const f32,
    output: *mut f32,
    output_cap: usize,
) -> i32 {
    catch_panic_rc("maple_removal_composite_window_f32", || {
        if input.is_null() || window.is_null() || (blob.is_null() && blob_len != 0) {
            return 1;
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4));
        if width == 0
            || height == 0
            || expected != Some(input_len)
            || input_len > isize::MAX as usize / 4
            || blob_len > isize::MAX as usize
        {
            set_last_error("removal composite: invalid input dimensions".into());
            return 5;
        }
        let patches = if blob_len == 0 {
            Ok(Vec::new())
        } else {
            raw_core::pipeline::patches_from_blob(std::slice::from_raw_parts(blob, blob_len))
        };
        let result = patches.and_then(|patches| {
            let values = std::slice::from_raw_parts(window, 4);
            raw_core::pipeline::composite_window_into_f32(
                std::slice::from_raw_parts(input, input_len),
                width,
                height,
                &patches,
                [values[0], values[1], values[2], values[3]],
            )
            .map_err(|e| e.to_string())
        });
        match result {
            Err(e) => {
                set_last_error(e);
                5
            }
            Ok(values) if output.is_null() || output_cap < values.len() => 100,
            Ok(values) => {
                std::ptr::copy_nonoverlapping(values.as_ptr(), output, values.len());
                0
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_geometry_cannot_change_output_and_empty_stack_preserves_input() {
        let input = [-0.0, 0.18, 8.0, 0.5];
        let mut output = [42.0; 4];
        let window = [0.0, 0.0, 1.0, 1.0];
        unsafe {
            assert_eq!(
                maple_removal_composite_window_f32(
                    input.as_ptr(),
                    4,
                    1,
                    1,
                    std::ptr::null(),
                    0,
                    window.as_ptr(),
                    output.as_mut_ptr(),
                    3
                ),
                100
            );
            assert_eq!(output, [42.0; 4]);
            assert_eq!(
                maple_removal_composite_window_f32(
                    input.as_ptr(),
                    4,
                    2,
                    1,
                    std::ptr::null(),
                    0,
                    window.as_ptr(),
                    output.as_mut_ptr(),
                    4
                ),
                5
            );
            assert_eq!(output, [42.0; 4]);
            assert_eq!(
                maple_removal_composite_window_f32(
                    input.as_ptr(),
                    4,
                    1,
                    1,
                    std::ptr::null(),
                    0,
                    window.as_ptr(),
                    output.as_mut_ptr(),
                    4
                ),
                0
            );
        }
        for i in 0..4 {
            assert_eq!(input[i].to_bits(), output[i].to_bits());
        }
    }
}
