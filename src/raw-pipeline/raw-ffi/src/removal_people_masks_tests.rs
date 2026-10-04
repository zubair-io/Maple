use super::*;
use serde_json::json;
use std::ffi::CString;

fn inputs() -> (CString, Vec<u8>) {
    let masks: Vec<_> = [0.02, 0.27].iter().map(|x| {
        raw_core::stages::removal_selection::rasterize_json(1000, 1000,
            &json!({"schema":1,"strokes":[{"points":[[x,0.45]],"radius":0.001,"subtract":false}]}).to_string()).unwrap()
    }).collect();
    let request = json!({"schema":1,"source_width":1000,"source_height":1000,
        "detections":[{"class":0,"score":0.98,"bounds":[0,0,300,900]},
                      {"class":0,"score":0.92,"bounds":[250,400,300,550]}],
        "mask_lengths":masks.iter().map(Vec::len).collect::<Vec<_>>()});
    (CString::new(request.to_string()).unwrap(), masks.concat())
}

#[test]
fn ffi_mask_roles_match_core_without_writing_short_output() {
    let (request, masks) = inputs();
    let mut length = 0;
    let mut short = [0xab; 2];
    let rc = unsafe {
        maple_removal_people_mask_suggestions_buf(
            request.as_ptr(),
            masks.as_ptr(),
            masks.len(),
            short.as_mut_ptr(),
            short.len(),
            &mut length,
        )
    };
    assert_eq!(rc, 100);
    assert_eq!(short, [0xab; 2]);
    let mut out = vec![0; length];
    let rc = unsafe {
        maple_removal_people_mask_suggestions_buf(
            request.as_ptr(),
            masks.as_ptr(),
            masks.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut length,
        )
    };
    assert_eq!(rc, 0);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        raw_core::stages::removal_people_masks::suggest_json(request.to_str().unwrap(), &masks)
            .unwrap()
    );
}

#[test]
fn ffi_mask_roles_reject_invalid_or_null_inputs_without_output() {
    let (request, masks) = inputs();
    let mut length = 77;
    let mut out = [0xab; 256];
    let invalid = CString::new("{}").unwrap();
    let rc = unsafe {
        maple_removal_people_mask_suggestions_buf(
            invalid.as_ptr(),
            masks.as_ptr(),
            masks.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut length,
        )
    };
    assert_eq!((rc, length), (5, 0));
    assert_eq!(out, [0xab; 256]);
    let rc = unsafe {
        maple_removal_people_mask_suggestions_buf(
            request.as_ptr(),
            std::ptr::null(),
            masks.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut length,
        )
    };
    assert_eq!((rc, length), (1, 0));
    let rc = unsafe {
        maple_removal_people_mask_suggestions_buf(
            request.as_ptr(),
            masks.as_ptr(),
            usize::MAX,
            out.as_mut_ptr(),
            out.len(),
            &mut length,
        )
    };
    assert_eq!((rc, length), (5, 0));
    assert_eq!(out, [0xab; 256]);
}
