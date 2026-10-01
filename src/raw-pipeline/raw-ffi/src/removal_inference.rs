//! Retained native reconstruction authoring boundary (#3941). Experimental
//! pinned graph, CPU only; no saved-edit or UI release qualification claim.
use crate::error::{catch_panic_rc, set_last_error};
use maple_removal::{OrtRuntime, RemovalReconstructor, RemovalRunOptions};
use std::{
    ffi::{c_char, c_void, CStr},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[repr(C)]
pub struct MapleRemovalReconstructor {
    inner: *mut c_void,
}
#[repr(C)]
pub struct MapleRemovalInference {
    inner: *mut c_void,
}
pub(super) struct Inference {
    pub(super) options: RemovalRunOptions,
    pub(super) cancelled: AtomicBool,
}

pub(super) unsafe fn utf8<'a>(value: *const c_char) -> Result<&'a str, String> {
    if value.is_null() {
        return Err("null model path".into());
    }
    CStr::from_ptr(value).to_str().map_err(|e| e.to_string())
}

/// Load the checksummed native 1024 LaMa graph from an explicit directory.
/// runtime is an explicit dylib path on macOS, and ignored on static iOS.
/// No download is performed. Codes: 0 success, 1 null, 5 load failure, 99 panic.
/// # Safety
/// Paths are valid NUL-terminated UTF-8; output is writable and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_reconstructor_open(
    directory: *const c_char,
    runtime: *const c_char,
    output: *mut *mut MapleRemovalReconstructor,
) -> i32 {
    catch_panic_rc("maple_removal_reconstructor_open", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let result = (|| {
            let directory = utf8(directory)?;
            let explicit = if runtime.is_null() {
                None
            } else {
                Some(Path::new(utf8(runtime)?))
            };
            let runtime = OrtRuntime::preflight(explicit).map_err(|e| e.to_string())?;
            RemovalReconstructor::load(Path::new(directory), &runtime).map_err(|e| e.to_string())
        })();
        match result {
            Ok(model) => {
                let inner = Box::into_raw(Box::new(Mutex::new(model))).cast();
                *output = Box::into_raw(Box::new(MapleRemovalReconstructor { inner }));
                0
            }
            Err(error) => {
                set_last_error(error);
                5
            }
        }
    })
}

/// Release the model after every in-flight call returns. Null is a no-op.
/// # Safety
/// model is null or an unfreed handle returned by open, exclusively owned here.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_reconstructor_close(model: *mut MapleRemovalReconstructor) {
    if !model.is_null() {
        let model = Box::from_raw(model);
        if !model.inner.is_null() {
            drop(Box::from_raw(
                model.inner.cast::<Mutex<RemovalReconstructor>>(),
            ));
        }
    }
}

/// Identity of exactly the verified graph bytes consumed by this ORT session.
/// 0 success, 1 null length, 5 invalid, 100 size probe. UTF-8, no NUL.
/// # Safety
/// model stays live; length writable, output writable for cap bytes and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_reconstructor_digest_buf(
    model: *const MapleRemovalReconstructor,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_reconstructor_digest_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        let Some(model) = model
            .as_ref()
            .and_then(|v| v.inner.cast::<Mutex<RemovalReconstructor>>().as_ref())
        else {
            return 5;
        };
        let model = match model.lock() {
            Ok(model) => model,
            Err(_) => {
                set_last_error("removal model mutex poisoned".into());
                return 5;
            }
        };
        let digest = model.model_digest().as_str();
        *length = digest.len();
        if output.is_null() || cap < digest.len() {
            return 100;
        }
        if cap > isize::MAX as usize {
            *length = 0;
            return 5;
        }
        std::ptr::copy_nonoverlapping(digest.as_ptr(), output, digest.len());
        0
    })
}

/// Create one inference operation after the model's runtime is initialized.
/// Operation flags must outlive generation and cancellation calls. Codes match
/// open. A terminated operation cannot be reused for another generation.
/// # Safety
/// model is a live open handle; output is writable and disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_inference_new(
    model: *const MapleRemovalReconstructor,
    output: *mut *mut MapleRemovalInference,
) -> i32 {
    catch_panic_rc("maple_removal_inference_new", || {
        if output.is_null() {
            return 1;
        }
        *output = std::ptr::null_mut();
        let Some(model) = model.as_ref() else {
            return 1;
        };
        if model.inner.is_null() {
            return 1;
        }
        new_operation(output)
    })
}

/// Called only after a live model/runtime was checked by its C entry point.
pub(super) unsafe fn new_operation(output: *mut *mut MapleRemovalInference) -> i32 {
    match RemovalRunOptions::new() {
        Ok(options) => {
            let inner = Box::into_raw(Box::new(Inference {
                options,
                cancelled: AtomicBool::new(false),
            }))
            .cast();
            *output = Box::into_raw(Box::new(MapleRemovalInference { inner }));
            0
        }
        Err(error) => {
            set_last_error(error.to_string());
            5
        }
    }
}

