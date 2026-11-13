use super::*;
use std::ffi::CString;
const RECORDS: &str = include_str!("../../../../test-fixtures/removal/calibration/records.txt");

unsafe fn result(call: impl Fn(*mut u8, usize, *mut usize) -> i32) -> String {
    let mut length = 999;
    assert_eq!(call(std::ptr::null_mut(), 0, &mut length), 100);
    let mut bytes = vec![42; length];
    assert_eq!(call(bytes.as_mut_ptr(), length - 1, &mut length), 100);
    assert!(bytes.iter().all(|byte| *byte == 42));
    assert_eq!(call(bytes.as_mut_ptr(), bytes.len(), &mut length), 0);
    String::from_utf8(bytes).unwrap()
}

#[test]
fn actual_list_edit_prefix_and_unchanged_short_buffers_match_rust() {
    let records = CString::new(RECORDS).unwrap();
    unsafe {
        let listed = result(|output, cap, length| {
            maple_removal_saved_list_buf(records.as_ptr(), output, cap, length)
        });
        assert_eq!(
            listed,
            raw_core::pipeline::saved_removal_list(RECORDS).unwrap()
        );
        let entries: serde_json::Value = serde_json::from_str(&listed).unwrap();
        let id = CString::new(entries[0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(
            result(|output, cap, length| maple_removal_saved_prefix_buf(
                records.as_ptr(),
                id.as_ptr(),
                output,
                cap,
                length
            )),
            "[]"
        );
        let request = CString::new(serde_json::json!({"schema":1,"id":entries[0]["id"],"action":"set-active","active":false}).to_string()).unwrap();
        let edited = result(|output, cap, length| {
            maple_removal_saved_edit_buf(records.as_ptr(), request.as_ptr(), output, cap, length)
        });
        assert_eq!(
            edited,
            raw_core::pipeline::edit_saved_removal(RECORDS, request.to_str().unwrap()).unwrap()
        );
        assert!(!raw_core::types::inpaint::decode_removals(&edited).unwrap()[0].is_active());
    }
}

#[test]
fn null_invalid_utf8_and_bad_requests_do_not_write_partial_output() {
    let records = CString::new(RECORDS).unwrap();
    let bad = CString::new("not JSON").unwrap();
    let invalid_utf8 = [255u8, 0];
    unsafe {
        let mut length = 999;
        let mut output = [42u8; 32];
        assert_eq!(
            maple_removal_saved_list_buf(
                records.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                std::ptr::null_mut()
            ),
            1
        );
        assert_eq!(
            maple_removal_saved_list_buf(
                std::ptr::null(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            1
        );
        assert_eq!(length, 0);
        assert_eq!(
            maple_removal_saved_list_buf(
                invalid_utf8.as_ptr().cast(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            5
        );
        assert_eq!(length, 0);
        assert_eq!(
            maple_removal_saved_edit_buf(
                records.as_ptr(),
                bad.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            5
        );
        assert_eq!(length, 0);
        assert_eq!(
            maple_removal_saved_prefix_buf(
                records.as_ptr(),
                bad.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            5
        );
        assert_eq!(length, 0);
        assert_eq!(
            maple_removal_saved_edit_buf(
                records.as_ptr(),
                std::ptr::null(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            1
        );
        assert_eq!(
            maple_removal_saved_prefix_buf(
                records.as_ptr(),
                std::ptr::null(),
                output.as_mut_ptr(),
                output.len(),
                &mut length
            ),
            1
        );
        assert_eq!(output, [42; 32]);
    }
}
