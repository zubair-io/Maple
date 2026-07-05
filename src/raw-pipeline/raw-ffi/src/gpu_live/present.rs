//! The Apple `CAMetalLayer` present entry for the gpu-gated live FFI, split out
//! of `gpu_live.rs` (600-LOC file budget; same sibling-module pattern as
//! `params.rs`). Pure relocation; no behavior change. The whole module is
//! `#[cfg(target_vendor = "apple")]` at its declaration site, mirroring the
//! per-item cfg the entry carried in the parent file.

use super::{lock_shared, params, LiveHandleInner, MapleGpuLiveParams, MapleGpuLiveSession};
use crate::error::{catch_panic_rc, set_last_error};
use raw_gpu::CancelToken;
use std::os::raw::c_void;

/// Return code for a present the host cancelled before rendering (mirrors
/// [`crate::scene_linear_f32`]'s `RC_CANCELLED = 4`): the host flipped the cancel
/// flag (a newer edit superseded this present) before the chain was encoded, so
/// nothing was drawn. Distinct from the arg-error (-1) / GPU-failure (-3) codes so
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
/// non-null and the host has already set it (a newer edit superseded this present
/// before it ran), the present bails BEFORE rendering and returns
/// [`RC_PRESENT_CANCELLED`] — the host drops it silently. Pass null for the
/// never-cancel behaviour. (Per-pass mid-render cancellation buys nothing here:
/// the chain encodes into one command buffer and submits once — wgpu can't abort
/// submitted work — so the meaningful bail point is this single entry check, the
/// "queued-but-already-stale render" case under a fast slider drag.)
///
/// The dehaze atmospheric light is measured INTERNALLY from the post-prefix buffer
/// (a mid-chain readback when dehaze is engaged), as in [`maple_gpu_live_render`];
/// the on-GPU reduction that removes that per-tick readback is #1033, so a
/// dehaze-active present pays it (correct, but not yet 16ms-ready for those scenes).
///
/// Returns 0 on a successful present. Non-zero on error (call `maple_last_error`
/// for the message):
///   -1 handle/params/layer null or a closed handle ·
///    4 cancelled before rendering (see [`RC_PRESENT_CANCELLED`]) ·
///   -3 the GPU chain returned no buffer or failed (only when NOT cancelled) ·
///   -4 the present (surface size/configure/draw) failed ·
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

    // Entry cancel-check (the meaningful bail point — see the fn doc). If the host
    // already set the flag, drop this superseded present without touching the GPU.
    if let Some(flag) = crate::cancel::token_from_ptr(cancel) {
        if flag.as_ref().load(std::sync::atomic::Ordering::Relaxed) {
            return RC_PRESENT_CANCELLED;
        }
    }

    // Panic barrier (#1079): THIS entry is the documented abort path — a canvas
    // past the device's texture limit used to panic inside surface configure and
    // unwind through this frame. The configure is now validated Err-first in
    // raw-gpu; the barrier contains anything that still slips (rc 99).
    catch_panic_rc("gpu_present_chain", || {
        let inputs = params::inputs_from_params(p);
        let token = CancelToken::new();
        let mut shared = lock_shared();
        let state = match shared.as_mut() {
            Some(s) => s,
            None => {
                set_last_error("gpu_present_chain: shared GPU context missing".into());
                return -3;
            }
        };
        let final_idx = match inner
            .session
            .render_chain_to_f32(&state.ctx, &inputs, &token)
        {
            Ok(Some(idx)) => idx,
            Ok(None) => {
                set_last_error("gpu_present_chain: chain render returned None".into());
                return -3;
            }
            Err(e) => {
                set_last_error(format!("gpu_present_chain: {e}"));
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
        match raw_gpu::present_chain_to_surface(
            &state.ctx,
            &inner.session,
            final_idx,
            layer,
            &mut state.present_surface,
            surface_generation,
        ) {
            Ok(()) => 0,
            Err(msg) => {
                set_last_error(format!("gpu_present_chain present: {msg}"));
                -4
            }
        }
    })
}
