//! Cooperative cancellation for the develop chain (#951).
//!
//! A long cold-open decode is dominated by a single `nr_color` pass
//! (~8.5 s on a 100 MP frame). Swift cancellation is cooperative — the
//! generation guard drops a stale render *after* it completes, but the
//! in-flight FFI call runs to the end, so an edit made during that window
//! can't take effect until the whole decode finishes.
//!
//! [`CancelToken`] threads a host-owned cancel signal through the develop
//! chain and into the expensive stage kernels so the work can unwind early.
//! It is a thin, zero-cost wrapper around an optional `&AtomicBool`:
//!
//!   * [`CancelToken::never`] holds `None`. [`CancelToken::is_cancelled`]
//!     is a single branch that returns `false` — it never touches the
//!     atomic and never perturbs the pixel math. Every existing caller and
//!     test passes a never-cancel token (directly or via the non-suffixed
//!     wrapper functions), so a render that runs to completion is
//!     **bit-identical** to before this change.
//!   * [`CancelToken::new`] borrows an `&AtomicBool` the host flips to
//!     request cancellation. The stages load it with `Ordering::Relaxed`
//!     periodically (between NLM shifts, per sharpen / demosaic row) — a
//!     relaxed load is effectively free and introduces no contention.
//!
//! The token only ever *reads* the flag. Ownership of the `AtomicBool`
//! (allocation, the store that requests cancellation, and freeing) stays
//! with the host; on the FFI boundary that is the Swift side via the
//! `maple_cancel_flag_*` helpers in `raw-ffi`.

use std::sync::atomic::{AtomicBool, Ordering};

/// A borrowed, cooperative cancellation signal threaded through the develop
/// chain. `Copy` so it can be cheaply forwarded to every stage; holds only
/// a shared reference, so it never owns or frees the underlying flag.
///
/// The lifetime ties the token to the borrowed flag — the develop chain is
/// synchronous, so the flag (host-owned) trivially outlives every token in
/// scope.
#[derive(Clone, Copy)]
pub struct CancelToken<'a> {
    flag: Option<&'a AtomicBool>,
}

impl<'a> CancelToken<'a> {
    /// A token that never cancels. Zero-cost: [`is_cancelled`] short-circuits
    /// to `false` without any atomic access. This is the default every
    /// non-cancellable caller (CLI, WASM, tests, the legacy FFI entries)
    /// uses, guaranteeing their output is unchanged.
    ///
    /// [`is_cancelled`]: CancelToken::is_cancelled
    #[inline]
    pub const fn never() -> Self {
        CancelToken { flag: None }
    }

    /// Borrow a host-owned `AtomicBool` as a cancellation signal. The host
    /// sets it to `true` (any ordering ≥ Relaxed) to request cancellation;
    /// the develop chain observes it with a relaxed load and unwinds.
    #[inline]
    pub fn new(flag: &'a AtomicBool) -> Self {
        CancelToken { flag: Some(flag) }
    }

    /// `true` once the host has requested cancellation. A never-cancel
    /// token (the default) always returns `false` with no atomic access, so
    /// the hot path of an uncancellable render pays only an `Option` branch.
    ///
    /// Uses `Ordering::Relaxed`: we only need eventual visibility of the
    /// host's store, not synchronisation with surrounding memory — a missed
    /// observation on one loop iteration just defers the bail to the next
    /// check, which is harmless.
    #[inline]
    pub fn is_cancelled(&self) -> bool {
        match self.flag {
            Some(f) => f.load(Ordering::Relaxed),
            None => false,
        }
    }
}

impl Default for CancelToken<'_> {
    #[inline]
    fn default() -> Self {
        Self::never()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_token_is_never_cancelled() {
        let t = CancelToken::never();
        assert!(!t.is_cancelled());
        // Default is the never token.
        assert!(!CancelToken::default().is_cancelled());
    }

    #[test]
    fn borrowed_flag_reflects_host_store() {
        let flag = AtomicBool::new(false);
        let t = CancelToken::new(&flag);
        assert!(!t.is_cancelled());
        flag.store(true, Ordering::Relaxed);
        assert!(t.is_cancelled());
        // Copies observe the same underlying flag.
        let t2 = t;
        assert!(t2.is_cancelled());
    }
}
