//! Repair-spot entries for the Android bridge (#5904): read and write the
//! sidecar's `crs:RetouchAreas` through `retouch_document`, with the same
//! JSON-in/JSON-out contract as the mask entries. The Heal canvas places spots
//! through the mask overlay's frame map (`mask_jni::presentation_to_frame`).
use crate::mask_jni::json_call;
use std::ffi::c_char;

/// `{"spots": [...]}` for the repair containers described by `input`.
#[no_mangle]
pub unsafe extern "C" fn maple_android_retouch_read(input: *const c_char) -> *mut c_char {
    json_call(input, crate::retouch_document::read)
}

/// `{"containers": [...], "appended": [...]}` replacing the input containers.
#[no_mangle]
pub unsafe extern "C" fn maple_android_retouch_write(input: *const c_char) -> *mut c_char {
    json_call(input, crate::retouch_write::write)
}

#[cfg(test)]
#[path = "retouch_jni_tests.rs"]
mod tests;
