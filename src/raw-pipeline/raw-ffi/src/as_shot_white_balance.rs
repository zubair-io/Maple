//! Camera-native WB baseline for durable cross-asset transfer (#3311).
use std::ffi::{c_char, CStr};

use crate::error::{set_last_error, with_large_stack};

/// Read the same slider-frame As Shot pair exported by Apple and WASM decode.
/// No sidecar is loaded and no pixels are developed. The caller owns the pair.
///
/// # Safety
/// `raw_path` is a NUL-terminated UTF-8 path; `out` points to two writable f32s.
#[no_mangle]
pub unsafe extern "C" fn maple_as_shot_white_balance_file(
    raw_path: *const c_char,
    out: *mut f32,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("As Shot: null argument".into());
        return 1;
    }
    let path = match unsafe { CStr::from_ptr(raw_path) }.to_str() {
        Ok(path) => path.to_owned(),
        Err(_) => {
            set_last_error("As Shot: path is not UTF-8".into());
            return 2;
        }
    };
    let decoded = std::sync::Arc::new(std::sync::Mutex::new(None));
    let worker_decoded = decoded.clone();
    let rc = with_large_stack(move || {
        let result = raw_core::decode::decode(std::path::Path::new(&path))
            .and_then(|raw| raw_core::color::dcp::estimate_as_shot_cct_tint(&raw));
        match result {
            Ok((temperature, tint)) if temperature.is_finite() && tint.is_finite() => {
                *worker_decoded.lock().expect("As Shot result lock") = Some([temperature, tint]);
                0
            }
            Ok(_) => {
                set_last_error("As Shot: non-finite camera baseline".into());
                3
            }
            Err(error) => {
                set_last_error(format!("As Shot: {error}"));
                3
            }
        }
    });
    if rc == 0 {
        let pair = decoded
            .lock()
            .expect("As Shot result lock")
            .expect("worker result");
        unsafe {
            out.write(pair[0]);
            out.add(1).write(pair[1]);
        }
    }
    rc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_null_output_and_unreadable_paths() {
        let missing = std::ffi::CString::new("/missing-maple-batch-fixture.dng").unwrap();
        let mut pair = [123.0; 2];
        assert_eq!(
            unsafe { maple_as_shot_white_balance_file(missing.as_ptr(), std::ptr::null_mut()) },
            1
        );
        assert_eq!(
            unsafe { maple_as_shot_white_balance_file(missing.as_ptr(), pair.as_mut_ptr()) },
            3
        );
        assert_eq!(pair, [123.0; 2]);
    }

    #[test]
    fn exports_both_paired_fixture_baselines_without_sidecars() {
        for name in ["source.dng", "target.dng"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/batch-transfer")
                .join(name);
            let raw = raw_core::decode::decode(&path).unwrap();
            let expected = raw_core::color::dcp::estimate_as_shot_cct_tint(&raw).unwrap();
            assert!(
                crate::scene_linear_f32::wb_frame_export(&raw).scene_cct > 0.0,
                "paired fixture must export a calibrated WB frame"
            );
            let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
            let mut pair = [0.0; 2];
            assert_eq!(
                unsafe { maple_as_shot_white_balance_file(c_path.as_ptr(), pair.as_mut_ptr()) },
                0
            );
            assert_eq!(pair, [expected.0, expected.1]);
        }
    }
}
