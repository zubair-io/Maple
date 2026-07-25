//! Apple bridge for the BM3D deep-denoise progress signal (#1153).
//!
//! `deep_denoise` is the one develop stage whose runtime is seconds rather
//! than milliseconds, so the editor shows a DETERMINATE progress bar while
//! it runs (tone/zoom design spec § 3.2). The numbers are the stage's own
//! per-reference-row ticks — raw-core's
//! [`raw_core::stages::bm3d::Progress`] sink — never a simulated animation.
//!
//! ## Shape
//!
//! One process-global callback, registered once by the host, matching the
//! established `MaplePanoProgressFn` pattern (a C function pointer plus an
//! opaque user pointer). It is deliberately NOT a parameter on the render
//! entries: the stage sits deep inside `develop`, four call layers below
//! `maple_render_*`, and threading a sink through every one of those
//! signatures to serve a single stage is exactly the speculative plumbing
//! CLAUDE.md § 7 rules out. The Swift side registers a trampoline that
//! stores the value in a lock-guarded atom and lets a MainActor timer poll
//! it — identical to `RustPanoStitcher`.
//!
//! The callback runs on whichever thread drives the develop (a render
//! actor's background thread), so the host must not block in it and must
//! not hop to the main actor synchronously.

use std::ffi::c_void;
use std::sync::RwLock;

use raw_core::stages::bm3d;

/// Progress callback type for [`maple_set_deep_denoise_progress`].
///
/// `fraction` — OVERALL completion `[0, 1]` across BM3D's two passes, so
///              the host can bind it straight to a determinate indicator.
/// `pass`     — 1 or 2, the pass currently running (for a "Pass 1 of 2"
///              label).
/// `user`     — the opaque pointer the host registered.
pub type MapleDeepDenoiseProgressFn =
    Option<unsafe extern "C" fn(fraction: f32, pass: u32, user: *mut c_void)>;

/// A registered callback together with the user pointer it was registered
/// with. The two travel as ONE value: held in separate atomics, a `forward`
/// racing a re-registration could read the new function pointer with the old
/// user pointer (or the reverse) and hand a callback someone else's context.
#[derive(Clone, Copy)]
struct Registration {
    callback: unsafe extern "C" fn(f32, u32, *mut c_void),
    /// The opaque host pointer, carried as a `usize` so `Registration` stays
    /// `Send + Sync` — `*mut c_void` is neither, and this static is shared
    /// across the render threads that drive `forward`.
    user: usize,
}

/// The registration, or `None` when the host has not registered (or has
/// cleared). `RwLock` rather than a pair of atomics for the reason above,
/// mirroring `bm3d::PROGRESS_SINK`, whose read path this one shadows.
static REGISTRATION: RwLock<Option<Registration>> = RwLock::new(None);

/// Register (or clear) the deep-denoise progress callback.
///
/// Pass a null `callback` to clear it. `user` is stored verbatim and handed
/// back on every tick; the host owns its lifetime and must keep it alive
/// until it clears the callback. Idempotent — the host registers once at
/// startup.
///
/// # Safety
///
/// `callback` must be a valid C function pointer (or null) and `user` must
/// remain valid for as long as the callback is registered.
#[no_mangle]
pub unsafe extern "C" fn maple_set_deep_denoise_progress(
    callback: MapleDeepDenoiseProgressFn,
    user: *mut c_void,
) {
    let registration = callback.map(|f| Registration {
        callback: f,
        user: user as usize,
    });
    // Scoped so the write guard is released before `set_progress_sink` — that
    // call takes bm3d's own lock, and holding two registry locks at once is
    // how a lock-order inversion gets introduced later.
    {
        let mut guard = REGISTRATION
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = registration;
    }
    bm3d::set_progress_sink(
        registration
            .is_some()
            .then_some(forward as bm3d::ProgressSink),
    );
}

/// raw-core sink → the registered C callback.
fn forward(pass: &'static str, fraction: f32) {
    // Copy the pair out under ONE guard, then drop it before calling: the
    // callback must never run with the lock held, or a host that re-registers
    // from inside it self-deadlocks. Same read shape as `bm3d::PROGRESS_SINK`.
    let registration = *REGISTRATION
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(Registration { callback, user }) = registration else {
        return;
    };
    let overall = bm3d::overall_fraction(pass, fraction);
    let pass_index = if pass == bm3d::PASS_2 { 2 } else { 1 };
    // SAFETY: `callback` and `user` were registered together by
    // `maple_set_deep_denoise_progress`, whose contract requires both to stay
    // valid until the callback is cleared. Reading them as one value is what
    // guarantees they are still the pair the host registered.
    unsafe { callback(overall, pass_index, user as *mut c_void) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

    static SEEN_TICKS: AtomicU32 = AtomicU32::new(0);
    static LAST_FRACTION_BITS: AtomicU32 = AtomicU32::new(0);
    static LAST_PASS: AtomicU32 = AtomicU32::new(0);
    static LAST_USER: AtomicUsize = AtomicUsize::new(0);

    /// The host context this test registers — its address is what every tick
    /// must carry back, proving the callback and its user pointer are
    /// delivered as the pair they were registered as.
    static HOST_CONTEXT: u32 = 0xC0FFEE;

    unsafe extern "C" fn record(fraction: f32, pass: u32, user: *mut c_void) {
        SEEN_TICKS.fetch_add(1, Ordering::Relaxed);
        LAST_FRACTION_BITS.store(fraction.to_bits(), Ordering::Relaxed);
        LAST_PASS.store(pass, Ordering::Relaxed);
        LAST_USER.store(user as usize, Ordering::Relaxed);
    }

    /// Registration installs the raw-core sink, ticks arrive with an
    /// overall fraction, a 1-based pass index and the registered user
    /// pointer, and clearing stops them. One test because the registry is
    /// process-global.
    #[test]
    fn registered_callback_receives_overall_fraction_then_stops() {
        let context = &HOST_CONTEXT as *const u32 as *mut c_void;
        unsafe { maple_set_deep_denoise_progress(Some(record), context) };

        forward(bm3d::PASS_1, 0.5);
        assert_eq!(SEEN_TICKS.load(Ordering::Relaxed), 1);
        assert_eq!(LAST_PASS.load(Ordering::Relaxed), 1);
        assert_eq!(
            LAST_USER.load(Ordering::Relaxed),
            context as usize,
            "the tick must carry the user pointer registered alongside the callback"
        );
        assert!(
            (f32::from_bits(LAST_FRACTION_BITS.load(Ordering::Relaxed)) - 0.25).abs() < 1e-6,
            "pass 1 at 50% is 25% overall"
        );

        forward(bm3d::PASS_2, 1.0);
        assert_eq!(SEEN_TICKS.load(Ordering::Relaxed), 2);
        assert_eq!(LAST_PASS.load(Ordering::Relaxed), 2);
        assert!(
            (f32::from_bits(LAST_FRACTION_BITS.load(Ordering::Relaxed)) - 1.0).abs() < 1e-6,
            "pass 2 complete is 100% overall"
        );

        unsafe { maple_set_deep_denoise_progress(None, std::ptr::null_mut()) };
        forward(bm3d::PASS_1, 0.9);
        assert_eq!(
            SEEN_TICKS.load(Ordering::Relaxed),
            2,
            "a cleared callback must receive no further ticks"
        );
    }
}
