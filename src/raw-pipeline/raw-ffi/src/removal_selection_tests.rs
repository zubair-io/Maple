use super::*;
use std::ffi::CString;

const REQUEST: &str =
    r#"{"schema":1,"strokes":[{"points":[[0.2,0.5],[0.8,0.5]],"radius":0.05,"subtract":false}]}"#;

#[test]
fn ffi_selection_matches_shared_codec_and_decodes_native_geometry() {
    let request = CString::new(REQUEST).unwrap();
    let mut len = 0;
    unsafe {
        assert_eq!(
            maple_removal_selection_buf(
                100,
                50,
                request.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut len
            ),
            100
        );
    }
    let mut bytes = vec![0; len];
    unsafe {
        assert_eq!(
            maple_removal_selection_buf(
                100,
                50,
                request.as_ptr(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len
            ),
            0
        );
    }
    assert_eq!(
        bytes,
        raw_core::stages::removal_selection::rasterize_json(100, 50, REQUEST).unwrap()
    );
    let mask = raw_core::pipeline::removal_mask_from_bytes(&bytes).unwrap();
    let mut window = [0u32; 6];
    unsafe {
        assert_eq!(
            maple_removal_mask_decode_buf(
                bytes.as_ptr(),
                bytes.len(),
                std::ptr::null_mut(),
                0,
                &mut len,
                window.as_mut_ptr()
            ),
            100
        );
    }
    assert_eq!(window, [100, 50, mask.x, mask.y, mask.width, mask.height]);
    let mut pixels = vec![0; len];
    unsafe {
        assert_eq!(
            maple_removal_mask_decode_buf(
                bytes.as_ptr(),
                bytes.len(),
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut len,
                window.as_mut_ptr()
            ),
            0
        );
    }
    assert_eq!(pixels, mask.pixels);
}

#[test]
fn too_small_output_is_untouched_and_reports_required_size() {
    let request = CString::new(REQUEST).unwrap();
    let mut byte = 0xab;
    let mut len = 0;
    unsafe {
        assert_eq!(
            maple_removal_selection_buf(100, 50, request.as_ptr(), &mut byte, 1, &mut len),
            100
        );
    }
    assert_eq!(byte, 0xab);
    assert!(len > 1);
}

#[test]
fn empty_selection_returns_success_without_a_zero_dimension_asset() {
    let request = CString::new(r#"{"schema":1,"strokes":[]}"#).unwrap();
    let mut len = 99;
    unsafe {
        assert_eq!(
            maple_removal_selection_buf(
                100,
                50,
                request.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut len
            ),
            0
        );
    }
    assert_eq!(len, 0);
}

#[test]
fn malformed_request_or_asset_clears_output_metadata() {
    for invalid in [
        r#"{"schema":2,"strokes":[]}"#,
        r#"{"schema":1,"strokes":[{}]}"#,
        "not json",
    ] {
        let request = CString::new(invalid).unwrap();
        let mut len = 99;
        unsafe {
            assert_eq!(
                maple_removal_selection_buf(
                    100,
                    50,
                    request.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    &mut len
                ),
                5
            );
        }
        assert_eq!(len, 0);
    }
    let mut len = 99;
    let mut window = [99u32; 6];
    let invalid = [0u8; 32];
    unsafe {
        assert_eq!(
            maple_removal_mask_decode_buf(
                invalid.as_ptr(),
                invalid.len(),
                std::ptr::null_mut(),
                0,
                &mut len,
                window.as_mut_ptr()
            ),
            5
        );
    }
    assert_eq!(len, 0);
    assert_eq!(window, [0; 6]);
}

#[test]
fn null_guards_do_not_dereference_pointers() {
    let mut len = 99;
    unsafe {
        assert_eq!(
            maple_removal_selection_buf(
                100,
                50,
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                &mut len
            ),
            1
        );
        assert_eq!(len, 0);
        assert_eq!(
            maple_removal_selection_buf(
                100,
                50,
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut()
            ),
            1
        );
        assert_eq!(
            maple_removal_mask_decode_buf(
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut len,
                std::ptr::null_mut()
            ),
            1
        );
    }
}
