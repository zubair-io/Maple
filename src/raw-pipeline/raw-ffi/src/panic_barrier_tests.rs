//! #4734 — a panic inside a raw-ffi entry returns the panic rc (or the
//! entry's null/error value) with the message in `maple_last_error`, instead
//! of unwinding out of the `extern "C"` frame and aborting the host.

use std::ffi::CStr;

use crate::error::{catch_panic, catch_panic_rc, maple_last_error, RC_PANICKED};
use crate::raster::maple_raster_extract_tensor_buf;

fn last_error() -> String {
    unsafe { CStr::from_ptr(maple_last_error()) }
        .to_string_lossy()
        .into_owned()
}

/// Shaped like a real entry: the panic must stop at the barrier inside this
/// `extern "C"` frame, or the test binary aborts.
unsafe extern "C" fn panicking_entry_rc() -> i32 {
    catch_panic_rc("panicking_entry_rc", || {
        let decoded: Option<i32> = std::hint::black_box(None);
        decoded.expect("decoder invariant violated")
    })
}

unsafe extern "C" fn panicking_entry_ptr() -> *mut u8 {
    catch_panic("panicking_entry_ptr", std::ptr::null_mut(), || {
        panic!("handle construction failed")
    })
}

#[test]
fn panicking_rc_entry_returns_panic_rc() {
    assert_eq!(unsafe { panicking_entry_rc() }, RC_PANICKED);
    assert_eq!(
        last_error(),
        "panicking_entry_rc: panicked: decoder invariant violated"
    );
}

#[test]
fn panicking_pointer_entry_returns_null() {
    assert!(unsafe { panicking_entry_ptr() }.is_null());
    assert_eq!(
        last_error(),
        "panicking_entry_ptr: panicked: handle construction failed"
    );
}

#[test]
fn extract_tensor_rejects_misaligned_f32_out_buf() {
    let input = [0u8; 16];
    let mut backing = [0f32; 8];
    let misaligned = unsafe { (backing.as_mut_ptr() as *mut u8).add(1) } as *mut f32;
    let mut out_len = 0usize;
    let rc = unsafe {
        maple_raster_extract_tensor_buf(
            input.as_ptr(),
            input.len(),
            1,
            0,
            0,
            misaligned,
            4,
            &mut out_len,
        )
    };
    assert_eq!(rc, 7);
    assert_eq!(last_error(), "out_buf is not aligned for f32");
}
