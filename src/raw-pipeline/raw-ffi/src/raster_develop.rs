//! Color-managed non-RAW editor base and shared capabilities (#3891).
use crate::{
    buffers::MapleSceneLinearBufferF32,
    cancel::{token_from_ptr, MapleCancelFlag, SendCancelPtr},
    error::{set_last_error, with_large_stack},
    scene_linear_f32_buffer::write_scene_linear_buf_f32,
};
use std::ffi::{c_char, CStr};

#[cfg(test)]
#[path = "raster_develop_tests.rs"]
mod tests;

/// Validate authored raster settings without decoding. Empty XMP means defaults.
/// # Safety
/// `xmp` must address a NUL-terminated UTF-8 string (null is rejected).
#[no_mangle]
pub unsafe extern "C" fn maple_validate_raster_adjustments(xmp: *const c_char) -> i32 {
    let result = (|| {
        if xmp.is_null() {
            return Err("missing XMP".to_string());
        }
        let xml = CStr::from_ptr(xmp).to_str().map_err(|e| e.to_string())?;
        let model = if xml.is_empty() {
            raw_core::AdjustmentModel::default()
        } else {
            raw_core::xmp::parse(xml).map_err(|e| e.to_string())?
        };
        raw_core::pipeline::validate_raster_adjustments(&model).map_err(|e| e.to_string())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            set_last_error(error);
            1
        }
    }
}

/// Decode JPEG/TIFF to oriented f32 RGBA linear Rec.2020, no authored edits.
/// Free successful output with `maple_free_scene_linear_buffer_f32`.
/// Returns 0 on success, 4 if cancelled, otherwise 1 plus same-thread error.
/// # Safety
/// `path` must address a NUL-terminated UTF-8 string; `out` must be writable.
/// A non-null cancel flag must stay alive until this synchronous call returns.
#[no_mangle]
pub unsafe extern "C" fn maple_decode_raster_base_file_f32(
    path: *const c_char,
    max_long_edge: u32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleSceneLinearBufferF32,
) -> i32 {
    if path.is_null() || out.is_null() {
        set_last_error("null raster decode argument".into());
        return 1;
    }
    let path = match CStr::from_ptr(path).to_str() {
        Ok(value) => value.to_owned(),
        Err(error) => {
            set_last_error(error.to_string());
            return 1;
        }
    };
    let out_ptr = out as usize;
    let cancel = SendCancelPtr(cancel);
    with_large_stack(move || {
        let cancel = cancel;
        let token = match token_from_ptr(cancel.0) {
            Some(flag) => raw_core::CancelToken::new(flag.as_ref()),
            None => raw_core::CancelToken::never(),
        };
        if token.is_cancelled() {
            return 4;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                set_last_error(format!("raster read: {error}"));
                return 1;
            }
        };
        match raw_core::pipeline::decode_raster_base(&bytes, max_long_edge, token) {
            Ok((width, height, rgba)) => {
                write_scene_linear_buf_f32(
                    out_ptr,
                    width,
                    height,
                    rgba,
                    None,
                    100,
                    &raw_core::stages::wb_camera::SliderFrameExport::ABSENT,
                    1.0,
                    f32::NAN,
                    1.0, // Raster develop does not run RAW profile-aware NR.
                    false,
                    true,
                    true,
                    None,
                );
                0
            }
            Err(raw_core::Error::Cancelled) => 4,
            Err(error) => {
                set_last_error(error.to_string());
                1
            }
        }
    })
}
