//! Apple stitch implementation for `maple_pano_stitch` (M3 of #1234 #1235;
//! iOS enabled in M6 #1244; CoreML EP enabled in M6-C #1251; unified
//! tile path in #1270).
//!
//! Thin caller of [`maple_pano::stitch::stitch`] — the single shared
//! orchestration for both this FFI entry and `maple-cli pano stitch`
//! (CLAUDE.md principle #4 — parity is a merge gate). All pipeline
//! stages (decode → ALIKED → LightGlue → match graph → refine → strategy
//! tail → composite) live in `maple_pano::stitch`.
//!
//! After #1270 `stitch` handles both rotation and tile internally.
//! The caller receives a [`StitchSuccess`] enum and no longer needs to
//! fall through to a separate `stitch_tile` call — ALIKED + LightGlue
//! run exactly once regardless of which strategy is selected.
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
use maple_pano::exif_embed::build_exif_blob;
use maple_pano::ingest::PlanarImage;
use maple_pano::render::{write_frame_png, PngMetadata};
use maple_pano::stitch::{
    develop_for_display, stitch, write_display_sidecars, StitchError, StitchOptions, StitchSuccess,
};
use maple_pano::strategy::StrategyRequest;
use raw_core::read_exif;

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
    let mut progress = move |stage: u32, frac: f32| {
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

    // Build display PNG metadata from the first source frame (capture order =
    // sorted order, matching how inputs arrive from Swift). Degrades silently
    // to sRGB-tagged-only if the source is unreadable or carries no metadata.
    let display_meta = {
        let exif_blob = inputs.first().and_then(|path| {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("dng")
                .to_lowercase();
            let bytes = std::fs::read(path).ok()?;
            let exif = read_exif(&bytes, &ext).ok()?;
            build_exif_blob(&exif)
        });
        PngMetadata {
            exif_blob,
            tag_srgb: true,
        }
    };

    // Quantize a scene-linear PlanarImage to 16-bit and write it as a PNG.
    // Shared by the rotation (`stitch`) and tile (`stitch_tile`) success paths.
    // Returns 0 on success, -7 on a filesystem/encode error (last_error set).
    let write_out = |img: &PlanarImage| -> i32 {
        let out_path = std::path::Path::new(&out_png_path);
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    set_last_error(format!("maple_pano_stitch: create output dir: {e}"));
                    return -7;
                }
            }
        }
        // Develop the scene-linear composite into a FINISHED, display-referred
        // sRGB 16-bit buffer (#1335): AgX view tail matching raw-core's RAW
        // render, so the app re-opens the pano as a correct photo instead of
        // mis-reading scene-linear Rec.2020 data as display sRGB
        // (cold/desaturated/flat). develop_for_display already encodes + quantizes.
        let data = develop_for_display(img);
        // Embed EXIF from the first source frame + tag as sRGB (#1333).
        if let Err(e) = write_frame_png(out_path, img.width(), img.height(), &data, &display_meta) {
            set_last_error(format!("maple_pano_stitch: write PNG: {e}"));
            return -7;
        }
        // Render-time derivatives (#1365): 256px thumb + 1280px preview into
        // <dir>/.maple/{thumbs,previews}/ so the grid tile isn't a blank ghost
        // and cold-open is instant. The preview is the canonical
        // `<filename>.avif` Apple's read path expects (#2009). Non-fatal — the
        // pano itself already wrote.
        if let Err(e) = write_display_sidecars(data, img.width(), img.height(), out_path) {
            eprintln!("maple_pano_stitch: derivative generation failed (non-fatal): {e}");
        }
        0
    };

    // After #1270, `stitch` handles both rotation and tile internally.
    // ALIKED + LightGlue run exactly once; the tile path re-uses their output
    // without a second decode or ML pass.  No `TileNotSupported` fallthrough.
    match stitch(&inputs, &opts, &mut progress, &is_cancelled) {
        Ok(StitchSuccess::Rotation(outcome)) => write_out(&outcome.image),
        Ok(StitchSuccess::Tile(tile)) => write_out(&tile.image),

        Err(StitchError::Cancelled) => {
            set_last_error("maple_pano_stitch: cancelled by caller".into());
            -7
        }
        Err(StitchError::MlUnavailable(msg)) => {
            set_last_error(format!("maple_pano_stitch: {msg}"));
            -6
        }
        // rc -8: degenerate rotation geometry — the caller should retry with
        // Auto or Tile strategy. Distinct from -7 (generic failure) so Swift
        // callers can surface "use Auto/Tile" rather than a generic error.
        Err(StitchError::DegenerateGeometry(msg)) => {
            set_last_error(format!(
                "maple_pano_stitch: rotation geometry is degenerate — {msg}; \
                 retry with Auto or Tile strategy"
            ));
            -8
        }
        Err(e) => {
            set_last_error(format!("maple_pano_stitch: {e}"));
            -7
        }
    }
}
