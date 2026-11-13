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
            Err(payload) => {
                set_last_error(format!(
                    "render worker panicked: {}",
                    panic_message(payload.as_ref())
                ));
                RC_PANICKED
            }
        },
        Err(e) => {
            set_last_error(format!("spawn worker failed: {}", e));
            98
        }
    }
}

/// Return code for "the FFI body panicked" — mirrors [`with_large_stack`]'s
/// worker-panic rc (99) so hosts see one consistent "Rust-side panic" code.
/// Used by [`catch_panic_rc`] (#1079).
pub(crate) const RC_PANICKED: i32 = 99;

/// Run an FFI body with a panic barrier (#1079): a panic anywhere inside
/// (wgpu's `handle_error_fatal`, a slipped `assert`, …) is caught at this
/// boundary instead of unwinding through the `extern "C"` frame — which is
/// undefined behaviour and in practice aborts the app on Apple. On panic the
/// payload's message lands in `LAST_ERROR` and the caller gets
/// [`RC_PANICKED`], mirroring the CPU entries' `with_large_stack` rc-99
/// pattern (there the thread JOIN is the panic barrier; gpu entries run on the
/// caller's thread — the GPU handle is `!Send` — so they need an explicit
/// `catch_unwind`).
///
/// `AssertUnwindSafe` is sound here: on the error path the closure's captures
/// are never touched again (the host treats nonzero as "fall back to CPU" and
/// closes the handle), so observing broken invariants is not possible.
///
/// Not gated on the `gpu` feature: the v2 raster entries (`raster_v2.rs`) run
/// on the caller's thread too, and their decoders (rav1d, avif-parse, zune)
/// can panic on an invariant violation in a hostile input — an unwind out of
/// an `extern "C"` frame aborts the host process.
pub(crate) fn catch_panic_rc<F: FnOnce() -> i32>(entry: &str, body: F) -> i32 {
    catch_panic(entry, RC_PANICKED, body)
}

/// [`catch_panic_rc`] for an entry whose C return type is not an `i32` rc —
/// a pointer, a struct, or nothing. `on_panic` is what the host receives
/// instead (null, an error struct, `()`); the message still lands in
/// `LAST_ERROR`.
pub(crate) fn catch_panic<T, F: FnOnce() -> T>(entry: &str, on_panic: T, body: F) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).unwrap_or_else(|payload| {
        set_last_error(format!(
            "{entry}: panicked: {}",
            panic_message(payload.as_ref())
        ));
        on_panic
    })
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".to_string())
}

/// Returns the most recent error message for the current thread, or null.
/// The returned pointer remains valid until the next FFI call on this thread.
#[no_mangle]
pub unsafe extern "C" fn maple_last_error() -> *const c_char {
    crate::error::catch_panic("maple_last_error", std::ptr::null(), || {
        LAST_ERROR.with(|e| match &*e.borrow() {
            Some(cstr) => cstr.as_ptr(),
            None => std::ptr::null(),
        })
    })
}
