//! Panorama stitch C-FFI — `maple_pano_stitch` (M3 of epic #1234, issue #1235).
//!
//! # Gating
//!
//! **macOS** (`#[cfg(target_os = "macos")]`): the real path. Calls
//! `maple_pano`'s full pipeline via [`maple_pano::stitch::stitch`] —
//! the single shared orchestration for both this FFI entry and
//! `maple-cli pano stitch` (CLAUDE.md principle #4 — parity is a merge
//! gate). Both callers produce byte-identical output given the same inputs.
//!
//! **iOS / iOS-Simulator** (all other Apple targets): the ML runtime
//! (`ort` + ONNX models) cannot be embedded in the xcframework in the
//! current milestone. The symbol still exists so the link step succeeds,
//! but it returns error code −3 ("unsupported on this platform") and sets
//! `maple_last_error`. iOS embedding is **deliberately deferred to M6 of
//! #1234** — see the `#[cfg(not(target_os = "macos"))]` stub below and
//! the comment there.
//!
//! # ABI conventions (mirrors `render.rs` / `scene_linear_f32.rs`)
//!
//! - All string arguments are null-terminated UTF-8 C strings.
//! - Return code: `0` = success, `<0` = hard error, `>0` = soft error.
//!   Callers inspect `maple_last_error()` for the human-readable reason.
//! - The progress callback (`MaplePanoProgressFn`) and cancel flag
//!   (`MapleCancelFlag`) both accept null (= no-op / never-cancel).
//! - `out_png_path` receives the scene-linear 16-bit PNG (the linear-DNG
//!   spec §5.9 input). Pass a second path via the CLI `--display` flag or
//!   derive it in Swift if an sRGB preview PNG is also needed.
//!
//! # Error codes (negative)
//!
//! ```text
//! −1   null pointer in required argument (raw_paths / out_png_path)
//! −2   count < 2  (panorama needs at least 2 input frames)
//! −3   unsupported on this platform (iOS / iOS-sim; pending M6 #1234)
//! −4   a raw_paths element is not valid UTF-8 or is null
//! −5   out_png_path is not valid UTF-8
//! −6   ML environment unavailable (models or ORT dylib missing)
//! −7   pipeline error (decode / match / BA / composite / write — detail in last_error)
//! ```

use crate::cancel::SendCancelPtr;
use crate::error::set_last_error;
use crate::MapleCancelFlag;

use std::ffi::{c_char, c_void, CStr};

// `with_large_stack` is only referenced inside the `#[cfg(target_os = "macos")]`
// block below. Gate the import the same way so the iOS/iOS-sim build stays
// warning-free.
#[cfg(target_os = "macos")]
use crate::error::with_large_stack;

// ─────────────────────────────────────────────────────────────────────────────
// Public ABI types (cbindgen emits these into RawPipeline.h)
// ─────────────────────────────────────────────────────────────────────────────

/// Frame-retention policy passed to `maple_pano_stitch`.
///
/// `MAPLE_PANO_RETENTION_KEEP` (0): spec §8 product behavior — a frame
/// with a certified rigid core is kept; non-rigid matches are pruned.
/// `MAPLE_PANO_RETENTION_STRICT` (1): the §5.3 residual budgets drop
/// frames, including motion-dominated ones.
#[repr(C)]
#[derive(Clone, Copy)]
pub enum MaplePanoRetention {
    Keep = 0,
    Strict = 1,
}

/// Local-alignment mode passed to `maple_pano_stitch`.
///
/// `MAPLE_PANO_LOCAL_ALIGN_MESH` (0): bounded bilinear mesh absorbs the
/// parallax floor (spec §8, #1218). `MAPLE_PANO_LOCAL_ALIGN_OFF` (1):
/// chain ends at BA rotations.
#[repr(C)]
#[derive(Clone, Copy)]
pub enum MaplePanoLocalAlign {
    Mesh = 0,
    Off = 1,
}

