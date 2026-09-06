//! Host-owned cancellation flag for interruptible renders (#951).
//!
//! The scene-linear f32 render entries take an optional cancel signal so a
//! cold-open decode (dominated by the ~8.5 s `nr_color` pass) can be unwound
//! when the host abandons it — e.g. the editor supersedes an in-flight decode
//! with a newer one. A NULL signal means "never cancel", which keeps every
//! other FFI caller and test byte-for-byte unaffected.
//!
//! The flag is an **opaque, Rust-owned** `AtomicBool` rather than a bool the
//! host pokes directly. Ownership matters: the render worker thread reads the
//! flag concurrently with the host's "request cancel" write, so the store and
//! the loads must be atomic. Keeping the atomic on the Rust side (the host
//! only ever holds the opaque pointer and calls these helpers) makes that
//! correct by construction and avoids requiring an atomics dependency on the
//! Swift side.
//!
//! ABI shape mirrors [`crate::handle::MapleRawHandle`] exactly — the exposed
//! struct is `#[repr(C)]` with a single `*mut c_void` field, identical to a
//! forward-declared opaque pointer, and the real `AtomicBool` lives in a
//! separate boxed `Inner` that the C/Swift side never sees. cbindgen already
//! emits the `MapleRawHandle` shape as an opaque typedef, so this one comes
//! out the same way.
//!
//! Lifecycle (host responsibility):
//!   1. [`maple_cancel_flag_new`] — allocate; returns an opaque pointer.
//!   2. Pass the pointer (as the `cancel` arg) to a scene-linear f32 render.
//!   3. [`maple_cancel_flag_set`] — from any thread, request cancellation of
//!      an in-flight render holding this flag.
//!   4. [`maple_cancel_flag_free`] — release. **Must outlive every render call
//!      that received the pointer.** The render entries run on a worker thread
//!      that is `join`-ed before the FFI call returns, so a pointer is valid
//!      for the duration of a synchronous render call; the host must simply
//!      not free the flag while such a call is in flight (the Swift wrapper
//!      keeps the owning object alive across the call to guarantee this).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The real cancellation state behind the opaque pointer. Not exposed in the
/// C ABI — only reachable through [`MapleCancelFlag::inner`].
struct Inner {
    flag: Arc<AtomicBool>,
}

/// Opaque host-owned cancellation flag. `#[repr(C)]` with a single opaque
/// pointer field (same shape as [`crate::handle::MapleRawHandle`]); cbindgen
/// emits it as an opaque typedef, so the C/Swift side sees only
/// `MapleCancelFlag *` and never the `AtomicBool`.
#[repr(C)]
pub struct MapleCancelFlag {
    /// Opaque pointer to a heap-allocated [`Inner`]. Not introspected by
    /// callers.
    inner: *mut std::ffi::c_void,
}

/// Allocate a fresh cancellation flag (initially not-cancelled) and hand the
/// caller an owning opaque pointer. Free it with [`maple_cancel_flag_free`].
#[no_mangle]
pub extern "C" fn maple_cancel_flag_new() -> *mut MapleCancelFlag {
    let inner = Box::new(Inner {
        flag: Arc::new(AtomicBool::new(false)),
    });
    let inner_ptr = Box::into_raw(inner) as *mut std::ffi::c_void;
    Box::into_raw(Box::new(MapleCancelFlag { inner: inner_ptr }))
}

