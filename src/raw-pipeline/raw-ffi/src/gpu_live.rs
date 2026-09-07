//! `gpu`-gated LIVE-session FFI (epic #925, P4b-core / #1027) — the headless C
//! ABI that drives `raw_gpu::LiveSession` (the pooled, zero-alloc live-render
//! runner) from a host. A persistent handle uploads the decoded f32 scene-linear
//! image ONCE and renders every slider tick through the gated live chain → the
//! terminal dither → one readback of the u8 RGB surface.
//!
//! Gated behind `#[cfg(feature = "gpu")]` with the rest of `gpu.rs`, so wgpu is
//! ABSENT from the default xcframework. The present variant (chain output →
//! `CAMetalLayer` / WebGPU canvas) is per-platform (P4b-apple #1028 / P4b-web
//! #1029); this core entry reads the surface back to host memory, which is the
//! parity-test path and the fallback. Nothing ships until P5.
//!
//! ## Why a NEW params struct (not `MapleAdjustmentParams`)
//!
//! [`crate::MapleAdjustmentParams`] is frozen byte-for-byte with Swift's
//! `makeAdjustmentParams` and is ALL-SCALAR. `FullChainInputs` needs
//! variable-length data the live chain re-applies on the GPU —  the user tone
//! curves (point lists), the prepared-curve mode, the Auto Profile fitted curve,
//! and the residual 3D-LUT grid — which cannot live in a flat scalar struct. So
//! [`MapleGpuLiveParams`] is a SEPARATE, gpu-gated struct carrying the scalars
//! inline + raw `(ptr, len)` pairs for each array. It is never shared with the
//! frozen struct, so it can be shaped for the GPU chain without ABI churn there.
//!
//! ## Threading / lifetime
//!
//! The handle owns BOTH the `GpuContext` (the `Send`-but-`!Sync` device +
//! pipeline cache + the live pool) and the `LiveSession` (the upload-once image + the
//! persistent ping-pong / readback buffers). `LiveSession` does not borrow the
//! context (it holds only GPU buffers), so the two live side-by-side behind one
//! opaque pointer. Single-threaded around the GPU — the host keeps the handle on
//! one owner, exactly as the P1a/P1b notes require.

use crate::error::{catch_panic_rc, set_last_error};
use raw_gpu::{CancelToken, GpuContext, LiveSession};
use std::os::raw::c_void;
use std::sync::Mutex;

/// Process-wide GPU state shared across every live-session open (#1769): ONE
/// `GpuContext` (device + pipeline cache + pool) and ONE cached
/// `CAMetalLayer` present surface.
///
/// ## Why process-wide, not per-handle
///
/// Before #1769 each `maple_gpu_live_open` built its own `GpuContext` and each
/// handle carried its own `present_surface`. Every fast→refine re-open (a new
/// handle at new dims on EVERY cold open) therefore tore down a live
/// surface+device pair against the SAME `CAMetalLayer` (wgpu's `configure`
/// reassigns `layer.device`) at a nondeterministic `deinit` time, while the
/// replacement surface was already presenting — exactly the drawable-pool
/// splice window of the iPad partial-render report. With the context and the
/// surface hoisted here, a dims change is an in-place `configure`
/// (reconfigure + settle double-present) and the surface survives handle
/// re-opens; teardown happens only on an explicit generation/layer change,
/// deterministically, before the replacement is created.
///
/// ## Locking / threading
///
/// `GpuContext` is `Send` but `!Sync` (unsync `OnceCell` pipeline cache,
/// `RefCell` frame pool — the pool's refcounted handles are `Arc`, chosen over
/// `Rc` exactly so this slot needs no `unsafe impl Send`; the `static` below
/// has the compiler prove `GpuShared: Send`). The `Mutex` serializes every FFI
/// entry onto the shared state, which is exactly the "one render in flight"
/// contract the Swift `GpuLiveSession` actor already enforces per session —
/// the lock extends it across sessions (e.g. an old EditSession's teardown
/// racing a new one's first present). Lock poisoning is recovered via
/// `into_inner`-style access: a contained panic elsewhere must not brick
/// rendering forever.
struct GpuShared {
    ctx: GpuContext,
    /// The cached `CAMetalLayer` present surface (#1742/#1769) — created on the
    /// first `maple_gpu_present_chain` call, keyed on `(generation, layer,
    /// dims)`, reused across presents AND across handle re-opens.
    #[cfg(target_vendor = "apple")]
    present_surface: Option<raw_gpu::PersistentPresentSurface>,
    /// The cached WinUI 3 `SwapChainPanel` present surface (#2561) — the
    /// Windows twin of `present_surface`, created on the first
    /// `maple_gpu_present_chain_winui` call with identical cache semantics.
    #[cfg(target_os = "windows")]
    present_surface_winui: Option<raw_gpu::PersistentSwapChainPanelSurface>,
}

