//! `maple_sample_white_balance` — the neutral white-balance sampler (#2434)
//! for the Apple / Windows / `bun:ffi` hosts. Same transport as
//! `maple_compute_auto_adjustments`: a RAW path, an optional XMP path, and a
//! `#[repr(C)]` out struct; the click point is normalised image-relative.
//!
//! Return codes: `0` ok; `1` null argument; `2` non-UTF-8 path; `3` read /
//! decode / develop failure; `11` point outside the image; `12` sampled
//! surface clipped; `13` too dark; `14` solve outside the slider domain.
//! Every non-zero code also sets `maple_last_error` with the user-facing
//! message `WbSampleError` displays.

use std::os::raw::c_char;

use raw_core::stages::white_balance_sample::{sample_white_balance, WbSampleError};

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};

#[repr(C)]
pub struct MapleWbSample {
    pub temperature: f32,
    pub tint: f32,
    pub algorithm_version: u32,
}

fn code_for(err: &WbSampleError) -> i32 {
    match err {
        WbSampleError::Develop(_) => 3,
        WbSampleError::OutsideImage => 11,
        WbSampleError::Clipped => 12,
        WbSampleError::TooDark => 13,
        WbSampleError::OutOfDomain => 14,
    }
}

/// # Safety
/// `raw_path` must be a valid NUL-terminated C string; `xmp_path` may be
/// null; `out` must point to writable storage for one `MapleWbSample`.
#[no_mangle]
pub unsafe extern "C" fn maple_sample_white_balance(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    nx: f32,
    ny: f32,
    out: *mut MapleWbSample,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        return 1;
    }
    let raw_str = match unsafe { std::ffi::CStr::from_ptr(raw_path) }.to_str() {
        Ok(s) => s.to_owned(),
        Err(_) => {
            set_last_error("raw_path is not valid UTF-8".into());
            return 2;
        }
    };
    let xmp_owned: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match unsafe { std::ffi::CStr::from_ptr(xmp_path) }.to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(_) => {
                set_last_error("xmp_path is not valid UTF-8".into());
                return 2;
            }
        }
    };
    let out_usize = out as usize;
    with_large_stack(move || {
        let out_ptr = out_usize as *mut MapleWbSample;
        let model = match load_xmp_model_owned(xmp_owned.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(code) => return code,
        };
        let raw_bytes = match std::fs::read(&raw_str) {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 3;
            }
        };
        let ext = std::path::Path::new(&raw_str)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let raw_img = match raw_core::decode::decode_bytes(&raw_bytes, &ext) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("raw decode: {}", e));
                return 3;
            }
        };
        match sample_white_balance(&raw_img, &model, nx, ny) {
            Ok(s) => {
                unsafe {
                    *out_ptr = MapleWbSample {
                        temperature: s.temperature,
                        tint: s.tint,
                        algorithm_version: s.algorithm_version,
                    };
                }
                0
            }
            Err(e) => {
                set_last_error(e.to_string());
                code_for(&e)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn null_arguments_are_rejected() {
        let mut out = MapleWbSample {
            temperature: 0.0,
            tint: 0.0,
            algorithm_version: 0,
        };
        assert_eq!(
            unsafe {
                maple_sample_white_balance(std::ptr::null(), std::ptr::null(), 0.5, 0.5, &mut out)
            },
            1
        );
        let p = CString::new("/nonexistent.dng").unwrap();
        assert_eq!(
            unsafe {
                maple_sample_white_balance(
                    p.as_ptr(),
                    std::ptr::null(),
                    0.5,
                    0.5,
                    std::ptr::null_mut(),
                )
            },
            1
        );
    }

    #[test]
    fn unreadable_raw_reports_code_3() {
        let mut out = MapleWbSample {
            temperature: 0.0,
            tint: 0.0,
            algorithm_version: 0,
        };
        let p = CString::new("/nonexistent/maple-2434.dng").unwrap();
        assert_eq!(
            unsafe { maple_sample_white_balance(p.as_ptr(), std::ptr::null(), 0.5, 0.5, &mut out) },
            3
        );
    }

    /// The error codes are the contract the hosts key their messages on.
    #[test]
    fn sample_error_codes_are_stable() {
        assert_eq!(code_for(&WbSampleError::OutsideImage), 11);
        assert_eq!(code_for(&WbSampleError::Clipped), 12);
        assert_eq!(code_for(&WbSampleError::TooDark), 13);
        assert_eq!(code_for(&WbSampleError::OutOfDomain), 14);
        assert_eq!(code_for(&WbSampleError::Develop("x".into())), 3);
    }
}
