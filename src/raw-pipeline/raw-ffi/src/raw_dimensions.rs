//! Cold RAW metadata fallback for native canvas layout (#3984).
use crate::error::{set_last_error, with_large_stack};
use rawler::rawsource::RawSource;
use std::ffi::{c_char, CStr};

unsafe fn outputs(width: *mut u32, height: *mut u32) -> bool {
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

/// Display-oriented DefaultCrop dimensions from RAW metadata. No pixel decode
/// or XMP/companion reads. Width/height reset to zero on every failure.
/// Returns 0 success, 1 null input/output, 2 invalid path, 5 invalid RAW, 99 panic.
#[no_mangle]
pub unsafe extern "C" fn maple_raw_dimensions_file(
    path: *const c_char,
    width: *mut u32,
    height: *mut u32,
) -> i32 {
    if !outputs(width, height) || path.is_null() {
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
}

/// Byte-backed variant of maple_raw_dimensions_file. The synchronous call
/// borrows the supplied bytes through the worker join. hint is an extension
/// without a dot; null uses content sniffing. Outputs reset on failure.
#[no_mangle]
pub unsafe extern "C" fn maple_raw_dimensions_bytes(
    bytes: *const u8,
    length: usize,
    hint: *const c_char,
    width: *mut u32,
    height: *mut u32,
) -> i32 {
    if !outputs(width, height) || bytes.is_null() || length == 0 {
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
        let bytes = unsafe { std::slice::from_raw_parts(bytes as *const u8, length) };
        let source = RawSource::new_from_slice(bytes).with_path(format!("source.{hint}"));
        run(source, width, height)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    const RAW: &[u8] = include_bytes!("../../../../test-fixtures/removal/calibration/source.dng");

    #[test]
    fn real_file_and_borrowed_bytes_match_and_never_modify_original() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), RAW).unwrap();
        let path = CString::new(file.path().to_str().unwrap()).unwrap();
        let hint = CString::new("dng").unwrap();
        let (mut width, mut height) = (999, 999);
        unsafe {
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, &mut height),
                0
            );
            assert_eq!([width, height], [16, 8]);
            assert_eq!(
                maple_raw_dimensions_bytes(
                    RAW.as_ptr(),
                    RAW.len(),
                    hint.as_ptr(),
                    &mut width,
                    &mut height
                ),
                0
            );
            assert_eq!([width, height], [16, 8]);
        }
        assert_eq!(std::fs::read(file.path()).unwrap(), RAW);
    }

    #[test]
    fn malformed_null_and_missing_inputs_clear_outputs() {
        let path = CString::new("/nonexistent/maple-raw-dimensions.dng").unwrap();
        let (mut width, mut height) = (999, 999);
        unsafe {
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, &mut height),
                5
            );
            assert_eq!([width, height], [0, 0]);
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
            width = 999;
            assert_eq!(
                maple_raw_dimensions_file(path.as_ptr(), &mut width, std::ptr::null_mut()),
                1
            );
            assert_eq!(width, 0);
        }
    }
}
