use super::*;
use crate::{
    cancel::{maple_cancel_flag_free, maple_cancel_flag_new, maple_cancel_flag_set},
    handle::{maple_close_raw_handle, maple_open_raw_handle, maple_open_raw_handle_bytes},
};
use std::ffi::CString;

struct Handle(*mut MapleRawHandle);
impl Handle {
    fn open() -> Self {
        let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let ext = CString::new("dng").unwrap();
        let mut handle = std::ptr::null_mut();
        assert_eq!(
            unsafe {
                maple_open_raw_handle_bytes(
                    bytes.as_ptr(),
                    bytes.len(),
                    ext.as_ptr(),
                    std::ptr::null(),
                    &mut handle,
                )
            },
            0
        );
        assert!(!handle.is_null());
        Self(handle)
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            maple_close_raw_handle(self.0);
        }
    }
}

#[test]
fn retained_source_anchor_matches_core_and_never_writes_short_output() {
    let handle = Handle::open();
    let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
    let original = raw_core::types::accepted_removal::ContentDigest::for_bytes(bytes);
    let raw = raw_core::decode_raw(bytes, "dng").unwrap();
    let expected = raw_core::pipeline::removal_calibration_source_anchor(&raw, &original).unwrap();
    let mut length = 99;
    assert_eq!(
        unsafe {
            maple_removal_calibration_source_buf(handle.0, std::ptr::null_mut(), 0, &mut length)
        },
        100
    );
    let mut output = vec![42; length];
    let capacity = output.len();
    assert_eq!(
        unsafe {
            maple_removal_calibration_source_buf(
                handle.0,
                output.as_mut_ptr(),
                capacity - 1,
                &mut length,
            )
        },
        100
    );
    assert!(output.iter().all(|v| *v == 42));
    assert_eq!(
        unsafe {
            maple_removal_calibration_source_buf(
                handle.0,
                output.as_mut_ptr(),
                capacity,
                &mut length,
            )
        },
        0
    );
    let actual: raw_core::types::accepted_removal::SourceAnchor =
        serde_json::from_slice(&output).unwrap();
    assert_eq!(actual, expected);
    unsafe {
        (*((*handle.0).inner as *mut MapleRawHandleInner))
            .model
            .exposure = 2.0;
    }
    assert_eq!(
        unsafe {
            maple_removal_calibration_source_buf(
                handle.0,
                output.as_mut_ptr(),
                capacity,
                &mut length,
            )
        },
        0
    );
    assert_eq!(
        serde_json::from_slice::<raw_core::types::accepted_removal::SourceAnchor>(&output).unwrap(),
        expected
    );
    assert_eq!(
        unsafe {
            maple_removal_calibration_source_buf(
                std::ptr::null(),
                output.as_mut_ptr(),
                capacity,
                &mut length,
            )
        },
        1
    );
    assert_eq!(length, 0);
}

#[test]
fn file_and_bytes_handles_bind_the_same_opened_original() {
    let path = CString::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-fixtures/removal/basic/source.dng"
    ))
    .unwrap();
    let mut file = std::ptr::null_mut();
    assert_eq!(
        unsafe { maple_open_raw_handle(path.as_ptr(), std::ptr::null(), &mut file) },
        0
    );
    let file = Handle(file);
    let bytes = Handle::open();
    let anchor = |handle: &Handle| {
        let mut length = 0;
        assert_eq!(
            unsafe {
                maple_removal_calibration_source_buf(handle.0, std::ptr::null_mut(), 0, &mut length)
            },
            100
        );
        let mut output = vec![0; length];
        assert_eq!(
            unsafe {
                maple_removal_calibration_source_buf(
                    handle.0,
                    output.as_mut_ptr(),
                    output.len(),
                    &mut length,
                )
            },
            0
        );
        output
    };
    assert_eq!(anchor(&file), anchor(&bytes));
}

#[test]
fn real_retained_raw_context_matches_core_and_excludes_creative_model() {
    let handle = Handle::open();
    let mut len = 99;
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                &mut len,
            )
        },
        100
    );
    assert_eq!(len, 7 * 5 * 3);
    let mut pixels = vec![42.0_f32; len];
    let mut short = vec![37.0_f32; len - 1];
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                short.as_mut_ptr(),
                short.len(),
                &mut len,
            )
        },
        100
    );
    assert_eq!(short, vec![37.0; len - 1]);
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut len,
            )
        },
        0
    );
    let bytes = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
    let raw = raw_core::decode_raw(bytes, "dng").unwrap();
    let image = raw_core::pipeline::render_removal_calibration_context(
        &raw,
        NativeWindow {
            x: 1,
            y: 1,
            width: 7,
            height: 5,
        },
        CancelToken::never(),
    )
    .unwrap();
    assert_eq!(
        pixels,
        image.pixels.into_iter().flatten().collect::<Vec<_>>()
    );
    unsafe {
        let inner = &mut *((*handle.0).inner as *mut MapleRawHandleInner);
        inner.model.exposure = 3.0;
        inner.model.temperature = 9500.0;
        inner.model.tint = -80.0;
        inner.model.saturation = -100.0;
    }
    let mut graded = vec![0.0; len];
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                graded.as_mut_ptr(),
                graded.len(),
                &mut len,
            )
        },
        0
    );
    assert_eq!(graded, pixels);
}

#[test]
fn cancellation_geometry_nulls_and_capacity_fail_without_pixel_writes() {
    let handle = Handle::open();
    let mut pixels = vec![42.0_f32; 7 * 5 * 3];
    let mut len = 9;
    for (x, y, w, h) in [(u32::MAX, 0, 7, 5), (0, 0, 1025, 1), (0, 0, 0, 5)] {
        assert_eq!(
            unsafe {
                maple_removal_calibration_context_f32(
                    handle.0,
                    x,
                    y,
                    w,
                    h,
                    std::ptr::null(),
                    pixels.as_mut_ptr(),
                    pixels.len(),
                    &mut len,
                )
            },
            5
        );
        assert_eq!(len, 0);
        assert!(pixels.iter().all(|v| *v == 42.0));
    }
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                std::ptr::null(),
                1,
                1,
                7,
                5,
                std::ptr::null(),
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut len,
            )
        },
        1
    );
    assert_eq!(len, 0);
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                pixels.as_mut_ptr(),
                pixels.len(),
                std::ptr::null_mut(),
            )
        },
        1
    );
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                std::ptr::null(),
                pixels.as_mut_ptr(),
                usize::MAX,
                &mut len,
            )
        },
        5
    );
    assert_eq!(len, 0);
    let flag = maple_cancel_flag_new();
    unsafe {
        maple_cancel_flag_set(flag);
    }
    assert_eq!(
        unsafe {
            maple_removal_calibration_context_f32(
                handle.0,
                1,
                1,
                7,
                5,
                flag,
                pixels.as_mut_ptr(),
                pixels.len(),
                &mut len,
            )
        },
        20
    );
    assert_eq!(len, 0);
    assert!(pixels.iter().all(|v| *v == 42.0));
    unsafe {
        maple_cancel_flag_free(flag);
    }
}
