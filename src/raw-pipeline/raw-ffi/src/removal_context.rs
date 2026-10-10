//! Bounded fixed linear calibration context from a retained RAW (#3955).
use crate::{
    cancel::{token_from_ptr, MapleCancelFlag},
    error::{catch_panic_rc, set_last_error},
    handle::{MapleRawHandle, MapleRawHandleInner},
};
use raw_core::{cancel::CancelToken, types::accepted_removal::NativeWindow};

/// Native un-oriented DefaultCrop context: interleaved f32 RGB, fixed As-Shot
/// linear Rec.2020 calibration before user WB/HSM. The handle's creative model
/// is not baked into this experimental plate. No RAW re-decode or full-frame RGB.
/// This does not load saved patches or enable authoring (#3955 / #1472).
///
/// out_len counts f32 ELEMENTS, not bytes. Caller can allocate width*height*3
/// directly; null/short output returns 100 with the required length after a
/// successful context render. Returns 0 success, 1 null handle/output-length,
/// 5 unsupported/invalid context, 20 cancelled, 99 panic. Failure never changes
/// output pixels; out_len is cleared before validation.
///
/// # Safety
/// handle must remain open for the call, and cancel must be null or a live
/// MapleCancelFlag. out_len is writable. Non-null output is writable for cap
/// f32s. All output allocations are disjoint from the handle and cancel flag.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_calibration_context_f32(
    handle: *const MapleRawHandle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    cancel: *const MapleCancelFlag,
    output: *mut f32,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_calibration_context_f32", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        let Some(handle) = handle.as_ref() else {
            return 1;
        };
        let Some(inner) = (handle.inner as *const MapleRawHandleInner).as_ref() else {
            return 1;
        };
        if cap > isize::MAX as usize / std::mem::size_of::<f32>() {
            set_last_error("removal context output capacity exceeds an allocation".into());
            return 5;
        }
        let flag = token_from_ptr(cancel);
        let token = flag
            .as_ref()
            .map_or_else(CancelToken::never, |flag| CancelToken::new(flag.as_ref()));
        let image = match raw_core::pipeline::render_removal_calibration_context(
            &inner.raw,
            NativeWindow {
                x,
                y,
                width,
                height,
            },
            token,
        ) {
            Ok(image) => image,
            Err(raw_core::Error::Cancelled) => {
                set_last_error("removal calibration context cancelled".into());
                return 20;
            }
            Err(error) => {
                set_last_error(error.to_string());
                return 5;
            }
        };
        let len = image.pixels.len() * 3;
        *out_len = len;
        if output.is_null() || cap < len {
            return 100;
        }
        // [f32;3] has exactly three contiguous f32 lanes per pixel. Keep the
        // single context allocation; no additional RGB packing buffer.
        std::ptr::copy_nonoverlapping(image.pixels.as_ptr().cast::<f32>(), output, len);
        0
    })
}

#[cfg(test)]
#[path = "removal_context_tests.rs"]
mod tests;

/// Shared source anchor for the retained calibration experiment (#3955).
/// UTF-8 JSON, without NUL. 0 success, 1 null, 5 invalid, 100 size probe.
/// The original-byte digest was captured when this RAW handle was opened.
///
/// # Safety
/// handle remains live for this call; out_len is writable; output is writable
/// for cap bytes when non-null. All buffers are disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_calibration_source_buf(
    handle: *const MapleRawHandle,
    output: *mut u8,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_calibration_source_buf", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        let Some(handle) = handle.as_ref() else {
            return 1;
        };
        let Some(inner) = (handle.inner as *const MapleRawHandleInner).as_ref() else {
            return 1;
        };
        if cap > isize::MAX as usize {
            return 5;
        }
        let result =
            raw_core::pipeline::removal_calibration_source_anchor(&inner.raw, &inner.original)
                .map_err(|e| e.to_string())
                .and_then(|source| serde_json::to_vec(&source).map_err(|e| e.to_string()));
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(error) => {
                set_last_error(error);
                return 5;
            }
        };
        *out_len = bytes.len();
        if output.is_null() || cap < bytes.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
        0
    })
}
