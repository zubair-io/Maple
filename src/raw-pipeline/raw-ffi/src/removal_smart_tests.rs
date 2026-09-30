use super::*;
use std::ffi::CString;

const REQUEST: &str = r#"{"schema":1,"source_width":1024,"source_height":1024,"window":{"x":0,"y":0,"width":1024,"height":1024},"input_width":1024,"input_height":1024,"prompts":[{"position":[0.50048828125,0.50048828125],"label":1},{"position":[0.60009765625,0.50048828125],"label":0}]}"#;

#[test]
fn ffi_prompts_preserve_negative_and_never_overwrite_insufficient_output() {
    let request = CString::new(REQUEST).unwrap();
    let mut len = 0;
    let mut output = [0xab; 2];
    unsafe {
        assert_eq!(
            maple_removal_smart_prompts_buf(
                request.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                &mut len
            ),
            100
        );
    }
    assert_eq!(output, [0xab; 2]);
    let mut bytes = vec![0; len];
    unsafe {
        assert_eq!(
            maple_removal_smart_prompts_buf(
                request.as_ptr(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len
            ),
            0
        );
    }
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        raw_core::stages::removal_smart::model_prompts_json(REQUEST).unwrap()
    );
}

#[test]
fn ffi_native_mask_matches_shared_codec_and_invalid_output_clears_length() {
    let request = CString::new(REQUEST).unwrap();
    let mut logits = vec![-1.0; 4 * 1024 * 1024];
    logits[512 * 1024 + 512] = 1.0;
    let scores = [0.9, 0.1, 0.2, 0.3];
    let mut len = 0;
    unsafe {
        assert_eq!(
            maple_removal_smart_mask_buf(
                request.as_ptr(),
                logits.as_ptr(),
                logits.len(),
                scores.as_ptr(),
                scores.len(),
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
            maple_removal_smart_mask_buf(
                request.as_ptr(),
                logits.as_ptr(),
                logits.len(),
                scores.as_ptr(),
                scores.len(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len
            ),
            0
        );
    }
    assert_eq!(
        bytes,
        raw_core::stages::removal_smart::mask_from_logits_json(REQUEST, &logits, &scores).unwrap()
    );
    // Malformed lengths are rejected BEFORE reading a four-plane buffer.
    let tiny = [1.0];
    len = 99;
    unsafe {
        assert_eq!(
            maple_removal_smart_mask_buf(
                request.as_ptr(),
                tiny.as_ptr(),
                usize::MAX,
                scores.as_ptr(),
                4,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len
            ),
            5
        );
    }
    assert_eq!(len, 0);
    logits[0] = f32::INFINITY;
    len = 99;
    unsafe {
        assert_eq!(
            maple_removal_smart_mask_buf(
                request.as_ptr(),
                logits.as_ptr(),
                logits.len(),
                scores.as_ptr(),
                4,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len
            ),
            5
        );
    }
    assert_eq!(len, 0);
}

#[test]
fn ffi_null_request_clears_length_without_dereferencing_model_buffers() {
    let mut len = 99;
    unsafe {
        assert_eq!(
            maple_removal_smart_mask_buf(
                std::ptr::null(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut len
            ),
            1
        );
        assert_eq!(
            maple_removal_smart_prompts_buf(std::ptr::null(), std::ptr::null_mut(), 0, &mut len),
            1
        );
    }
    assert_eq!(len, 0);
}