static GPU_SHARED: Mutex<Option<GpuShared>> = Mutex::new(None);

/// Lock the shared slot, recovering from poisoning (see [`GpuShared`] docs).
fn lock_shared() -> std::sync::MutexGuard<'static, Option<GpuShared>> {
    GPU_SHARED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

mod repr;
pub use repr::MapleGpuLiveParams;

/// Internal handle state: the per-open session. Behind the opaque pointer.
/// The `GpuContext` and the present-surface cache live in the process-wide
/// [`GpuShared`] slot (#1769), NOT here — a handle re-open (fast→refine, new
/// decode dims) must not tear either down.
struct LiveHandleInner {
    session: LiveSession,
    width: u32,
    height: u32,
}

/// Opaque handle to a GPU-resident live-render session. Allocate via
/// [`maple_gpu_live_open`]; free via [`maple_gpu_live_close`]. The pointee layout
/// is intentionally undocumented — treat `*mut c_void` as opaque.
#[repr(C)]
pub struct MapleGpuLiveSession {
    // `pub(crate)` only so `abi_layout` can `offset_of!` it; still opaque
    // to hosts.
    pub(crate) inner: *mut c_void,
}

/// Open a live-render session: construct a `GpuContext` (Metal on Apple), upload
/// the decoded scene-linear f32 RGBA image ONCE, and allocate the session's
/// persistent buffers. The returned handle renders every subsequent edit via
/// [`maple_gpu_live_render`] without re-uploading or re-allocating (pooled,
/// zero-alloc at stable dims).
///
/// `pixels` MUST point to `width × height × 4` f32 lanes (interleaved RGBA,
/// scene-linear Rec.2020 — the post-DCP develop buffer). The handle copies the
/// pixels into a GPU buffer, so `pixels` need not outlive this call.
///
/// Returns 0 on success and writes the handle into `*handle_out` (always written,
/// null on error). Non-zero on error (call `maple_last_error`):
///   -1 `handle_out` null · -2 `pixels` null · -3 zero dimension ·
///   -4 pixel-count overflow · -5 GPU init failed (no adapter / device request) ·
///   -6 the session was rejected (image exceeds the device's buffer/binding
///      limits — #1079) · 99 a Rust-side panic was contained (see
///      `maple_last_error`; mirrors the CPU entries' worker-panic rc).
///
/// A nonzero return is always safe to treat as "use the CPU render path".
///
/// # Safety
/// `pixels` valid for `width*height*4` f32 reads; `handle_out` a valid `*mut`.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_live_open(
    pixels: *const f32,
    width: u32,
    height: u32,
    handle_out: *mut MapleGpuLiveSession,
) -> i32 {
    if handle_out.is_null() {
        return -1;
    }
    // Always write a null handle first so the caller can rely on the out-param.
    (*handle_out).inner = std::ptr::null_mut();
    if pixels.is_null() {
        set_last_error("gpu_live_open: pixels null".into());
        return -2;
    }
    if width == 0 || height == 0 {
        set_last_error(format!("gpu_live_open: zero dimension {width}x{height}"));
        return -3;
    }
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "gpu_live_open: pixel-count overflow {width}x{height}"
            ));
            return -4;
        }
    };
    let px = std::slice::from_raw_parts(pixels, lanes);

    // Panic barrier (#1079): wgpu validation/`handle_error_fatal` panics must not
    // unwind through this `extern "C"` frame (an abort on Apple). rc 99 + a
    // last-error message instead — the Swift host CPU-falls-back on any nonzero.
    catch_panic_rc("gpu_live_open", || {
        // One process-wide GpuContext (#1769): created on the FIRST open, reused
        // by every subsequent open/render/present. See [`GpuShared`].
        let mut shared = lock_shared();
        if shared.is_none() {
            match GpuContext::new_blocking() {
                Ok(ctx) => {
                    *shared = Some(GpuShared {
                        ctx,
                        #[cfg(target_vendor = "apple")]
                        present_surface: None,
                        #[cfg(target_os = "windows")]
                        present_surface_winui: None,
                    });
                }
                Err(e) => {
                    set_last_error(format!("gpu_live_open: {e}"));
                    return -5;
                }
            }
        }
        let ctx = &shared.as_ref().expect("initialized above").ctx;
        // Validates dims against the device's REAL limits before allocating.
        let session = match LiveSession::new(ctx, px, width, height) {
            Ok(s) => s,
            Err(e) => {
                set_last_error(format!("gpu_live_open: {e}"));
                return -6;
            }
        };
        let boxed = Box::new(LiveHandleInner {
            session,
            width,
            height,
        });
        (*handle_out).inner = Box::into_raw(boxed) as *mut c_void;
        0
    })
}

