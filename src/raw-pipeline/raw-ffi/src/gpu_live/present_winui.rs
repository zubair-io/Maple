//! The Windows WinUI 3 `SwapChainPanel` present entry for the gpu-gated live
//! FFI (#2561) — the DX12 twin of the Apple `present.rs` sibling, with the same
//! entry shape, cancellation contract, and return codes. The whole module is
//! `#[cfg(target_os = "windows")]` at its declaration site.
//!
//! This entry supersedes the retired `maple_gpu_create_winui_dxgi_swapchain`
//! stub: the host no longer receives a raw `IDXGISwapChain1*` to attach itself —
//! wgpu's DX12 HAL creates the composition swapchain AND calls
//! `ISwapChainPanelNative::SetSwapChain` internally when the surface is
//! configured, so the panel binding is owned entirely on this side of the ABI.

use super::{lock_shared, params, LiveHandleInner, MapleGpuLiveParams, MapleGpuLiveSession};
use crate::error::{catch_panic_rc, set_last_error};
use raw_gpu::CancelToken;
use std::os::raw::c_void;

/// Return code for a present the host cancelled before rendering — identical to
/// the Apple entry's contract: the host flipped the cancel flag (a newer edit
/// superseded this present) before the chain was encoded, so nothing was drawn.
const RC_PRESENT_CANCELLED: i32 = 4;

/// Render one edit on a live session AND present it into the DXGI composition
/// swapchain bound to a WinUI 3 `SwapChainPanel` — the Windows live path
/// (#2561). Builds the gated chain from `params`, runs it on the session's
/// pooled buffers to its final f32 buffer, then a fullscreen-triangle pass
/// dithers/quantizes that buffer into the swapchain backbuffer (NO CPU
/// readback).
///
/// `panel_native` is the **`ISwapChainPanelNative*`** (WinUI 3 DXInterop IID
/// `63AAD0B8-7C24-40FF-85A8-640D944CC325`) obtained by QI on the
/// `SwapChainPanel`. The host must keep the panel alive for as long as the same
/// pointer keeps being passed. The surface dims are the SESSION dims — the
/// present never rescales, so the host sizes the decoded image to the panel's
/// physical pixels (`ActualSize × CompositionScale`) before
/// [`super::maple_gpu_live_open`]. The swapchain's `Scaling: STRETCH` absorbs
/// sub-pixel layout drift between resize events.
///
/// `surface_generation` keys the process-wide present-surface cache together
/// with the panel pointer and dims. The host bumps it when it registers a
/// DIFFERENT `SwapChainPanel` instance (covers COM address reuse) and when the
/// panel's composition scale changes (an external re-derivation wgpu cannot
/// see). A bumped generation forces a deterministic old-surface teardown, a
/// fresh configure + `SetSwapChain`, and the settle double-present.
///
/// `cancel` is an optional host-owned [`crate::cancel::MapleCancelFlag`]. When
/// non-null and already set, the present bails BEFORE rendering and returns
/// [`RC_PRESENT_CANCELLED`]; pass null for the never-cancel behaviour.
///
/// Returns 0 on a successful present. Non-zero on error (call
/// `maple_last_error` for the message):
///   -1 handle/params/panel null or a closed handle ·
///    4 cancelled before rendering ·
///   -3 the GPU chain returned no buffer or failed (only when NOT cancelled) ·
///   -4 the present (surface create/configure/draw) failed ·
///   99 a Rust-side panic was contained.
///
/// A nonzero return (other than 4) is always safe to treat as "use the CPU
/// render path".
///
/// # Safety
/// `handle` a live handle from [`super::maple_gpu_live_open`]; `params` valid
/// (incl. its array pointers); `panel_native` a valid non-null
/// `ISwapChainPanelNative*` outliving the call and the cached surface; `cancel`
/// null or a valid [`crate::cancel::MapleCancelFlag`] outliving the call.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_chain_winui(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    panel_native: *mut c_void,
    cancel: *const crate::cancel::MapleCancelFlag,
    surface_generation: u64,
) -> i32 {
    maple_gpu_present_chain_winui_scaled(
        handle,
        params,
        panel_native,
        cancel,
        surface_generation,
        0,
        0,
    )
}

/// [`maple_gpu_present_chain_winui`] with an explicit SURFACE size (#2587's
/// two-phase render): the swapchain stays configured at `(target_w, target_h)`
/// while sessions of any smaller size present into it through the shader's
/// bilinear upscale — so the half-res fast pass and the full-res refine share
/// one configured swapchain and a phase swap never pays a reconfigure +
/// settle double-present. `target_w/target_h = 0` = the session dims (the
/// plain entry's behavior). Same return codes and safety contract.
///
/// # Safety
/// As for [`maple_gpu_present_chain_winui`].
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_present_chain_winui_scaled(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    panel_native: *mut c_void,
    cancel: *const crate::cancel::MapleCancelFlag,
    surface_generation: u64,
    target_w: u32,
    target_h: u32,
) -> i32 {
    if handle.is_null() || params.is_null() || panel_native.is_null() {
        set_last_error("gpu_present_chain_winui: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *mut LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_present_chain_winui: closed/invalid handle".into());
        return -1;
    }
    let inner = &mut *inner_ptr;
    let p = &*params;

    // Entry cancel-check (the meaningful bail point — the chain encodes into one
    // command buffer and submits once, so mid-render cancellation buys nothing).
    if let Some(flag) = crate::cancel::token_from_ptr(cancel) {
        if flag.as_ref().load(std::sync::atomic::Ordering::Relaxed) {
            return RC_PRESENT_CANCELLED;
        }
    }

    // Panic barrier (#1079): wgpu validation panics must not unwind through this
    // extern "C" frame.
    catch_panic_rc("gpu_present_chain_winui", || {
        let inputs = match params::inputs_from_params(p, inner.width, inner.height) {
            Ok(inputs) => inputs,
            Err(message) => {
                set_last_error(message);
                return -1;
            }
        };
        let token = CancelToken::new();
        let mut shared = lock_shared();
        let state = match shared.as_mut() {
            Some(s) => s,
            None => {
                set_last_error("gpu_present_chain_winui: shared GPU context missing".into());
                return -3;
            }
        };
        let final_idx = match inner
            .session
            .render_chain_to_f32(&state.ctx, &inputs, &token)
        {
            Ok(Some(idx)) => idx,
            Ok(None) => {
                set_last_error("gpu_present_chain_winui: chain render returned None".into());
                return -3;
            }
            Err(e) => {
                set_last_error(format!("gpu_present_chain_winui: {e}"));
                return -3;
            }
        };

        // SAFETY: `panel_native` is non-null per the entry check and valid per
        // this fn's contract; the process-wide cache is keyed on
        // `(surface_generation, panel, dims)` so a recycled COM address can
        // never be presented against a stale surface once the host bumps the
        // generation on re-registration.
        match raw_gpu::present_chain_to_swapchain_panel_scaled(
            &state.ctx,
            &inner.session,
            final_idx,
            panel_native,
            &mut state.present_surface_winui,
            surface_generation,
            target_w,
            target_h,
        ) {
            Ok(()) => 0,
            Err(msg) => {
                set_last_error(format!("gpu_present_chain_winui present: {msg}"));
                -4
            }
        }
    })
}
