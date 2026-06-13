//! Apple stitch implementation for `maple_pano_stitch` (M3 of #1234 #1235;
//! iOS enabled in M6 #1244; CoreML EP enabled in M6-C #1251).
//!
//! Thin caller of [`maple_pano::stitch::stitch`] — the single shared
//! orchestration for both this FFI entry and `maple-cli pano stitch`
//! (CLAUDE.md principle #4 — parity is a merge gate). All pipeline
//! stages (decode → ALIKED → LightGlue → match graph → refine → BA →
//! leveling → composite) live in `maple_pano::stitch`.
//!
//! Platform differences:
//! - **macOS** (`--features pano`, `target_os = "macos"`): ORT initialized
//!   via `load-dynamic` (`ort::init_from`). CPU execution provider only.
//!   The macOS path is parity-verified against ACR references and must not
//!   change; `use_coreml` is not set.
//! - **iOS** (`--features pano-ios`, `target_os = "ios"`, M6 #1244): ORT
//!   statically linked (`ort::init()`). `use_coreml = true` enables the
//!   CoreML Execution Provider for both ALIKED and LightGlue sessions —
//!   ANE/GPU-eligible ops route to Apple silicon; unsupported ops fall
//!   back to ORT-CPU automatically (graceful, never crashes).
//!
//! # M6-E: ANE speedup UNVALIDATED on-device
//!
//! The CoreML EP is wired correctly and compiles into the iOS slices, but
//! the actual ANE/GPU acceleration is unvalidated — there is no ANE in the
//! iOS Simulator. Real-device validation (estimated ~25s→~5s on A-series)
//! is owed by M6-E. Do not claim a perf number until M6-E lands.

use crate::cancel::{token_from_ptr, SendCancelPtr};
use crate::error::set_last_error;

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use maple_pano::ba::RetentionPolicy;
use maple_pano::render::write_frame_png;
use maple_pano::stitch::{stitch, StitchError, StitchOptions};
use maple_pano::strategy::StrategyRequest;

use super::{MaplePanoLocalAlign, MaplePanoRetention, MaplePanoStrategy, SendProgressCallback};

/// Full Apple stitch pipeline. Called by `maple_pano_stitch` after argument
/// validation; runs on a large-stack worker thread (see `with_large_stack`
/// in the caller). Returns 0 on success, negative on failure (last_error set).
pub(super) fn run_stitch_apple(
    input_paths: Vec<String>,
    out_png_path: String,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    cb: SendProgressCallback,
    send_cancel: SendCancelPtr,
) -> i32 {
    let opts = StitchOptions {
        retention: match retention {
            MaplePanoRetention::Keep => RetentionPolicy::KeepAlignable,
            MaplePanoRetention::Strict => RetentionPolicy::Strict,
        },
        local_align: matches!(local_align, MaplePanoLocalAlign::Mesh),
        strategy: match strategy {
            MaplePanoStrategy::Auto => StrategyRequest::Auto,
            MaplePanoStrategy::Rotation => StrategyRequest::Rotation,
            MaplePanoStrategy::Tile => StrategyRequest::Tile,
        },
        // M6-C (#1251): enable CoreML EP on iOS only. macOS stays on CPU-ORT
        // (parity-verified; do not change). On iOS the simulator falls back to
        // ORT-CPU automatically (no ANE); real-device ANE speedup is
        // unvalidated — pending M6-E.
        #[cfg(target_os = "ios")]
        use_coreml: true,
        ..StitchOptions::default()
    };

    let inputs: Vec<PathBuf> = input_paths.iter().map(PathBuf::from).collect();

    // Adapt the typed C progress callback (inside SendProgressCallback) into
    // a Rust closure. No usize round-trip: we hold the `Option<fn-pointer>`
    // + `*mut c_void` directly and call them through their C types. The
    // worker is joined before `maple_pano_stitch` returns, so both remain
    // valid here.
    let progress = move |stage: u32, frac: f32| {
        if let Some(f) = cb.f {
            // SAFETY: `f` is a valid extern "C" fn; `cb.user` is the
            // caller-supplied opaque pointer, valid for the duration of the
            // synchronous FFI call (the worker is joined before returning).
            unsafe { f(stage, frac, cb.user) };
        }
    };

    let is_cancelled = || {
        if send_cancel.0.is_null() {
            return false;
        }
        // SAFETY: non-null pointer from `maple_cancel_flag_new`, still alive
        // because `maple_pano_stitch` is synchronous (joins before returning).
        if let Some(atomic_ptr) = unsafe { token_from_ptr(send_cancel.0) } {
            unsafe { atomic_ptr.as_ref() }.load(Ordering::Relaxed)
        } else {
            false
        }
    };

    match stitch(&inputs, &opts, progress, is_cancelled) {
        Ok(outcome) => {
            // Write the scene-linear 16-bit PNG.
            let out_path = std::path::Path::new(&out_png_path);
            if let Some(parent) = out_path.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        set_last_error(format!("maple_pano_stitch: create output dir: {e}"));
                        return -7;
                    }
                }
            }
            // Quantize to 16-bit (scene-linear, no sRGB — mirrors
            // `write_png16(path, img, srgb=false)` in maple-cli pano/io.rs).
            let img = &outcome.image;
            let n = img.pixel_count();
            let mut data: Vec<u16> = Vec::with_capacity(n * 3);
            for i in 0..n {
                data.push((img.r[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
                data.push((img.g[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
                data.push((img.b[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
            }
            if let Err(e) = write_frame_png(out_path, img.width(), img.height(), &data) {
                set_last_error(format!("maple_pano_stitch: write PNG: {e}"));
                return -7;
            }
            0
        }

        Err(StitchError::Cancelled) => {
            set_last_error("maple_pano_stitch: cancelled by caller".into());
            -7
        }

        Err(StitchError::MlUnavailable(msg)) => {
            set_last_error(format!("maple_pano_stitch: {msg}"));
            -6
        }

        // Tile strategy selected: FFI does not yet implement tile.
        // Tracked as the next sub-task of #1235. The CLI tile path is
        // unaffected — it uses its own tile.rs caller.
        Err(StitchError::TileNotSupported(_)) => {
            set_last_error(
                "maple_pano_stitch: tile strategy selected — tile FFI path \
                 is not yet implemented; pass strategy=Rotation or retry \
                 with Strategy::Auto on a rotation-dominated set"
                    .into(),
            );
            -7
        }

        Err(e) => {
            set_last_error(format!("maple_pano_stitch: {e}"));
            -7
        }
    }
}