/// Alignment strategy passed to `maple_pano_stitch` (spec §8, #1226).
///
/// `MAPLE_PANO_STRATEGY_AUTO` (0): content-based model selection.
/// `MAPLE_PANO_STRATEGY_ROTATION` (1): force rotation BA.
/// `MAPLE_PANO_STRATEGY_TILE` (2): force planar similarity.
#[repr(C)]
#[derive(Clone, Copy)]
pub enum MaplePanoStrategy {
    Auto = 0,
    Rotation = 1,
    Tile = 2,
}

/// Progress callback type for `maple_pano_stitch`.
///
/// `stage`  — pipeline stage ordinal (0 = decode, 1 = features, 2 = match,
///            3 = refine, 4 = solve, 5 = composite).
/// `frac`   — completion fraction [0, 1] within the current stage.
/// `user`   — the opaque pointer the host passed to `maple_pano_stitch`.
///
/// The callback is invoked from the render worker thread; the host must
/// not block it. Null is accepted (progress events are suppressed).
pub type MaplePanoProgressFn =
    Option<unsafe extern "C" fn(stage: u32, frac: f32, user: *mut c_void)>;

// ─────────────────────────────────────────────────────────────────────────────
// `maple_pano_stitch` entry point
// ─────────────────────────────────────────────────────────────────────────────