mod entries;
// The moved entries are `#[no_mangle] extern "C"` and reach the C ABI by symbol,
// so the lib target never names them — the re-export exists so this module's own
// test children still resolve them unqualified after the split.
#[allow(unused_imports)]
pub use entries::*;

// The Apple `CAMetalLayer` present entry (`maple_gpu_present_chain` +
// `RC_PRESENT_CANCELLED`) lives in a sibling module (600-LOC file budget; same
// split pattern as `params` below and `scene_linear_chain_f32_entry.rs`). The
// cfg here mirrors the `#[cfg(target_vendor = "apple")]` the entry carried
// inline; cbindgen still wraps the declaration in `#if defined(__APPLE__)`.
#[cfg(target_vendor = "apple")]
mod present;

// The Windows `SwapChainPanel` present entry (`maple_gpu_present_chain_winui`,
// #2561) — the DX12 twin of `present`, same sibling-module split.
#[cfg(target_os = "windows")]
mod present_winui;

// The C-params -> FullChainInputs marshalling lives in a sibling module
// (600-LOC file budget; same split pattern as raw_gpu's live_session/limits).
mod params;

// Tests live in sibling files (600-LOC budget). The dehaze / on-GPU-airlight
// host gate is split out (#1098), mirroring raw-gpu's `live_session` /
// `airlight_tests` split; it reuses `gpu_live_tests`' `pub(super)` helpers.
#[cfg(test)]
#[path = "gpu_live_airlight_tests.rs"]
mod gpu_live_airlight_tests;
#[cfg(test)]
#[path = "gpu_live_p3_tests.rs"]
mod gpu_live_p3_tests;
// Shared fixtures/param builders for the gpu_live test family — split from
// gpu_live_tests.rs for the 600-LOC budget (canonical import path stays
// `super::gpu_live_tests::{..}` via re-exports there).
#[cfg(test)]
#[path = "gpu_live_test_support.rs"]
mod gpu_live_test_support;
#[cfg(test)]
#[path = "gpu_live_tests.rs"]
mod gpu_live_tests;
// Non-RAW (JPEG/HEIC) WB slider contract parity (#1734) — split out so this
// file stays under the 600-LOC budget.
#[cfg(test)]
#[path = "gpu_live_nonraw_wb_tests.rs"]
mod gpu_live_nonraw_wb_tests;
// WB slider-frame gates (#1781): zero-frame legacy equivalence + the frame
// parity gate. The fixture-gated live-vs-refine seam metric lives in the
// sibling `gpu_live_wb_seam_tests` (split per the 600-LOC budget).
#[cfg(test)]
#[path = "gpu_live_wb_frame_tests.rs"]
mod gpu_live_wb_frame_tests;
// #1732 legs (a) vs (b) beyond WB: the gpu-live surface against the REAL
// `apply_scene_linear_chain_f32` (not a re-composed oracle) across a
// parameterised model set, plus the non-RAW `input_shape` ⟷ `skip_agx` pair.
#[cfg(test)]
#[path = "gpu_live_chain_parity_tests.rs"]
mod gpu_live_chain_parity_tests;
#[cfg(test)]
#[path = "gpu_live_wb_seam_tests.rs"]
mod gpu_live_wb_seam_tests;
// Film-look tail host parity (epic #2683, Task 8) — split out per the
// 600-LOC budget; reuses `gpu_live_tests`' + `gpu_live_wb_frame_tests`'
// `pub(super)` helpers the same way the other siblings above do.
#[cfg(test)]
#[path = "gpu_live_film_tests.rs"]
mod gpu_live_film_tests;
// The vectorscope scope-pass FFI round trip (#3272) — split out per the
// 600-LOC budget; reuses `gpu_live_tests`' `pub(super)` helpers the same way
// the other siblings above do.
#[cfg(test)]
#[path = "gpu_live_bitmap_scope_tests.rs"]
mod gpu_live_bitmap_scope_tests;
#[cfg(test)]
#[path = "gpu_live_scope_tests.rs"]
mod gpu_live_scope_tests;
#[cfg(test)]
#[path = "gpu_live_scope_timing_tests.rs"]
mod gpu_live_scope_timing_tests;