pub(super) unsafe fn operation<'a>(
    pointer: *const MapleRemovalInference,
) -> Result<&'a Inference, String> {
    pointer
        .as_ref()
        .and_then(|op| op.inner.cast::<Inference>().as_ref())
        .ok_or_else(|| "null removal operation".into())
}

/// Terminate an operation from another thread. Idempotent. Null is a no-op.
/// # Safety
/// operation is null or a live operation, not freed concurrently.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_inference_cancel(operation: *const MapleRemovalInference) {
    if let Some(inner) = operation
        .as_ref()
        .and_then(|op| op.inner.cast::<Inference>().as_ref())
    {
        inner.cancelled.store(true, Ordering::Release);
        let _ = inner.options.terminate();
    }
}

/// Release an operation after all its generation/cancellation calls return.
/// # Safety
/// operation is null or an unfreed exclusively owned operation.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_inference_free(operation: *mut MapleRemovalInference) {
    if !operation.is_null() {
        let operation = Box::from_raw(operation);
        if !operation.inner.is_null() {
            drop(Box::from_raw(operation.inner.cast::<Inference>()));
        }
    }
}

/// Generate CHW model-domain RGB. Inputs: 3*1024² float RGB in [0,1] and
/// 1024² binary hole (1=remove). The shared core owns inverse encoding/blend.
/// The output is written only after a successful, uncancelled inference.
/// Codes: 0 success, 1 null, 5 invalid/inference failure, 20 cancelled,
/// 99 panic, 100 capacity probe. out_len counts f32s. Capacity probes perform
/// no inference, avoiding a second expensive generation for buffer allocation.
/// # Safety
/// Model and operation stay live throughout the call. Input buffers are valid
/// for the stated element counts. output is writable for cap f32s; out_len is
/// writable. All these allocations are disjoint. Close/free must wait for this
/// call. Cancellation may occur concurrently through the operation pointer.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_reconstruct_f32(
    model: *const MapleRemovalReconstructor,
    operation: *const MapleRemovalInference,
    rgb: *const f32,
    rgb_len: usize,
    hole: *const f32,
    hole_len: usize,
    output: *mut f32,
    cap: usize,
    out_len: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_reconstruct_f32", || {
        if out_len.is_null() {
            return 1;
        }
        *out_len = 0;
        let Some(model) = model
            .as_ref()
            .and_then(|v| v.inner.cast::<Mutex<RemovalReconstructor>>().as_ref())
        else {
            return 1;
        };
        let Some(operation) = operation
            .as_ref()
            .and_then(|v| v.inner.cast::<Inference>().as_ref())
        else {
            return 1;
        };
        if rgb.is_null() || hole.is_null() {
            return 1;
        }
        let count = 3 * 1024 * 1024;
        if rgb_len != count || hole_len != 1024 * 1024 || cap > isize::MAX as usize / 4 {
            set_last_error("removal inference tensor size mismatch".into());
            return 5;
        }
        if operation.cancelled.load(Ordering::Acquire) {
            return 20;
        }
        *out_len = count;
        if output.is_null() || cap < count {
            return 100;
        }
        let mut model = match model.lock() {
            Ok(model) => model,
            Err(error) => {
                set_last_error(error.to_string());
                return 5;
            }
        };
        let result = model.generate(
            std::slice::from_raw_parts(rgb, rgb_len),
            std::slice::from_raw_parts(hole, hole_len),
            &operation.options,
        );
        if operation.cancelled.load(Ordering::Acquire) {
            *out_len = 0;
            return 20;
        }
        match result {
            Ok(values) => {
                std::ptr::copy_nonoverlapping(values.as_ptr(), output, count);
                0
            }
            Err(error) => {
                *out_len = 0;
                set_last_error(error.to_string());
                5
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_boundaries_reset_outputs_and_never_initialize_ort() {
        unsafe {
            let mut pointer = 1_usize as *mut MapleRemovalReconstructor;
            assert_eq!(
                maple_removal_reconstructor_open(std::ptr::null(), std::ptr::null(), &mut pointer),
                5
            );
            assert!(pointer.is_null());
            let mut operation = 1_usize as *mut MapleRemovalInference;
            assert_eq!(
                maple_removal_inference_new(std::ptr::null(), &mut operation),
                1
            );
            assert!(operation.is_null());
            let mut length = 7;
            assert_eq!(
                maple_removal_reconstruct_f32(
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut length
                ),
                1
            );
            assert_eq!(length, 0);
            maple_removal_inference_cancel(std::ptr::null());
            maple_removal_inference_free(std::ptr::null_mut());
            maple_removal_reconstructor_close(std::ptr::null_mut());
        }
    }
}
