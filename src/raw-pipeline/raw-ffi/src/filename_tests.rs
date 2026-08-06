//! Tests for the `maple_render_filename_template` / `maple_validate_filename`
//! FFI entries (#2628). Each test drives the C ABI with `CString` inputs and
//! checks the marshalled output against `raw_core::filename` called
//! directly — the FFI layer is pure marshalling, so these mainly guard the
//! pointer/length plumbing and error-code mapping, not engine correctness
//! (which `raw-core`'s own extensive `filename` test suite already covers).

use crate::filename::{
    maple_free_filename_result, maple_render_filename_template, maple_validate_filename,
};
use std::ffi::CString;

unsafe fn render(
    template: &str,
    original_stem: &str,
    ext: &str,
    captured_at: Option<&str>,
    sequence_start: u64,
    sequence_index: u64,
    sequence_pad_width: usize,
) -> Result<String, i32> {
    let template_c = CString::new(template).unwrap();
    let stem_c = CString::new(original_stem).unwrap();
    let ext_c = CString::new(ext).unwrap();
    let captured_c = captured_at.map(|s| CString::new(s).unwrap());
    let captured_ptr = captured_c
        .as_ref()
        .map(|c| c.as_ptr())
        .unwrap_or(std::ptr::null());

    let mut result = maple_render_filename_template(
        template_c.as_ptr(),
        stem_c.as_ptr(),
        ext_c.as_ptr(),
        captured_ptr,
        sequence_start,
        sequence_index,
        sequence_pad_width,
    );

    let outcome = if result.error_code == 0 {
        let bytes = std::slice::from_raw_parts(result.name_ptr, result.name_len);
        Ok(std::str::from_utf8(bytes).unwrap().to_string())
    } else {
        Err(result.error_code)
    };
    maple_free_filename_result(&mut result as *mut _);
    outcome
}

#[test]
fn renders_a_basic_template() {
    let got = unsafe { render("{original}.{ext}", "IMG_0001", "dng", None, 0, 0, 0) }.unwrap();
    assert_eq!(got, "IMG_0001.dng");
}

#[test]
fn renders_sequence_with_padding_and_start() {
    let got = unsafe { render("photo_{n}.{ext}", "x", "jpg", None, 10, 3, 3) }.unwrap();
    // n = start(10) + index(3) = 13, padded to 3 digits.
    assert_eq!(got, "photo_013.jpg");
}

#[test]
fn renders_date_token_from_captured_at() {
    let got = unsafe {
        render(
            "{date:%Y-%m-%d}.{ext}",
            "x",
            "dng",
            Some("2024:06:01 12:34:56"),
            0,
            0,
            0,
        )
    }
    .unwrap();
    assert_eq!(got, "2024-06-01.dng");
}

#[test]
fn missing_captured_at_falls_back_not_an_error() {
    let got = unsafe { render("{date:%Y}", "x", "dng", None, 0, 0, 0) }.unwrap();
    assert_eq!(got, "unknown-date");
}

#[test]
fn matches_raw_core_directly() {
    let inputs = raw_core::filename::RenderInputs {
        original_stem: "IMG_0042",
        ext: "cr3",
        index: 7,
        captured_at: Some("2023:11:02 08:15:00"),
    };
    let sequence = raw_core::filename::SequenceOptions {
        start: 1,
        pad_width: 4,
    };
    let expected = raw_core::filename::render_filename(
        "{date:%Y%m%d}_{original}_{n}.{ext}",
        &inputs,
        &sequence,
    )
    .unwrap();

    let got = unsafe {
        render(
            "{date:%Y%m%d}_{original}_{n}.{ext}",
            "IMG_0042",
            "cr3",
            Some("2023:11:02 08:15:00"),
            1,
            7,
            4,
        )
    }
    .unwrap();
    assert_eq!(got, expected);
}

#[test]
fn unknown_token_maps_to_error_code_2() {
    let err = unsafe { render("{bogus}", "x", "dng", None, 0, 0, 0) }.unwrap_err();
    assert_eq!(err, 2);
}

#[test]
fn reserved_name_maps_to_error_code_7() {
    let err = unsafe { render("CON", "x", "dng", None, 0, 0, 0) }.unwrap_err();
    assert_eq!(err, 7);
}

#[test]
fn path_separator_maps_to_error_code_4() {
    let err = unsafe { render("sub/name", "x", "dng", None, 0, 0, 0) }.unwrap_err();
    assert_eq!(err, 4);
}

#[test]
fn sequence_pad_width_at_the_maximum_succeeds() {
    let max = raw_core::filename::MAX_SEQUENCE_PAD_WIDTH;
    let got = unsafe { render("{n}", "x", "dng", None, 0, 0, max) }.unwrap();
    assert_eq!(got.len(), max);
}

#[test]
fn sequence_pad_width_just_past_the_maximum_maps_to_error_code_8() {
    let max = raw_core::filename::MAX_SEQUENCE_PAD_WIDTH;
    let err = unsafe { render("{n}", "x", "dng", None, 0, 0, max + 1) }.unwrap_err();
    assert_eq!(err, 8);
}

#[test]
fn null_required_pointer_maps_to_negative_one() {
    let ext_c = CString::new("dng").unwrap();
    let mut result = unsafe {
        maple_render_filename_template(
            std::ptr::null(),
            std::ptr::null(),
            ext_c.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
        )
    };
    assert_eq!(result.error_code, -1);
    assert!(result.name_ptr.is_null());
    unsafe { maple_free_filename_result(&mut result as *mut _) };
}

#[test]
fn validate_filename_accepts_an_ordinary_name() {
    let name = CString::new("IMG_0001.dng").unwrap();
    let rc = unsafe { maple_validate_filename(name.as_ptr()) };
    assert_eq!(rc, 0);
}

#[test]
fn validate_filename_rejects_reserved_name_with_code_7() {
    let name = CString::new("NUL").unwrap();
    let rc = unsafe { maple_validate_filename(name.as_ptr()) };
    assert_eq!(rc, 7);
}

#[test]
fn validate_filename_rejects_null_pointer() {
    let rc = unsafe { maple_validate_filename(std::ptr::null()) };
    assert_eq!(rc, -1);
}

#[test]
fn free_filename_result_is_a_noop_on_null() {
    unsafe { maple_free_filename_result(std::ptr::null_mut()) };
}