/// Request cancellation of any in-flight render holding this flag. Idempotent;
/// safe to call from a different thread than the one running the render. A
/// null pointer (or one with a null inner) is a no-op (defensive).
#[no_mangle]
pub unsafe extern "C" fn maple_cancel_flag_set(flag: *mut MapleCancelFlag) {
    if let Some(handle) = flag.as_ref() {
        if let Some(inner) = (handle.inner as *const Inner).as_ref() {
            inner.flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Free a cancellation flag previously returned by [`maple_cancel_flag_new`].
/// A null pointer is a no-op. Must NOT be called while a render that received
/// this pointer is still in flight (see the module-level lifecycle note).
#[no_mangle]
pub unsafe extern "C" fn maple_cancel_flag_free(flag: *mut MapleCancelFlag) {
    if flag.is_null() {
        return;
    }
    let handle = Box::from_raw(flag);
    if !handle.inner.is_null() {
        drop(Box::from_raw(handle.inner as *mut Inner));
    }
}

/// Extract the inner `AtomicBool` pointer from a raw `MapleCancelFlag`
/// pointer, for building a `raw_core::CancelToken`. A null pointer (or null
/// inner) yields `None`, so the caller constructs `CancelToken::never()` and
/// every existing caller (which passes null) is unaffected.
///
/// Returns `NonNull<AtomicBool>` rather than `&'a AtomicBool` to avoid
/// manufacturing an unconstrained lifetime that is not tied to the pointee —
/// the FFI caller reconstructs a borrow with the correct scope.
///
/// SAFETY: `flag` must be either null or a pointer returned by
/// [`maple_cancel_flag_new`] that has not yet been freed. The returned pointer
/// is valid for as long as the flag has not been freed. The caller is
/// responsible for not allowing the pointer to outlive the flag allocation.
pub(crate) unsafe fn token_from_ptr(
    flag: *const MapleCancelFlag,
) -> Option<std::ptr::NonNull<AtomicBool>> {
    let handle = flag.as_ref()?;
    let inner = (handle.inner as *const Inner).as_ref()?;
    Some(std::ptr::NonNull::from(inner.flag.as_ref()))
}

/// Share the same host signal with the GPU pass encoder. A new independent
/// token would lose cancellation requested while waiting for the GPU lock.
///
/// # Safety
/// `flag` is null or a live flag from `maple_cancel_flag_new`.
#[cfg(feature = "gpu")]
pub(crate) unsafe fn gpu_token(flag: *const MapleCancelFlag) -> raw_gpu::CancelToken {
    flag.as_ref()
        .and_then(|handle| (handle.inner as *const Inner).as_ref())
        .map(|inner| raw_gpu::CancelToken::from_flag(Arc::clone(&inner.flag)))
        .unwrap_or_default()
}

/// A `Send` shim so a raw `*const MapleCancelFlag` can cross the
/// `with_large_stack` worker-thread boundary. The render worker is `join`-ed
/// before the FFI call returns and the host keeps the flag alive across the
/// call, so the pointer is valid for the worker's entire lifetime; sending the
/// pointer is sound.
pub(crate) struct SendCancelPtr(pub *const MapleCancelFlag);

// SAFETY: the pointee's payload is an `AtomicBool` (Sync), and the host
// guarantees the allocation outlives the synchronous render call the worker
// runs (the call joins the worker before returning). The worker only ever
// reads the atomic.
unsafe impl Send for SendCancelPtr {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "gpu")]
    #[test]
    fn gpu_encode_token_observes_late_host_cancellation_and_retains_signal() {
        let flag = maple_cancel_flag_new();
        let token = unsafe { gpu_token(flag) };
        assert!(!token.is_cancelled());
        unsafe { maple_cancel_flag_set(flag) };
        assert!(token.is_cancelled());
        unsafe { maple_cancel_flag_free(flag) };
        assert!(token.is_cancelled());
        assert!(!unsafe { gpu_token(std::ptr::null()) }.is_cancelled());
    }

    #[test]
    fn null_pointer_yields_never_token() {
        // token_from_ptr(null) ⇒ None ⇒ caller builds never-cancel.
        let none = unsafe { token_from_ptr(std::ptr::null()) };
        assert!(none.is_none());
        // set/free are no-ops on null (must not crash).
        unsafe {
            maple_cancel_flag_set(std::ptr::null_mut());
            maple_cancel_flag_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn new_set_observed_then_free() {
        let flag = maple_cancel_flag_new();
        assert!(!flag.is_null());
        // Before set: not cancelled.
        unsafe {
            let ptr = token_from_ptr(flag).expect("inner present");
            assert!(!ptr.as_ref().load(Ordering::Relaxed));
        }
        // After set: cancelled (and observable through a fresh deref, as the
        // render worker would observe it).
        unsafe {
            maple_cancel_flag_set(flag);
            let ptr = token_from_ptr(flag).expect("inner present");
            assert!(ptr.as_ref().load(Ordering::Relaxed));
        }
        unsafe { maple_cancel_flag_free(flag) };
    }
}
