//! The GPU capture refine for hosts (#5381), and the live session's atomic
//! image replacement that publishes it.
//!
//! A refine re-runs chroma prefilter, BM3D and capture sharpening on a
//! decode's refine base ([`MapleCaptureBase`]) through raw-gpu's capture
//! passes and returns a capture buffer exactly like the decode's. The host
//! runs it under its decode generation: a newer edit flips `cancel`, the
//! passes stop at the next BM3D tile, and nothing is returned, so a host only
//! ever publishes a complete refine of the current edit. It then replaces the
//! live session's image in one write with [`maple_gpu_live_update_image`].

use super::*;
use crate::cancel::{gpu_token, MapleCancelFlag};
use crate::capture_base::MapleCaptureBase;
use crate::capture_creative::MapleCaptureBufferF32;
use crate::capture_f32::{utf8, write_capture};
use crate::model::{load_xmp_model_owned, LoadModel};
use crate::scene_linear_f32::RC_CANCELLED;
use std::ffi::c_char;

/// The refine's arguments past the base: the edit, and the host's budget.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct MapleCaptureRefineBudget {
    /// The longest base edge the host refines on the GPU (iPhone 1536).
    pub max_long_edge: u32,
    /// The BM3D binding cap in bytes (iPhone 32 MiB); 0 keeps the context's.
    pub bm3d_binding_cap_bytes: u32,
}

/// Refused: the edit changed more than the refinable stages, or the base is
/// over the budget's edge. The host re-develops instead.
pub(crate) const RC_NOT_REFINABLE: i32 = 10;

/// Refine `base` to the model in `xmp_path` and write the capture buffer to
/// `out` (free it with `maple_free_capture_buffer_f32`).
///
/// Returns 0 on success, 1 for a null argument, 3 for a non-UTF-8
/// `xmp_path`, 4 when `cancel` fired (also an XMP parse failure, as in every
/// render entry; `maple_last_error` tells them apart), 5 when no GPU is
/// available, 8 for a render failure, [`RC_NOT_REFINABLE`] when the host must
/// re-develop, or 99 for a contained panic. `out` is written only on 0.
///
/// # Safety
/// `base` a live base; `xmp_path` null or a NUL-terminated path; `cancel`
/// null or a live flag; `out` writable.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_capture_refine(
    base: *const MapleCaptureBase,
    xmp_path: *const c_char,
    budget: MapleCaptureRefineBudget,
    cancel: *const MapleCancelFlag,
    out: *mut MapleCaptureBufferF32,
) -> i32 {
    if base.is_null() || out.is_null() {
        set_last_error("gpu_capture_refine: null pointer".into());
        return 1;
    }
    let base = &*base;
    let token = gpu_token(cancel);
    catch_panic_rc("gpu_capture_refine", || {
        let xmp_path = match utf8(xmp_path, "xmp_path", 3) {
            Ok(path) => path,
            Err(rc) => return rc,
        };
        let loaded = match load_xmp_model_owned(xmp_path.as_deref()) {
            LoadModel::Ok(model) => model,
            LoadModel::Err(rc) => return rc,
        };
        let Some(model) = base.base.refine_model(&loaded) else {
            set_last_error("gpu_capture_refine: the edit changes more than the refine".into());
            return RC_NOT_REFINABLE;
        };
        let (width, height) = base.base.dims();
        if width.max(height) > budget.max_long_edge {
            set_last_error(format!(
                "gpu_capture_refine: {width}x{height} base over the {} px budget",
                budget.max_long_edge
            ));
            return RC_NOT_REFINABLE;
        }
        let mut shared = lock_shared();
        if let Err(e) = ensure_context(&mut shared) {
            set_last_error(format!("gpu_capture_refine: {e}"));
            return 5;
        }
        let ctx = &shared.as_ref().expect("initialized above").ctx;
        if budget.bm3d_binding_cap_bytes > 0 {
            ctx.set_bm3d_binding_cap(budget.bm3d_binding_cap_bytes);
        }
        let refined = raw_core::gpu_host::capture::refine::refine_capture_rgba(
            ctx, &base.base, &model, &token,
        );
        drop(shared);
        let rgba = match refined {
            Ok(Some((rgba, _))) => rgba,
            Ok(None) => return RC_CANCELLED,
            Err(e) => {
                set_last_error(format!("gpu_capture_refine: {e}"));
                return 8;
            }
        };
        let render = match raw_core::pipeline::finish_capture_refine(&base.base, &rgba, &model) {
            Ok(render) => render,
            Err(e) => {
                set_last_error(format!("gpu_capture_refine: {e}"));
                return 8;
            }
        };
        if token.is_cancelled() {
            return RC_CANCELLED;
        }
        write_capture(out as usize, &base.exports, render);
        0
    })
}

/// Replace a live session's image with `pixels` (`width × height` RGBA f32,
/// the session's dims) in one queue write, keeping its buffers, pool and
/// Auto Profile state. Renders already submitted finish on the old image;
/// every later render reads the new one, never a mix.
///
/// Returns 0, -1 for a null or closed handle or null `pixels`, -3 when the
/// dims are not the session's, -4 with no GPU context, or 99 for a
/// contained panic.
///
/// # Safety
/// `handle` a live session with no call in flight on another thread;
/// `pixels` valid for `width*height*4` f32 reads.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_update_image(
    handle: *mut MapleGpuLiveSession,
    pixels: *const f32,
    width: u32,
    height: u32,
) -> i32 {
    if handle.is_null() || pixels.is_null() {
        set_last_error("gpu_live_update_image: null pointer".into());
        return -1;
    }
    let inner_ptr = (*handle).inner as *mut LiveHandleInner;
    if inner_ptr.is_null() {
        set_last_error("gpu_live_update_image: closed/invalid handle".into());
        return -1;
    }
    let inner = &mut *inner_ptr;
    if (width, height) != (inner.width, inner.height) {
        set_last_error(format!(
            "gpu_live_update_image: {width}x{height} for a {}x{} session",
            inner.width, inner.height
        ));
        return -3;
    }
    let px = std::slice::from_raw_parts(pixels, (width as usize) * (height as usize) * 4);
    catch_panic_rc("gpu_live_update_image", || {
        let shared = lock_shared();
        let Some(shared) = shared.as_ref() else {
            set_last_error("gpu_live_update_image: shared GPU context missing".into());
            return -4;
        };
        inner.session.update_image(&shared.ctx, px);
        0
    })
}
