//! The Apple `CAMetalLayer` present entry for the gpu-gated live FFI, split out
//! of `gpu_live.rs` (600-LOC file budget; same sibling-module pattern as
//! `params.rs`). The whole module is
//! `#[cfg(target_vendor = "apple")]` at its declaration site, mirroring the
//! per-item cfg the entry carried in the parent file.

use super::{lock_shared, params, LiveHandleInner, MapleGpuLiveParams, MapleGpuLiveSession};
use crate::error::{catch_panic_rc, set_last_error};
use raw_gpu::CancelToken;
use std::os::raw::c_void;

/// Return code for a superseded present (mirrors
/// [`crate::scene_linear_f32`]'s `RC_CANCELLED = 4`). Cancellation before submit
/// skips the chain; a race after submit finishes the reserved drawable but does
/// not acknowledge it as the current edit. Distinct from error codes so
/// the Swift caller maps it onto the silent "dropped" path, not a render error.
/// Only returned when a non-null cancel flag was passed AND the host set it.
const RC_PRESENT_CANCELLED: i32 = 4;

/// Render one edit on a live session AND present it to a `CAMetalLayer` — the
/// P4b-apple (#1028) live path. Builds the gated chain from `params`, runs it on
/// the session's pooled buffers to its final f32 buffer, then a fullscreen-
/// triangle pass dithers/quantizes that buffer into `layer`'s drawable (NO CPU
/// readback). The colour-correct sibling of [`maple_gpu_present_test_pattern`]
/// (P1b's passthrough pattern).
///
/// `layer` is the `CAMetalLayer*` to present into. Its `drawableSize` is OWNED
/// by the Rust side (#1769): wgpu's `surface.configure` sets it to the session
/// dims on every (re)configure, and the host MUST NOT write it — every
/// value-changing host write invalidates the layer's drawable pool without wgpu
/// knowing, landing the next single present on a freshly-invalidated pool (the
/// iPad splice). The caller resizes the IMAGE to the viewport before
/// [`maple_gpu_live_open`] — the present never rescales. The layer's
/// `colorspace` tag is the host's responsibility (sRGB — the chain outputs
/// sRGB-primary gamma-encoded; see the P4b-apple plan).
///
/// `surface_generation` keys the process-wide present-surface cache together
/// with the layer pointer and dims (#1769). The host bumps it when it registers
/// a DIFFERENT `CAMetalLayer` instance (a recreated canvas view — covers malloc
/// address reuse where the raw pointer alone would falsely match) and when it
/// detects the layer's `drawableSize` diverged from the dims of the last
/// successful present at an unchanged key (an external re-derivation wgpu
/// cannot see). A bumped generation forces a deterministic old-surface teardown,
/// a fresh configure, and the settle double-present.
///
/// `cancel` is an optional host-owned [`crate::cancel::MapleCancelFlag`]. When
/// non-null, cancellation is checked before and after the shared GPU lock,
/// after drawable reservation and between encoded passes. A blocked request
/// reserves a drawable before submitting any compute work. Once compute submits,
/// the reserved drawable is presented even if a newer edit supersedes it; the
/// return code still rejects that request as a current-frame acknowledgement.
/// Null retains the never-cancel behavior.
///
/// Dehaze computes its atmospheric-light reduction on GPU in the same chain;
/// it does not read back the RAW or the pre-dehaze buffer per slider tick.
///
/// Returns 0 on a successful present. Non-zero on error (call `maple_last_error`
/// for the message):
///   -1 handle/params/layer null or a closed handle ·
///    4 superseded (see [`RC_PRESENT_CANCELLED`]) ·
///   -3 the shared GPU context was missing ·
///   -4 the GPU chain or present (surface size/configure/draw) failed ·
///   99 a Rust-side panic was contained.
///
/// A nonzero return (other than 4) is always safe to treat as "use the CPU
/// render path".
///
/// # Safety
/// `handle` a live handle from [`maple_gpu_live_open`]; `params` valid (incl. its
/// array pointers); `layer` a valid non-null `CAMetalLayer*` outliving the call;
/// `cancel` null or a valid [`crate::cancel::MapleCancelFlag`] outliving the call.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_chain(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    layer: *mut c_void,
    cancel: *const crate::cancel::MapleCancelFlag,
    surface_generation: u64,
) -> i32 {
    if handle.is_null() || params.is_null() || layer.is_null() {
        set_last_error("gpu_present_chain: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *mut LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_present_chain: closed/invalid handle".into());
        return -1;
    }
    let inner = &mut *inner_ptr;
    let p = &*params;

    let token = crate::cancel::gpu_token(cancel);
    if token.is_cancelled() {
        return RC_PRESENT_CANCELLED;
    }

    // Panic barrier (#1079): THIS entry is the documented abort path — a canvas
    // past the device's texture limit used to panic inside surface configure and
    // unwind through this frame. The configure is now validated Err-first in
    // raw-gpu; the barrier contains anything that still slips (rc 99).
    catch_panic_rc("gpu_present_chain", || {
        // Defer parameter marshalling until the queued request has acquired
        // the lock and is still current. Immutable LUT slices remain borrowed.
        let mut shared = match lock_for_present(&token) {
            Ok(shared) => shared,
            Err(rc) => return rc,
        };
        let inputs = match params::inputs_from_params(p, inner.width, inner.height) {
            Ok(inputs) => inputs,
            Err(message) => {
                set_last_error(message);
                return -1;
            }
        };
        let state = match shared.as_mut() {
            Some(s) => s,
            None => {
                set_last_error("gpu_present_chain: shared GPU context missing".into());
                return -3;
            }
        };
        // SAFETY: `layer` is non-null and a valid CAMetalLayer* per this fn's
        // contract, retained by the wgpu surface for the cache's lifetime. The
        // surface cache is PROCESS-WIDE (#1769) and keyed on
        // `(surface_generation, layer, dims)` — the Swift host bumps the
        // generation whenever it registers a different layer instance (covers
        // pointer reuse / ABA) or detects a drawableSize divergence, so a stale
        // cached surface can never be presented against a recycled address.
        let present_result = raw_gpu::present_chain_to_surface(
            &state.ctx,
            &inner.session,
            &inputs,
            layer,
            &mut state.present_surface,
            surface_generation,
            &token,
        );

        // Vectorscope scope stats (#3272) — the PREVIOUS tick's sample, if its
        // async map has completed by now; see `LiveSession::take_scope_stats`.
        // Written regardless of the present's own outcome: the chain (and the
        // scope pass, which reads its buffer) already ran by this point, so a
        // present-surface failure shouldn't also swallow an otherwise-valid
        // sample.
        if p.scope_enabled != 0 {
            if let Some(stats) = inner.session.take_scope_stats(&state.ctx) {
                crate::scope_stats::write_stats(p.scope_out, stats.frame, stats.total, &stats.bins);
            }
        }

        match present_result {
            Ok(true) => 0,
            Ok(false) => RC_PRESENT_CANCELLED,
            Err(msg) => {
                set_last_error(format!("gpu_present_chain present: {msg}"));
                -4
            }
        }
    })
}

/// Cancellation must be sampled after waiting as well as at FFI entry.
fn lock_for_present(
    token: &CancelToken,
) -> Result<std::sync::MutexGuard<'static, Option<super::GpuShared>>, i32> {
    let shared = lock_shared();
    if token.is_cancelled() {
        Err(RC_PRESENT_CANCELLED)
    } else {
        Ok(shared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn superseded_present_waiting_for_shared_gpu_lock_drops_before_marshalling() {
        let lock = lock_shared();
        let token = CancelToken::new();
        let worker_token = token.clone();
        let (entered, waiting) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            lock_for_present(&worker_token).err()
        });
        waiting.recv().unwrap();
        token.cancel();
        drop(lock);
        assert_eq!(worker.join().unwrap(), Some(RC_PRESENT_CANCELLED));
        assert!(lock_for_present(&CancelToken::new()).is_ok());
    }
}
