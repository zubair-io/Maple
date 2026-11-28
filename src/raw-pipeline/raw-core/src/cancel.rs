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
    #[cfg(test)]
    probe: Option<&'a probe::PollProbe>,
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
        CancelToken {
            flag: None,
            #[cfg(test)]
            probe: None,
        }
    }

    /// Borrow a host-owned `AtomicBool` as a cancellation signal. The host
    /// sets it to `true` (any ordering ≥ Relaxed) to request cancellation;
    /// the develop chain observes it with a relaxed load and unwinds.
    #[inline]
    pub fn new(flag: &'a AtomicBool) -> Self {
        CancelToken {
            flag: Some(flag),
            #[cfg(test)]
            probe: None,
        }
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
    #[cfg_attr(test, track_caller)]
    pub fn is_cancelled(&self) -> bool {
        #[cfg(test)]
        if let Some(probe) = self.probe {
            return probe.poll(std::panic::Location::caller());
        }
        match self.flag {
            Some(f) => f.load(Ordering::Relaxed),
            None => false,
        }
    }

    /// `Err(Cancelled)` once the host has requested cancellation: the
    /// checkpoint between stages whose kernels skip work under a cancel.
    #[inline]
    #[cfg_attr(test, track_caller)]
    pub fn check(&self) -> crate::Result<()> {
        if self.is_cancelled() {
            return Err(crate::Error::Cancelled);
        }
        Ok(())
    }
}

impl Default for CancelToken<'_> {
    #[inline]
    fn default() -> Self {
        Self::never()
    }
}

#[cfg(test)]
pub(crate) mod probe {
    use std::collections::{BTreeMap, BTreeSet};
    use std::panic::Location;
    use std::sync::Mutex;

    use super::CancelToken;

    type Site = (&'static str, u32, u32);

    /// A deterministic stand-in for a host that cancels: every poll of its
    /// token counts as one unit of work, and the poll with index `trip_at`
    /// and every later one reports a cancel. The decision depends on the
    /// poll's index alone, never on timing, so a run is reproducible under
    /// any machine load; run it on a one-thread pool for a fixed poll order.
    pub(crate) struct PollProbe {
        trip_at: usize,
        sites: Mutex<Vec<Site>>,
    }

    impl PollProbe {
        pub(crate) fn trip_at(trip_at: usize) -> Self {
            Self {
                trip_at,
                sites: Mutex::new(Vec::new()),
            }
        }

        pub(crate) fn never_trips() -> Self {
            Self::trip_at(usize::MAX)
        }

        pub(crate) fn token(&self) -> CancelToken<'_> {
            CancelToken {
                flag: None,
                probe: Some(self),
            }
        }

        pub(super) fn poll(&self, site: &'static Location<'static>) -> bool {
            let mut sites = self.sites.lock().unwrap();
            let index = sites.len();
            sites.push((site.file(), site.line(), site.column()));
            index >= self.trip_at
        }

        pub(crate) fn polls(&self) -> usize {
            self.sites.lock().unwrap().len()
        }

        /// The index of the first poll from each call site that polls at or
        /// after index `from`: one cancel point per distinct checkpoint.
        pub(crate) fn first_polls_of_distinct_sites(&self, from: usize) -> Vec<usize> {
            let sites = self.sites.lock().unwrap();
            (from..sites.len())
                .filter(|&index| !sites[from..index].contains(&sites[index]))
                .collect()
        }

        /// How often each call site other than the one that saw the cancel
        /// first was polled once the cancel was in. A checkpoint that
        /// unwinds the run polls once; a pass that started after the cancel
        /// polls once per row.
        pub(crate) fn later_polls_by_other_site(&self) -> BTreeMap<String, usize> {
            let sites = self.sites.lock().unwrap();
            let Some(first) = sites.get(self.trip_at) else {
                return BTreeMap::new();
            };
            let others: Vec<_> = sites[self.trip_at..]
                .iter()
                .filter(|site| *site != first)
                .collect();
            others
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(|site| {
                    let polls = others.iter().filter(|other| **other == site).count();
                    (format!("{}:{}:{}", site.0, site.1, site.2), polls)
                })
                .collect()
        }
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