/// Stitch a panorama from RAW frames.
///
/// `raw_paths`   — C array of `count` null-terminated UTF-8 paths; must not
///                 be null; count must be ≥ 2.
/// `count`       — number of entries in `raw_paths`.
/// `out_png_path`— where to write the scene-linear 16-bit PNG result; must
///                 not be null.
/// `retention`   — frame-retention policy (use `MAPLE_PANO_RETENTION_KEEP`).
/// `local_align` — local alignment mode (use `MAPLE_PANO_LOCAL_ALIGN_MESH`).
/// `strategy`    — alignment strategy (use `MAPLE_PANO_STRATEGY_AUTO`).
/// `progress_cb` — optional progress callback (null = suppressed).
/// `cb_user`     — opaque pointer forwarded to `progress_cb`; ignored if
///                 `progress_cb` is null.
/// `cancel`      — optional cancel flag; set it from any thread to interrupt
///                 the stitch. Null = never cancel. Use
///                 `maple_cancel_flag_new` / `maple_cancel_flag_set` /
///                 `maple_cancel_flag_free`.
///
/// Returns 0 on success; negative on hard error (see module error-code
/// table); positive on soft error. Call `maple_last_error()` for details.
///
/// # Safety
///
/// `raw_paths` must point to `count` valid null-terminated C strings that
/// outlive the call. `out_png_path` must be a valid null-terminated C string.
/// `cancel` must be null or a pointer from `maple_cancel_flag_new` that has
/// not yet been freed and outlives this call. The function joins all worker
/// threads before returning, so all pointer lifetimes only need to span the
/// synchronous call.
#[no_mangle]
pub unsafe extern "C" fn maple_pano_stitch(
    raw_paths: *const *const c_char,
    count: usize,
    out_png_path: *const c_char,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    progress_cb: MaplePanoProgressFn,
    cb_user: *mut c_void,
    cancel: *const MapleCancelFlag,
) -> i32 {
    // ── argument validation (synchronous, before the worker) ─────────────
    if raw_paths.is_null() || out_png_path.is_null() {
        set_last_error("maple_pano_stitch: null pointer in required argument".into());
        return -1;
    }
    if count < 2 {
        set_last_error(format!(
            "maple_pano_stitch: need at least 2 input frames, got {count}"
        ));
        return -2;
    }

    // Pull owned Strings so the worker thread can own them.
    let mut owned_paths: Vec<String> = Vec::with_capacity(count);
    for i in 0..count {
        let ptr = *raw_paths.add(i);
        if ptr.is_null() {
            set_last_error(format!("maple_pano_stitch: raw_paths[{i}] is null"));
            return -4;
        }
        match CStr::from_ptr(ptr).to_str() {
            Ok(s) => owned_paths.push(s.to_owned()),
            Err(e) => {
                set_last_error(format!("maple_pano_stitch: raw_paths[{i}] not UTF-8: {e}"));
                return -4;
            }
        }
    }
    let out_path_str = match CStr::from_ptr(out_png_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_last_error(format!("maple_pano_stitch: out_png_path not UTF-8: {e}"));
            return -5;
        }
    };

    // Cancel token: pull the AtomicBool pointer and send it across the
    // thread boundary inside SendCancelPtr (same pattern as scene_linear_f32).
    let send_cancel = SendCancelPtr(cancel);

    // Progress callback: the typed `Option<fn-pointer>` and `*mut c_void`
    // are sent across the thread boundary wrapped in their natural types,
    // with no usize round-trip (avoids the transmute UB of the prior impl).
    // Both are valid for the duration of the synchronous call — the worker
    // is joined before `maple_pano_stitch` returns.
    //
    // SAFETY: `progress_cb` is a valid function-pointer option (or None);
    // `cb_user` is the caller's opaque context pointer, valid across the
    // synchronous call. Wrapping them in `SendProgressCallback` makes them
    // sendable across the worker-thread boundary (same contract as
    // `SendCancelPtr`: caller guarantees liveness, worker is joined first).
    let cb = SendProgressCallback {
        f: progress_cb,
        user: cb_user,
    };

    // ── macOS-only stitch path ────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        // `cb` is a `SendProgressCallback` which implements `Send` (see
        // struct-level safety comment). The struct is captured whole so the
        // raw `*mut c_void` it wraps crosses the thread boundary through the
        // `Send` impl, not as a bare naked pointer.
        with_large_stack(move || {
            pano_macos::run_stitch_macos(
                owned_paths,
                out_path_str,
                retention,
                local_align,
                strategy,
                cb, // SendProgressCallback (Send) — pano_macos deconstructs it
                send_cancel,
            )
        })
    }

    // ── Non-macOS stub (iOS / iOS-sim) ────────────────────────────────────
    // Panorama stitch via the ONNX-backed ALIKED + LightGlue pipeline is
    // NOT supported on iOS in this milestone (M3 of #1234). iOS embedding
    // of the ONNX Runtime dylib requires packaging the framework into the
    // xcframework and wiring `ort::init_from` to the on-device path —
    // tracked as **M6 of epic #1234**. Until then, the FFI symbol exists
    // so the static link step succeeds, but calling it returns this error.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            owned_paths,
            out_path_str,
            retention,
            local_align,
            strategy,
            cb,
            send_cancel,
        );
        set_last_error(
            "maple_pano_stitch: not supported on this platform — panorama \
             ONNX-ML stitch on iOS/iPadOS is pending M6 of #1234"
                .into(),
        );
        -3
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send shim for the typed C progress callback
// ─────────────────────────────────────────────────────────────────────────────

/// Wraps the typed C callback + user pointer so both can cross the
/// `with_large_stack` worker-thread boundary.
///
/// SAFETY contract (same as `SendCancelPtr`): the caller guarantees that
/// both pointers remain valid for the duration of the synchronous FFI call.
/// The worker is joined before `maple_pano_stitch` returns, so the pointers
/// outlive all uses inside the worker.
pub(super) struct SendProgressCallback {
    pub(super) f: MaplePanoProgressFn,
    pub(super) user: *mut c_void,
}

// SAFETY: see the struct-level comment. The host must not use `cb_user`
// concurrently while the worker runs (the call is synchronous from the
// host's perspective). `MaplePanoProgressFn` is a plain C function pointer
// — inherently Send.
unsafe impl Send for SendProgressCallback {}

// ─────────────────────────────────────────────────────────────────────────────
// macOS implementation (compiled only on macOS) — split to pano_macos.rs per
// the 600-LOC per-file budget.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
#[path = "pano_macos.rs"]
mod pano_macos;
