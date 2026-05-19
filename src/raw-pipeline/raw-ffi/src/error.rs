//! Error reporting + worker-thread plumbing shared by every FFI entry.
//!
//! `LAST_ERROR` is a thread-local CString so the C ABI can hand callers a
//! stable `const char*` between calls; `maple_last_error()` reads it.
//! `with_large_stack` runs render work on a dedicated 16 MB-stack worker
//! so heavy decoders (CR3 / DNG with multi-MB Huffman tables) don't
//! blow Swift's default cooperative-pool stack.

use std::cell::RefCell;
use std::ffi::c_char;

thread_local! {
    pub(crate) static LAST_ERROR: RefCell<Option<std::ffi::CString>> = const { RefCell::new(None) };
}

pub(crate) fn set_last_error(msg: String) {
    if let Ok(cstr) = std::ffi::CString::new(msg) {
        LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
    }
}

/// Stack size for the worker thread that runs RAW decode + develop. Rawler's
/// per-format decoders (CR3 in particular) allocate several MB of Huffman /
/// JPEG-LS scratch on the stack, and Swift's cooperative-pool threads start
/// with ~512 KB — which trips an EXC_BAD_ACCESS / stack overflow on real RAWs.
/// 16 MB is plenty; physical memory is only committed on demand.
const WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

/// Run a render closure on a dedicated thread with a large stack, then
/// propagate both its return value and any `LAST_ERROR` it set back to the
/// caller. Each FFI entrypoint uses this wrapper so callers don't need to
/// think about stack sizes.
pub(crate) fn with_large_stack<F>(work: F) -> i32
where
    F: FnOnce() -> i32 + Send + 'static,
{
    let handle = std::thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .name("maple-ffi-decode".to_string())
        .spawn(move || {
            let rc = work();
            // Ferry the worker's thread-local last error out to the caller
            // thread so `maple_last_error` still reports useful messages.
            let err = LAST_ERROR.with(|e| e.borrow().clone());
            (rc, err)
        });
    match handle {
        Ok(h) => match h.join() {
            Ok((rc, err)) => {
                if let Some(cstr) = err {
                    LAST_ERROR.with(|e| *e.borrow_mut() = Some(cstr));
                }
                rc
            }
            Err(_) => {
                set_last_error("render worker panicked".into());
                99
            }
        },
        Err(e) => {
            set_last_error(format!("spawn worker failed: {}", e));
            98
        }
    }
}

/// Returns the most recent error message for the current thread, or null.
/// The returned pointer remains valid until the next FFI call on this thread.
#[no_mangle]
pub unsafe extern "C" fn maple_last_error() -> *const c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(cstr) => cstr.as_ptr(),
        None => std::ptr::null(),
    })
}
