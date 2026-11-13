//! The capture decode with its refine base (#5381). The base is the input of
//! the chroma prefilter, BM3D and capture-sharpening stages, so a host that
//! keeps it can refine those three on the GPU
//! (`maple_gpu_capture_refine`) instead of re-developing the RAW when one of
//! them changes. Arguments and return codes are the capture entries' (see
//! `capture_f32.rs`), except that a zero `max_long_edge` means full
//! resolution.

use crate::cancel::MapleCancelFlag;
use crate::capture_creative::MapleCaptureBufferF32;
use crate::capture_f32::{bytes_entry, file_entry, DecodeExports, Develop};
use raw_core::pipeline::CaptureBase;
use std::ffi::c_char;

/// Opaque refine base, owned by the host from the decode that produced it
/// until [`maple_free_capture_base`]. Read-only once created, so a refine
/// may run on it from any thread.
pub struct MapleCaptureBase {
    pub(crate) base: CaptureBase,
    pub(crate) exports: DecodeExports,
}

impl MapleCaptureBase {
    pub(crate) fn boxed(base: CaptureBase, exports: DecodeExports) -> *mut Self {
        Box::into_raw(Box::new(Self { base, exports }))
    }
}

fn develop(quality_preview: i32, max_long_edge: u32) -> Develop {
    Develop {
        quality_preview,
        max_long_edge: (max_long_edge > 0).then_some(max_long_edge),
    }
}

/// [`crate::capture_f32::maple_render_file_capture_sized_f32`] (or the
/// full-resolution decode for `max_long_edge == 0`) that also writes the
/// decode's refine base to `*base_out` (null on any failure). Free the base
/// with [`maple_free_capture_base`].
///
/// # Safety
/// As for `maple_render_file_capture_f32`; `base_out` writable.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_capture_base_f32(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
    base_out: *mut *mut MapleCaptureBase,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_file_capture_base_f32", || {
        if let Some(slot) = base_out.as_mut() {
            *slot = std::ptr::null_mut();
        }
        file_entry(
            raw_path,
            xmp_path,
            develop(quality_preview, max_long_edge),
            cancel,
            (out, Some(base_out)),
        )
    })
}

/// The bytes sibling of [`maple_render_file_capture_base_f32`].
///
/// # Safety
/// As for `maple_render_bytes_capture_f32`; `base_out` writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_render_bytes_capture_base_f32(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
    base_out: *mut *mut MapleCaptureBase,
) -> i32 {
    crate::error::catch_panic_rc("maple_render_bytes_capture_base_f32", || {
        if let Some(slot) = base_out.as_mut() {
            *slot = std::ptr::null_mut();
        }
        bytes_entry(
            (raw_bytes, raw_len, hint_ext),
            xmp_path,
            develop(quality_preview, max_long_edge),
            cancel,
            (out, Some(base_out)),
        )
    })
}

/// Free a refine base. Null is a no-op.
///
/// # Safety
/// `base` null or from a capture-base entry, not used afterwards and with
/// no refine running on it.
#[no_mangle]
pub unsafe extern "C" fn maple_free_capture_base(base: *mut MapleCaptureBase) {
    if !base.is_null() {
        let _ = crate::error::catch_panic_rc("maple_free_capture_base", || {
            drop(Box::from_raw(base));
            0
        });
    }
}

#[cfg(test)]
#[path = "capture_base_tests.rs"]
pub(crate) mod tests;
