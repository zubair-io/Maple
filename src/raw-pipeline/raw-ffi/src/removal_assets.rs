use crate::error::{catch_panic_rc, set_last_error};
use std::ffi::{c_char, CStr};

/// Verify accepted source identities against the currently read original.
/// Returns 0 verified, 1 null, 5 invalid/mismatched, 99 caught panic.
///
/// # Safety
/// Both arguments are NUL-terminated UTF-8 strings.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_source_verify(
    records: *const c_char,
    original: *const c_char,
) -> i32 {
    catch_panic_rc("maple_removal_source_verify", || {
        if records.is_null() || original.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(records)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|records| {
                CStr::from_ptr(original)
                    .to_str()
                    .map_err(|e| e.to_string())
                    .and_then(|original| {
                        raw_core::pipeline::verify_removal_source(records, original)
                    })
            });
        match result {
            Ok(()) => 0,
            Err(e) => {
                set_last_error(e);
                5
            }
        }
    })
}

/// Return the shared companion basenames as a UTF-8 JSON array. Same buffer
/// return codes as maple_removal_prepare_buf; no terminating NUL.
///
/// # Safety
/// records is NUL-terminated UTF-8; out_len is writable. Non-null output is
/// writable for cap bytes and disjoint from records and out_len.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_asset_names_buf(
    records: *const c_char,
    output: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_asset_names_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        if records.is_null() {
            return 1;
        }
        let result = CStr::from_ptr(records)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(raw_core::pipeline::removal_asset_names)
            .and_then(|names| serde_json::to_string(&names).map_err(|e| e.to_string()));
        match result {
            Err(e) => {
                set_last_error(e);
                5
            }
            Ok(value) => {
                *out_len = value.len();
                if output.is_null() || cap < value.len() {
                    return 100;
                }
                std::ptr::copy_nonoverlapping(value.as_ptr(), output, value.len());
                0
            }
        }
    })
}

/// Verify a digest basename and its codec before read/publish/import.
/// Returns 0 verified, 1 null, 5 invalid companion, 99 caught panic.
///
/// # Safety
/// name is NUL-terminated UTF-8; input is readable for len bytes, with
/// len<=isize::MAX. Null input is allowed only when len=0.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_asset_verify(
    name: *const c_char,
    input: *const u8,
    len: usize,
) -> i32 {
    catch_panic_rc("maple_removal_asset_verify", || {
        if name.is_null() || (input.is_null() && len != 0) {
            return 1;
        }
        if len > isize::MAX as usize {
            return 5;
        }
        let bytes = if len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(input, len)
        };
        match CStr::from_ptr(name)
            .to_str()
            .map_err(|e| e.to_string())
            .and_then(|name| raw_core::pipeline::verify_removal_asset(name, bytes))
        {
            Ok(()) => 0,
            Err(e) => {
                set_last_error(e);
                5
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn names_probe_capacity_and_corruption_use_the_shared_real_fixture() {
        let records = CString::new(include_str!(
            "../../../../test-fixtures/removal/basic/records.txt"
        ))
        .unwrap();
        unsafe {
            let mut length = 777;
            assert_eq!(
                maple_removal_asset_names_buf(
                    records.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    &mut length
                ),
                100
            );
            let mut bytes = vec![17; length];
            assert_eq!(
                maple_removal_asset_names_buf(
                    records.as_ptr(),
                    bytes.as_mut_ptr(),
                    length - 1,
                    &mut length
                ),
                100
            );
            assert!(bytes.iter().all(|&byte| byte == 17));
            assert_eq!(
                maple_removal_asset_names_buf(
                    records.as_ptr(),
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut length
                ),
                0
            );
            let names: Vec<String> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(names.len(), 2);
            let name = CString::new(
                names
                    .iter()
                    .find(|name| name.ends_with(".mask"))
                    .unwrap()
                    .as_str(),
            )
            .unwrap();
            let mask = include_bytes!("../../../../test-fixtures/removal/basic/mask.mimf");
            assert_eq!(
                maple_removal_asset_verify(name.as_ptr(), mask.as_ptr(), mask.len()),
                0
            );
            assert_eq!(
                maple_removal_asset_verify(name.as_ptr(), b"wrong".as_ptr(), 5),
                5
            );
            assert_eq!(
                maple_removal_asset_verify(name.as_ptr(), std::ptr::null(), 5),
                1
            );
            let invalid = CString::new("invalid records").unwrap();
            assert_eq!(
                maple_removal_asset_names_buf(
                    invalid.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    &mut length
                ),
                5
            );
            assert_eq!(length, 0);
        }
    }

    #[test]
    fn source_verification_rejects_replaced_original_and_null() {
        let records = CString::new(include_str!(
            "../../../../test-fixtures/removal/basic/records.txt"
        ))
        .unwrap();
        let original = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let digest = CString::new(
            raw_core::types::accepted_removal::ContentDigest::for_bytes(original).as_str(),
        )
        .unwrap();
        let replaced = CString::new(
            raw_core::types::accepted_removal::ContentDigest::for_bytes(b"replaced").as_str(),
        )
        .unwrap();
        unsafe {
            assert_eq!(
                maple_removal_source_verify(records.as_ptr(), digest.as_ptr()),
                0
            );
            assert_eq!(
                maple_removal_source_verify(records.as_ptr(), replaced.as_ptr()),
                5
            );
            assert_eq!(
                maple_removal_source_verify(records.as_ptr(), std::ptr::null()),
                1
            );
        }
    }
}
