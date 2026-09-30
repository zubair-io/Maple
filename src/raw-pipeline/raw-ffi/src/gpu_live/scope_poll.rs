//! Non-blocking host scope collection for Windows #3885. Presentation requests
//! the shared scope pass; a host timer polls it without another render.
use super::{LiveHandleInner, MapleGpuLiveSession, GPU_SHARED};
use crate::{
    error::{catch_panic_rc, set_last_error},
    scope_stats::{write_snapshot, write_stats},
    MapleScopeStats,
};

/// Poll an enabled live session's newest completed scope sample.
/// Returns 1 when copied, 0 when pending or the shared GPU lock is busy,
/// -1 for null/closed handles, -2 for undersized output buffers, 99 on panic.
/// A 0 return leaves all caller output fields and buffers unchanged.
/// Does not submit a render or wait for a GPU submission. Hosts disable the
/// scope pass while closed, serialize handle lifetime, and reject stale frame
/// numbers across adjustment/image generations (#3885).
///
/// # Safety
/// `handle` must be live and exclusively owned during this call. `out` and
/// its buffers must be writable at their declared capacities for the call.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_poll_scope(
    handle: *const MapleGpuLiveSession,
    out: *mut MapleScopeStats,
) -> i32 {
    if handle.is_null() || out.is_null() || (*handle).inner.is_null() {
        set_last_error("scope poll: null or closed session".into());
        return -1;
    }
    let max = crate::scope_stats::MAPLE_SCOPE_SNAPSHOT_MAX_DIM;
    if (*out).bins_ptr.is_null()
        || (*out).bins_len < 128 * 128
        || (*out).snapshot_ptr.is_null()
        || (*out).snapshot_len < max * max * 3
    {
        set_last_error("scope poll: output buffers must hold 128x128 bins and 512x512 RGB".into());
        return -2;
    }
    catch_panic_rc("scope poll", || {
        let shared = match GPU_SHARED.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => return 0,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        };
        let Some(shared) = shared.as_ref() else {
            return 0;
        };
        let inner = &*((*handle).inner as *const LiveHandleInner);
        match inner.session.poll_scope_stats(&shared.ctx) {
            None => 0,
            Some(stats) => {
                write_stats(out, stats.frame, stats.total, &stats.bins);
                write_snapshot(
                    out,
                    stats.snapshot.width,
                    stats.snapshot.height,
                    &stats.snapshot.rgb,
                );
                1
            }
        }
    })
}
