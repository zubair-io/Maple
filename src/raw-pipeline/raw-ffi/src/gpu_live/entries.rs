//! Live-session render + teardown entry points, split out of `gpu_live.rs`
//! for the 600-line hard budget — the same pure-relocation split `params.rs`
//! and `present.rs` already took from that file. #1698 and #1714 each appended
//! to `MapleGpuLiveParams`'s tail; neither crossed the limit alone, their sum
//! did.
//!
//! Behaviour is unchanged; only the file boundary moved.

use super::*;

/// Render one edit on a live session: build the gated chain from `params`, run it
/// + the terminal dither on the session's pooled buffers, and copy the resulting
/// `width × height × 3` u8 RGB surface into `out_ptr` (row-major, alpha dropped —
/// the canonical `dither_and_quantize` layout). `out_ptr` MUST hold at least
/// `3 × width × height` bytes (query dims from the open call).
///
/// The dehaze atmospheric light is measured INTERNALLY from the post-prefix
/// buffer (a mid-chain readback when dehaze is engaged — raw-core measures A at
/// dehaze's position, not from the original input), so the host does not supply
/// it. The on-GPU reduction that removes that per-tick readback is C5b.
///
/// Returns 0 on success. Non-zero on error (call `maple_last_error`):
///   -1 handle/params/out null · -3 the GPU render returned no buffer
///   (cancelled internally) · -4 the GPU render failed (init/readback error) ·
///   -5 internal output-size mismatch (`out_ptr` is NOT written) ·
///   99 a Rust-side panic was contained.
///
/// A nonzero return is always safe to treat as "use the CPU render path".
///
/// # Safety
/// `handle` a live handle from [`maple_gpu_live_open`]; `params` valid (incl. its
/// array pointers); `out_ptr` valid for `3*w*h` bytes.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_render(
    handle: *const MapleGpuLiveSession,
    params: *const MapleGpuLiveParams,
    out_ptr: *mut u8,
) -> i32 {
    if handle.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("gpu_live_render: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *const LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_live_render: closed/invalid handle".into());
        return -1;
    }
    let inner = &*inner_ptr;
    let p = &*params;

    // Panic barrier (#1079) — see `maple_gpu_live_open`.
    catch_panic_rc("gpu_live_render", || {
        let inputs = params::inputs_from_params(p);
        let cancel = CancelToken::new();
        let shared = lock_shared();
        let ctx = match shared.as_ref() {
            Some(s) => &s.ctx,
            None => {
                set_last_error("gpu_live_render: shared GPU context missing".into());
                return -4;
            }
        };
        let out = match inner.session.render_to_buffer(ctx, &inputs, &cancel) {
            Ok(Some(v)) => v,
            Ok(None) => {
                set_last_error("gpu_live_render: render returned None".into());
                return -3;
            }
            Err(e) => {
                set_last_error(format!("gpu_live_render: {e}"));
                return -4;
            }
        };

        // REAL length check (#1079; was debug_assert_eq! only): a short buffer
        // here would under- or over-run the host's `3*w*h` allocation in release
        // builds. Bail with an rc instead of copying.
        let expected = (inner.width as usize) * (inner.height as usize) * 3;
        if out.len() != expected {
            set_last_error(format!(
                "gpu_live_render: internal: dither output len {} != expected {expected}",
                out.len()
            ));
            return -5;
        }
        let out_slice = std::slice::from_raw_parts_mut(out_ptr, expected);
        out_slice.copy_from_slice(&out);
        0
    })
}

/// Free a live-render session handle. Idempotent for a null `inner`; after this
/// the handle MUST NOT be used. Drops the `GpuContext` + `LiveSession` (releasing
/// all GPU buffers + the pool).
///
/// # Safety
/// `handle` was produced by [`maple_gpu_live_open`] and is not used afterward.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_close(handle: *mut MapleGpuLiveSession) {
    if handle.is_null() {
        return;
    }
    let inner = (*handle).inner;
    if !inner.is_null() {
        // Null the handle BEFORE the drop so a contained panic can't leave a
        // dangling pointer for a later double-free. Panic barrier (#1079):
        // releasing wgpu resources can panic on a lost device; swallowing it
        // (after recording the message) beats aborting the app on teardown.
        (*handle).inner = std::ptr::null_mut();
        let _ = catch_panic_rc("gpu_live_close", || {
            drop(Box::from_raw(inner as *mut LiveHandleInner));
            0
        });
    }
}
