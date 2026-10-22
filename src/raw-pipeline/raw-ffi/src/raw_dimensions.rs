//! Cold RAW dimensions for native canvas layout (#5163): the display-oriented
//! DefaultCrop size from metadata alone, for a RAW the host's own metadata
//! reader cannot parse. No pixel decode, no XMP or companion reads.
use crate::error::{catch_panic_rc, set_last_error, with_large_stack};
use rawler::rawsource::RawSource;
use std::ffi::{c_char, CStr};

/// Reset both outputs to zero; true only when both are writable.
unsafe fn reset_outputs(width: *mut u32, height: *mut u32) -> bool {
    if !width.is_null() {
        *width = 0;
    }
    if !height.is_null() {
        *height = 0;
    }
    !width.is_null() && !height.is_null()
}

fn run(source: RawSource, width: usize, height: usize) -> i32 {
    match raw_core::raw_dimensions::from_source(&source) {
        Ok([w, h]) => {
            // SAFETY: both pointers were validated non-null by the extern entry
            // and the caller keeps them alive for the duration of the call.
            unsafe {
                *(width as *mut u32) = w;
                *(height as *mut u32) = h;
            }
            0
        }
        Err(error) => {
            set_last_error(error.to_string());
            5
        }
    }
}

/// Display-oriented DefaultCrop dimensions from RAW metadata. Width/height are
/// reset to zero on every failure. Returns 0 on success, 1 for a null input or
/// output, 2 for a non-UTF-8 path, 5 for an unreadable or invalid RAW, 99 for a
/// panic (call `maple_last_error`).
///
/// # Safety
/// `path` must be a valid C string; `width` and `height` must be writable
/// `u32`s that live for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_raw_dimensions_file(
    path: *const c_char,
    width: *mut u32,
    height: *mut u32,
) -> i32 {
    catch_panic_rc("maple_raw_dimensions_file", || {
        if !reset_outputs(width, height) || path.is_null() {
            return 1;
        }
        let path = match CStr::from_ptr(path).to_str() {
            Ok(path) => std::path::PathBuf::from(path),
            Err(error) => {
                set_last_error(error.to_string());
                return 2;
            }
        };
        let (width, height) = (width as usize, height as usize);
        with_large_stack(move || match RawSource::new(&path) {
            Ok(source) => run(source, width, height),
            Err(error) => {
                set_last_error(error.to_string());
                5
            }
        })
    })
}

/// Byte-backed sibling of [`maple_raw_dimensions_file`]. `hint` is the file
/// extension without a dot (null lets rawler sniff the container). Same return
/// codes; outputs are reset to zero on failure.
///
/// # Safety
/// `bytes` must point to `length` readable bytes that outlive the call (the
/// worker borrows them until it joins); `hint` may be null or a valid C string;
/// `width` and `height` must be writable `u32`s.
#[no_mangle]
pub unsafe extern "C" fn maple_raw_dimensions_bytes(
    bytes: *const u8,
    length: usize,
    hint: *const c_char,
    width: *mut u32,
    height: *mut u32,
) -> i32 {
    catch_panic_rc("maple_raw_dimensions_bytes", || {
        if !reset_outputs(width, height) || bytes.is_null() || length == 0 {
            return 1;
        }
        let hint = if hint.is_null() {
            String::new()
        } else {
            match CStr::from_ptr(hint).to_str() {
                Ok(hint) => hint.to_owned(),
                Err(error) => {
                    set_last_error(error.to_string());
                    return 2;
                }
            }
        };
        let (bytes, width, height) = (bytes as usize, width as usize, height as usize);
        with_large_stack(move || {
            // SAFETY: the caller keeps `bytes` alive until this synchronous call
            // returns, and the worker is joined before it does.
            let bytes = unsafe { std::slice::from_raw_parts(bytes as *const u8, length) };
            let source = RawSource::new_from_slice(bytes).with_path(format!("rawfile.{hint}"));
            run(source, width, height)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::test_support::synth_dng::SyntheticGreyDng;
    use std::ffi::CString;

    fn cropped_rotated_dng() -> Vec<u8> {
        SyntheticGreyDng {
            width: 16,
            height: 8,
            orientation: Some(6),
            default_crop: Some([4, 2, 8, 4]),
            ..Default::default()
        }
        .write_to_bytes()
    }

    #[test]
    fn file_and_borrowed_bytes_agree_and_never_touch_the_original() {
        let raw = cropped_rotated_dng();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("synthetic.dng");
        std::fs::write(&file, &raw).unwrap();
        let path = CString::new(file.to_str().unwrap()).unwrap();
        let hint = CString::new("dng").unwrap();
        let (mut width, mut height) = (999, 999);
        unsafe {
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, &mut height),
                0
            );
            assert_eq!([width, height], [4, 8]);
            assert_eq!(
                maple_raw_dimensions_bytes(
                    raw.as_ptr(),
                    raw.len(),
                    hint.as_ptr(),
                    &mut width,
                    &mut height
                ),
                0
            );
            assert_eq!([width, height], [4, 8]);
            assert_eq!(
                maple_raw_dimensions_bytes(
                    raw.as_ptr(),
                    raw.len(),
                    std::ptr::null(),
                    &mut width,
                    &mut height
                ),
                0
            );
            assert_eq!([width, height], [4, 8]);
        }
        assert_eq!(std::fs::read(&file).unwrap(), raw);
    }

    #[test]
    fn malformed_null_and_missing_inputs_clear_the_outputs() {
        let path = CString::new("/nonexistent/maple-raw-dimensions.dng").unwrap();
        let (mut width, mut height) = (999, 999);
        unsafe {
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, &mut height),
                5
            );
            assert_eq!([width, height], [0, 0]);
            (width, height) = (999, 999);
            assert_eq!(
                maple_raw_dimensions_bytes(
                    b"bad".as_ptr(),
                    3,
                    std::ptr::null(),
                    &mut width,
                    &mut height
                ),
                5
            );
            assert_eq!([width, height], [0, 0]);
            (width, height) = (999, 999);
            assert_eq!(
                maple_raw_dimensions_bytes(
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    &mut width,
                    &mut height
                ),
                1
            );
            assert_eq!([width, height], [0, 0]);
            width = 999;
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, std::ptr::null_mut()),
                1
            );
            assert_eq!(width, 0);
            assert_eq!(
                maple_raw_dimensions_file(std::ptr::null(), &mut width, &mut height),
                1
            );
        }
    }
}
