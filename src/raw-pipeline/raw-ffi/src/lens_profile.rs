//! Owned UTF-8 LCP import/resolution boundary for native hosts (#2435).
use crate::error::{set_last_error, with_large_stack};
use std::ffi::{c_char, CStr, CString};

unsafe fn output_json(out: *mut *mut c_char, result: Result<String, String>) -> i32 {
    match result {
        Ok(value) => {
            *out = CString::new(value).expect("JSON escapes NUL").into_raw();
            0
        }
        Err(error) => {
            set_last_error(error);
            8
        }
    }
}

/// Register bounded, user-owned LCP bytes. On success the host owns `out_json`
/// and must free it exactly once with `maple_free_lens_profile_json`.
#[no_mangle]
pub unsafe extern "C" fn maple_lens_profile_register(
    xml: *const u8,
    length: usize,
    out_json: *mut *mut c_char,
) -> i32 {
    if out_json.is_null() {
        return 1;
    }
    *out_json = std::ptr::null_mut();
    if xml.is_null() || length == 0 || length > 32 * 1024 * 1024 {
        set_last_error("Invalid LCP input length".into());
        return 1;
    }
    let xml = match std::str::from_utf8(std::slice::from_raw_parts(xml, length)) {
        Ok(xml) => xml,
        Err(error) => {
            set_last_error(error.to_string());
            return 2;
        }
    };
    output_json(
        out_json,
        raw_core::lens_profile::register(xml).map(|value| value.to_string()),
    )
}

/// Resolve a registered profile against real decode metadata. A cold call
/// reads/decodes on a large stack; a warm call reuses the source decode cache.
#[no_mangle]
pub unsafe extern "C" fn maple_lens_profile_resolve_file(
    path: *const c_char,
    reference: *const c_char,
    out_json: *mut *mut c_char,
) -> i32 {
    if out_json.is_null() {
        return 1;
    }
    *out_json = std::ptr::null_mut();
    if path.is_null() || reference.is_null() {
        return 1;
    }
    let (Ok(path), Ok(reference)) = (
        CStr::from_ptr(path).to_str(),
        CStr::from_ptr(reference).to_str(),
    ) else {
        return 2;
    };
    let path = std::path::PathBuf::from(path);
    let reference = reference.to_owned();
    let output = out_json as usize;
    with_large_stack(move || {
        let resolve = || -> Result<String, String> {
            let key = raw_core::decode_cache::CacheKey::from_path(&path)
                .ok_or("RAW source is not available")?;
            let raw = if let Some(raw) = raw_core::decode_cache::get(&key) {
                raw
            } else {
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
                raw_core::decode_cache::decode_bytes_cached(&key, &bytes, ext)
                    .map_err(|e| e.to_string())?
            };
            Ok(raw_core::lens_profile::resolve_for_raw(&raw,&reference)?
                .map(|resolution| resolution.metadata().to_string())
                .unwrap_or_else(|| r#"{"source":"embedded","confidence":"embedded","approximations":[],"unsupported":[]}"#.into()))
        };
        output_json(output as *mut *mut c_char, resolve())
    })
}

#[no_mangle]
pub unsafe extern "C" fn maple_free_lens_profile_json(json: *mut c_char) {
    if !json.is_null() {
        drop(CString::from_raw(json));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn error_paths_clear_output_and_null_free_is_safe() {
        unsafe {
            let mut output = std::ptr::dangling_mut();
            assert_eq!(
                maple_lens_profile_register(std::ptr::null(), 0, &mut output),
                1
            );
            assert!(output.is_null());
            let invalid = [0xff];
            assert_eq!(
                maple_lens_profile_register(invalid.as_ptr(), 1, &mut output),
                2
            );
            assert!(output.is_null());
            maple_free_lens_profile_json(output);
        }
    }
}
