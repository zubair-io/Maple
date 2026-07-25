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
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

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

/// The registered callback, stored as a raw address. `AtomicUsize` rather
/// than `AtomicPtr` because a function pointer is not a data pointer;
/// 0 means "no callback".
static CALLBACK: AtomicUsize = AtomicUsize::new(0);
/// The opaque user pointer handed back to the callback.
static CALLBACK_USER: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

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
    let address = callback.map_or(0usize, |f| f as usize);
    CALLBACK_USER.store(user, Ordering::Release);
    CALLBACK.store(address, Ordering::Release);
    bm3d::set_progress_sink((address != 0).then_some(forward as bm3d::ProgressSink));
}

/// raw-core sink → the registered C callback.
fn forward(pass: &'static str, fraction: f32) {
    let address = CALLBACK.load(Ordering::Acquire);
    if address == 0 {
        return;
    }
    let overall = bm3d::overall_fraction(pass, fraction);
    let pass_index = if pass == bm3d::PASS_2 { 2 } else { 1 };
    let user = CALLBACK_USER.load(Ordering::Acquire);
    // SAFETY: `address` was stored from a live `MapleDeepDenoiseProgressFn`
    // by `maple_set_deep_denoise_progress`, whose contract requires the
    // pointer (and `user`) to stay valid until the callback is cleared.
    let callback: unsafe extern "C" fn(f32, u32, *mut c_void) = unsafe {
        std::mem::transmute::<usize, unsafe extern "C" fn(f32, u32, *mut c_void)>(address)
    };
    unsafe { callback(overall, pass_index, user) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    static SEEN_TICKS: AtomicU32 = AtomicU32::new(0);
    static LAST_FRACTION_BITS: AtomicU32 = AtomicU32::new(0);
    static LAST_PASS: AtomicU32 = AtomicU32::new(0);

    unsafe extern "C" fn record(fraction: f32, pass: u32, _user: *mut c_void) {
        SEEN_TICKS.fetch_add(1, Ordering::Relaxed);
        LAST_FRACTION_BITS.store(fraction.to_bits(), Ordering::Relaxed);
        LAST_PASS.store(pass, Ordering::Relaxed);
    }

    /// Registration installs the raw-core sink, ticks arrive with an
    /// overall fraction and a 1-based pass index, and clearing stops them.
    /// One test because the registry is process-global.
    #[test]
    fn registered_callback_receives_overall_fraction_then_stops() {
        unsafe { maple_set_deep_denoise_progress(Some(record), std::ptr::null_mut()) };

        forward(bm3d::PASS_1, 0.5);
        assert_eq!(SEEN_TICKS.load(Ordering::Relaxed), 1);
        assert_eq!(LAST_PASS.load(Ordering::Relaxed), 1);
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
