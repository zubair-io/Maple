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

        // Vectorscope scope stats (#3272) — the PREVIOUS tick's sample, if its
        // async map has completed by now; see `LiveSession::take_scope_stats`.
        // Never fails the render: a missed sample just means the host's scope
        // UI is one tick behind, not that the render itself failed.
        if p.scope_enabled != 0 {
            if let Some(stats) = inner.session.take_scope_stats(ctx) {
                crate::scope_stats::write_stats(p.scope_out, stats.frame, stats.total, &stats.bins);
            }
        }
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

/// Read the latest presented frame's 3x256 histogram, without rendering again.
/// Returns 0 on success, 1 before the first present, -1 for invalid arguments,
/// -4 for readback failure, or 99 for a contained panic.
///
/// # Safety
/// `handle` is a live session and `out_bins` holds 768 aligned writable u32s.
#[cfg(target_vendor = "apple")]
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_histogram(
    handle: *const MapleGpuLiveSession,
    out_bins: *mut u32,
) -> i32 {
    if handle.is_null() || out_bins.is_null() || (out_bins as usize) % 4 != 0 {
        return -1;
    }
    let inner = (*handle).inner as *const LiveHandleInner;
    if inner.is_null() {
        return -1;
    }
    catch_panic_rc("gpu_live_histogram", || {
        let shared = lock_shared();
        let Some(state) = shared.as_ref() else {
            return -4;
        };
        match (*inner).session.displayed_histogram(&state.ctx) {
            Ok(Some(bins)) => {
                std::slice::from_raw_parts_mut(out_bins, 768).copy_from_slice(&bins);
                0
            }
            Ok(None) => 1,
            Err(error) => {
                set_last_error(error);
                -4
            }
        }
    })
}

#[cfg(all(test, target_vendor = "apple"))]
mod histogram_tests {
    use super::*;

    #[test]
    fn histogram_rejects_invalid_outputs_and_waits_for_a_present() {
        let mut bins = [99u32; 768];
        assert_eq!(
            unsafe { maple_gpu_live_histogram(std::ptr::null(), bins.as_mut_ptr()) },
            -1
        );
        let pixels = vec![0.18f32; 16 * 16 * 4];
        let mut handle = MapleGpuLiveSession {
            inner: std::ptr::null_mut(),
        };
        assert_eq!(
            unsafe { maple_gpu_live_open(pixels.as_ptr(), 16, 16, &mut handle) },
            0
        );
        assert_eq!(
            unsafe { maple_gpu_live_histogram(&handle, std::ptr::null_mut()) },
            -1
        );
        let mut unaligned = [0u8; 768 * 4 + 4];
        let base = unaligned.as_mut_ptr() as usize;
        let offset = if base % 4 == 0 { 1 } else { 0 };
        assert_eq!(
            unsafe { maple_gpu_live_histogram(&handle, unaligned.as_mut_ptr().add(offset).cast()) },
            -1
        );
        assert_eq!(
            unsafe { maple_gpu_live_histogram(&handle, bins.as_mut_ptr()) },
            1
        );
        assert_eq!(bins, [99; 768]);
        unsafe {
            maple_gpu_live_close(&mut handle);
        }
        assert_eq!(
            unsafe { maple_gpu_live_histogram(&handle, bins.as_mut_ptr()) },
            -1
        );
        assert_eq!(bins, [99; 768]);
    }
}
