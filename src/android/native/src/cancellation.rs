//! Independent host signal: UI cancellation never aliases a worker-owned Session.
use raw_gpu::CancelToken;
use std::{ffi::c_void, sync::atomic::Ordering};

#[no_mangle]
pub extern "C" fn maple_android_cancel_new() -> *mut c_void {
    Box::into_raw(Box::new(CancelToken::new())).cast()
}

// The Kotlin owner serializes set/free and frees only after worker teardown.
#[no_mangle]
pub unsafe extern "C" fn maple_android_cancel_set(handle: *const c_void, value: bool) {
    if let Some(token) = handle.cast::<CancelToken>().as_ref() {
        token.flag().store(value, Ordering::Release);
    }
}

#[no_mangle]
pub unsafe extern "C" fn maple_android_cancel_free(handle: *mut c_void) {
    if !handle.is_null() {
        drop(Box::from_raw(handle.cast::<CancelToken>()));
    }
}

pub unsafe fn token<'a>(handle: *const c_void) -> Result<&'a CancelToken, String> {
    handle
        .cast::<CancelToken>()
        .as_ref()
        .ok_or_else(|| "Closed render cancellation".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_signal_is_shared_by_cpu_gpu_and_other_threads() {
        let handle = maple_android_cancel_new();
        let gpu = unsafe { token(handle).unwrap().clone() };
        assert!(!gpu.is_cancelled());
        let address = handle as usize;
        std::thread::spawn(move || unsafe {
            maple_android_cancel_set(address as *const c_void, true)
        })
        .join()
        .unwrap();
        assert!(gpu.is_cancelled());
        assert!(raw_core::CancelToken::new(gpu.flag()).is_cancelled());
        unsafe {
            maple_android_cancel_set(handle, false);
        }
        assert!(!gpu.is_cancelled());
        unsafe {
            maple_android_cancel_free(handle);
        }
        // An in-flight GPU clone retains the atomic through owner teardown.
        assert!(!gpu.is_cancelled());
    }
}
