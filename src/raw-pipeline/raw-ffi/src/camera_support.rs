//! Read-only camera support metadata (#3313), evaluated once on image open.
//! Uses the render decode cache; it never guesses calibration from EXIF names.

use crate::error::{set_last_error, with_large_stack};
use raw_core::{
    decode_cache::{self, CacheKey},
    support_tiers::RenderSupport,
};
use std::ffi::{c_char, CStr, CString};

/// Resolve the file's camera/lens support JSON. `out_json` is initialized to
/// null and receives owned NUL-terminated UTF-8 on success. Free it with
/// `maple_free_camera_support`. Return codes: 0 success, 1 null argument,
/// 2 invalid UTF-8, 6 read failure, 7 decode failure, 8 resolver failure.
/// Call on the decode worker, never on a slider tick. After a scene-linear
/// decode the same path/mtime cache entry avoids any second read or decode.
#[no_mangle]
pub unsafe extern "C" fn maple_camera_support_file(
    raw_path: *const c_char,
    out_json: *mut *mut c_char,
) -> i32 {
    if out_json.is_null() {
        set_last_error("null support output".into());
        return 1;
    }
    *out_json = std::ptr::null_mut();
    if raw_path.is_null() {
        set_last_error("null raw path".into());
        return 1;
    }
    let path = match CStr::from_ptr(raw_path).to_str() {
        Ok(path) => std::path::PathBuf::from(path),
        Err(e) => {
            set_last_error(format!("raw path not UTF-8: {e}"));
            return 2;
        }
    };
    let output = out_json as usize;
    with_large_stack(move || {
        let key = CacheKey::from_path(&path);
        let cached = key.as_ref().and_then(decode_cache::get);
        let raw = match cached {
            Some(raw) => raw,
            None => {
                let bytes = match std::fs::read(&path) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        set_last_error(format!("raw read: {e}"));
                        return 6;
                    }
                };
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let decoded = match raw_core::decode::decode_bytes(&bytes, ext) {
                    Ok(raw) => std::sync::Arc::new(raw),
                    Err(e) => {
                        set_last_error(format!("decode: {e}"));
                        return 7;
                    }
                };
                if let Some(key) = key {
                    decode_cache::insert(key, decoded.clone());
                }
                decoded
            }
        };
        match RenderSupport::resolve(&raw) {
            Ok(support) => {
                // JSON escapes embedded NULs; CString construction cannot fail.
                let json = CString::new(support.to_json()).expect("JSON has no NUL");
                *(output as *mut *mut c_char) = json.into_raw();
                0
            }
            Err(e) => {
                set_last_error(format!("profile resolution: {e}"));
                8
            }
        }
    })
}

/// Free exactly once a non-null pointer returned by `maple_camera_support_file`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_camera_support(json: *mut c_char) {
    if !json.is_null() {
        drop(CString::from_raw(json));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic_dng_crosses_the_owned_utf8_boundary_with_real_resolver_provenance() {
        use raw_core::test_support::synth_dng::SyntheticGreyDng;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("support-λ.dng");
        SyntheticGreyDng {
            width: 32,
            height: 32,
            ..Default::default()
        }
        .write_to(&path)
        .unwrap();
        let path = CString::new(path.to_str().unwrap()).unwrap();
        unsafe {
            let mut output = std::ptr::null_mut();
            assert_eq!(maple_camera_support_file(path.as_ptr(), &mut output), 0);
            assert!(!output.is_null());
            let json = CStr::from_ptr(output).to_str().unwrap();
            assert!(
                json.contains("\"resolution\":\"rawler_fallback\""),
                "{json}"
            );
            assert!(json.contains("\"lens\":\"no_correction_data\""), "{json}");
            assert!(json.contains("\"cameraKey\":"), "{json}");
            maple_free_camera_support(output);
        }
    }

    #[test]
    fn errors_clear_the_output_and_null_free_is_safe() {
        unsafe {
            let mut output = std::ptr::dangling_mut::<c_char>();
            assert_eq!(maple_camera_support_file(std::ptr::null(), &mut output), 1);
            assert!(output.is_null());
            let path = CString::new("missing-camera-support-fixture.dng").unwrap();
            assert_eq!(maple_camera_support_file(path.as_ptr(), &mut output), 6);
            assert!(output.is_null());
            maple_free_camera_support(output);
        }
    }
}
