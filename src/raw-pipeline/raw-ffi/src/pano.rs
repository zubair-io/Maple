//! Panorama stitch C-FFI — `maple_pano_stitch` (M3 of epic #1234, issue #1235).
//!
//! # Gating
//!
//! **macOS** (`#[cfg(target_os = "macos")]`): the real path. Calls
//! `maple_pano`'s full pipeline — decode → priors → proxy → ALIKED +
//! LightGlue → match graph → full-resolution refinement → global BA →
//! leveling → composite → 16-bit PNG — mirroring `maple-cli pano stitch`
//! exactly (same models, same code → output is byte-identical given the
//! same inputs).
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

// `token_from_ptr`, `with_large_stack`, and `Ordering` are only referenced
// inside the `#[cfg(target_os = "macos")]` blocks below. Gate the imports
// the same way so the iOS/iOS-sim build stays warning-free.
#[cfg(target_os = "macos")]
use crate::cancel::token_from_ptr;
#[cfg(target_os = "macos")]
use crate::error::with_large_stack;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;

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
///            3 = refine, 4 = solve, 5 = composite, 6 = write).
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

    // Progress callback: wrap as a sendable usize pair (fn ptr + user data)
    // so the worker can call it without a raw *mut c_void crossing Send.
    let cb_fn_usize: usize = match progress_cb {
        Some(f) => f as usize,
        None => 0,
    };
    let cb_user_usize: usize = cb_user as usize;

    // ── macOS-only stitch path ────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        with_large_stack(move || {
            run_stitch_macos(
                owned_paths,
                out_path_str,
                retention,
                local_align,
                strategy,
                cb_fn_usize,
                cb_user_usize,
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
            cb_fn_usize,
            cb_user_usize,
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
// macOS implementation (compiled only on macOS)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn run_stitch_macos(
    input_paths: Vec<String>,
    out_png_path: String,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    cb_fn_usize: usize,
    cb_user_usize: usize,
    send_cancel: SendCancelPtr,
) -> i32 {
    use std::path::PathBuf;

    use maple_pano::ba::{self, BaOptions, RetentionPolicy};
    use maple_pano::canvas::{CanvasOptions, ProjectionMode};
    use maple_pano::composite::{composite, CompositeOptions};
    use maple_pano::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
    use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
    use maple_pano::graph::{
        build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage,
    };
    use maple_pano::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
    use maple_pano::leveling;
    use maple_pano::matching::LightGlueMatcher;
    use maple_pano::models::ModelDir;
    use maple_pano::refine::{refine_correspondences, RefineGeometry, RefineOptions};
    use maple_pano::render::write_frame_png;
    use maple_pano::robust::RobustOptions;
    use maple_pano::strategy::{select_strategy, Strategy, StrategyRequest};
    use maple_pano::twoview::PixelCorrespondence;

    // Helper: emit a progress event (fn ptr + user data both survive as
    // usizes; reconstitute them safely here on the worker thread).
    let emit_progress = |stage: u32, frac: f32| {
        if cb_fn_usize != 0 {
            // SAFETY: cb_fn_usize was cast from a valid function pointer and
            // cb_user_usize from a c_void* the caller is responsible for.
            // The worker joins before maple_pano_stitch returns, so both
            // remain valid for the duration of this closure's invocations.
            unsafe {
                let f: unsafe extern "C" fn(u32, f32, *mut c_void) =
                    std::mem::transmute(cb_fn_usize);
                f(stage, frac, cb_user_usize as *mut c_void);
            }
        }
    };

    // Helper: check cancel flag.
    let is_cancelled = || {
        if send_cancel.0.is_null() {
            return false;
        }
        // SAFETY: the pointer is from maple_cancel_flag_new and the host
        // guarantees it outlives this synchronous call.
        if let Some(atomic_ptr) = unsafe { token_from_ptr(send_cancel.0) } {
            unsafe { atomic_ptr.as_ref() }.load(Ordering::Relaxed)
        } else {
            false
        }
    };

    // Default proxy long-edge (mirrors CLI default: 1600).
    const PROXY_LONG_EDGE: u32 = 1600;
    // Default canvas pixel cap (matches CLI: 256M).
    const MAX_CANVAS_PX: usize = 256_000_000;
    // Spec §5.3 gates.
    const MEAN_BUDGET_PX: f64 = 1.5;
    const MAX_BUDGET_PX: f64 = 6.0;

    // ── stage 0: decode + priors ─────────────────────────────────────────
    emit_progress(0, 0.0);
    let inputs: Vec<PathBuf> = input_paths.iter().map(PathBuf::from).collect();
    let mut frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            set_last_error("maple_pano_stitch: cancelled by caller".into());
            return -7;
        }
        match ingest_file(path) {
            Ok(f) => frames.push(f),
            Err(e) => {
                set_last_error(format!("maple_pano_stitch: decode {}: {e}", path.display()));
                return -7;
            }
        }
        emit_progress(0, (i + 1) as f32 / inputs.len() as f32);
    }
    let applied_opcodes: Vec<Vec<String>> =
        frames.iter().map(|f| f.applied_opcodes.clone()).collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    emit_progress(1, 0.0);

    // Load the ML stack. ModelDir::resolve reads MAPLE_PANO_MODELS.
    let models = match ModelDir::resolve(None) {
        Ok(m) => m,
        Err(e) => {
            set_last_error(format!(
                "maple_pano_stitch: ML environment unavailable: {e}\n\
                 Set MAPLE_PANO_MODELS to the models dir and ORT_DYLIB_PATH \
                 to libonnxruntime (>= 1.23)."
            ));
            return -6;
        }
    };
    let mut detector = match AlikedDetector::load(&models, DetectorOptions::default()) {
        Ok(d) => d,
        Err(e) => {
            set_last_error(format!("maple_pano_stitch: ALIKED load failed: {e}"));
            return -6;
        }
    };
    let mut matcher = match LightGlueMatcher::load(&models, Default::default()) {
        Ok(m) => m,
        Err(e) => {
            set_last_error(format!("maple_pano_stitch: LightGlue load failed: {e}"));
            return -6;
        }
    };

    // Interleave planar RGB into the detector's packed-RGB f32 layout.
    // Mirrors maple-cli pano/io.rs `interleave`.
    let interleave = |img: &PlanarImage| -> Vec<f32> {
        let n = img.pixel_count();
        let mut out = Vec::with_capacity(n * 3);
        for i in 0..n {
            out.push(img.r[i]);
            out.push(img.g[i]);
            out.push(img.b[i]);
        }
        out
    };

    let mut feature_sets: Vec<FeatureSet> = Vec::with_capacity(frames.len());
    let mut proxy_scale: Vec<f64> = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());
    for (i, frame) in frames.iter().enumerate() {
        if is_cancelled() {
            set_last_error("maple_pano_stitch: cancelled by caller".into());
            return -7;
        }
        let proxy = proxy_to_long_edge(&frame.image, PROXY_LONG_EDGE);
        proxy_scale.push(frame.image.width() as f64 / proxy.width() as f64);
        proxy_dims.push((proxy.width(), proxy.height()));
        let rgb = interleave(&proxy);
        let lin = match LinearRgbFrame::new(proxy.width(), proxy.height(), rgb) {
            Ok(l) => l,
            Err(e) => {
                set_last_error(format!(
                    "maple_pano_stitch: frame {i} proxy LinearRgbFrame: {e}"
                ));
                return -7;
            }
        };
        match detector.detect(&lin) {
            Ok(fs) => feature_sets.push(fs),
            Err(e) => {
                set_last_error(format!("maple_pano_stitch: frame {i} detect: {e}"));
                return -7;
            }
        }
        emit_progress(1, (i + 1) as f32 / frames.len() as f32);
    }

    // Full-resolution camera seeds (BA input) — EXIF focal in native pixels.
    let mut full_images: Vec<GraphImage> = Vec::with_capacity(frames.len());
    for (frame, path) in frames.iter().zip(inputs.iter()) {
        let focal_px = match frame.priors.focal_px {
            Some(f) => f,
            None => {
                set_last_error(format!(
                    "maple_pano_stitch: {}: no EXIF 35mm focal — cannot seed camera model",
                    path.display()
                ));
                return -7;
            }
        };
        full_images.push(GraphImage {
            camera: maple_pano::camera::Camera::new(
                [0.0; 3],
                focal_px,
                0.0,
                0.0,
                frame.image.width(),
                frame.image.height(),
            ),
            prior_rotation: frame
                .priors
                .gimbal
                .as_ref()
                .map(ba::init::rotation_from_gimbal),
        });
    }
    let proxy_images: Vec<GraphImage> = full_images
        .iter()
        .enumerate()
        .map(|(i, img)| GraphImage {
            camera: maple_pano::camera::Camera::new(
                [0.0; 3],
                img.camera.focal_px / proxy_scale[i],
                0.0,
                0.0,
                proxy_dims[i].0,
                proxy_dims[i].1,
            ),
            prior_rotation: img.prior_rotation,
        })
        .collect();

    // ── stage 2: match graph ──────────────────────────────────────────────
    emit_progress(2, 0.0);
    if is_cancelled() {
        set_last_error("maple_pano_stitch: cancelled by caller".into());
        return -7;
    }
    let mut match_failures: Vec<String> = Vec::new();
    let mut graph = build_match_graph(
        &proxy_images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| -> Vec<PixelCorrespondence> {
            match matcher.match_features(&feature_sets[a], &feature_sets[b]) {
                Ok(ml_matches) => ml_matches_to_correspondences(&ml_matches, DEFAULT_MIN_SCORE),
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            }
        },
        &RobustOptions::default(),
    );
    if !match_failures.is_empty() {
        set_last_error(format!(
            "maple_pano_stitch: LightGlue failed on {} pair(s): {}",
            match_failures.len(),
            match_failures.join("; ")
        ));
        return -7;
    }
    emit_progress(2, 1.0);

    // ── strategy selection ────────────────────────────────────────────────
    let mean_focal_px = {
        let vals: Vec<f64> = full_images.iter().map(|img| img.camera.focal_px).collect();
        if vals.is_empty() {
            1.0
        } else {
            vals.iter().sum::<f64>() / vals.len() as f64
        }
    };
    let priors: Vec<maple_pano::ingest::FramePriors> =
        frames.iter().map(|f| f.priors.clone()).collect();
    let strategy_request = match strategy {
        MaplePanoStrategy::Auto => StrategyRequest::Auto,
        MaplePanoStrategy::Rotation => StrategyRequest::Rotation,
        MaplePanoStrategy::Tile => StrategyRequest::Tile,
    };
    let strategy_report = select_strategy(
        strategy_request,
        &graph,
        &priors,
        mean_focal_px,
        0x1226_cafe_dead_beef,
    );

    let retention_policy = match retention {
        MaplePanoRetention::Keep => RetentionPolicy::KeepAlignable,
        MaplePanoRetention::Strict => RetentionPolicy::Strict,
    };
    let local_align_enabled = matches!(local_align, MaplePanoLocalAlign::Mesh);

    match strategy_report.selected {
        // ── tile strategy ─────────────────────────────────────────────────
        // Tile stitch via this FFI entry is not yet implemented.
        // The tile orchestrator has a different control flow (no BA solution,
        // no per-frame rotation poses) that requires its own small wrapper.
        // Full tile FFI support is the next sub-task of #1235; for now the
        // caller should pass Strategy::Rotation or Strategy::Auto on
        // rotation-dominated sets. The CLI tile path is unaffected.
        Strategy::Tile => {
            set_last_error(
                "maple_pano_stitch: tile strategy selected — tile FFI path \
                 is not yet implemented; pass strategy=Rotation or retry \
                 with Strategy::Auto on a rotation-dominated set"
                    .into(),
            );
            -7
        }

        // ── rotation strategy (the primary path) ──────────────────────────
        Strategy::Rotation => {
            // ── stage 3: full-resolution NCC refinement + reverification ─
            emit_progress(3, 0.0);
            if is_cancelled() {
                set_last_error("maple_pano_stitch: cancelled by caller".into());
                return -7;
            }
            let (mut refined_matches, mut fallback_matches) = (0usize, 0usize);
            for edge in &mut graph.edges {
                let (img_a, img_b) = (&frames[edge.a].image, &frames[edge.b].image);
                let scale_of = |img: &PlanarImage, i: usize| {
                    (
                        img.width() as f64 / proxy_dims[i].0 as f64,
                        img.height() as f64 / proxy_dims[i].1 as f64,
                    )
                };
                let geometry = RefineGeometry {
                    cam_a: &full_images[edge.a].camera,
                    cam_b: &full_images[edge.b].camera,
                    rotation: &edge.rotation,
                };
                let outcome = refine_correspondences(
                    img_a,
                    img_b,
                    scale_of(img_a, edge.a),
                    scale_of(img_b, edge.b),
                    Some(&geometry),
                    &edge.inlier_matches,
                    &RefineOptions::default(),
                );
                refined_matches += outcome.refined_count;
                fallback_matches += outcome.fallback_count;
                edge.inlier_matches = outcome.refined;
            }
            let reverify = match graph.reverify(&full_images, &RobustOptions::default()) {
                Ok(r) => r,
                Err(e) => {
                    set_last_error(format!("maple_pano_stitch: reverify: {e}"));
                    return -7;
                }
            };
            emit_progress(3, 1.0);

            // ── stage 4: bundle adjustment ────────────────────────────────
            emit_progress(4, 0.0);
            if is_cancelled() {
                set_last_error("maple_pano_stitch: cancelled by caller".into());
                return -7;
            }
            let mut solution = match ba::solve(
                &full_images,
                &graph,
                &BaOptions {
                    mean_budget_px: MEAN_BUDGET_PX,
                    max_budget_px: MAX_BUDGET_PX,
                    retention: retention_policy,
                    local_align: local_align_enabled,
                    ..Default::default()
                },
            ) {
                Ok(s) => s,
                Err(e) => {
                    set_last_error(format!("maple_pano_stitch: BA solve: {e}"));
                    return -7;
                }
            };
            leveling::apply(&mut solution);
            emit_progress(4, 1.0);

            // ── stage 5: composite ────────────────────────────────────────
            emit_progress(5, 0.0);
            if is_cancelled() {
                set_last_error("maple_pano_stitch: cancelled by caller".into());
                return -7;
            }
            let (kept, kept_local): (
                Vec<(PlanarImage, maple_pano::camera::Camera)>,
                Vec<Option<maple_pano::local_align::LocalCorrection>>,
            ) = frames
                .into_iter()
                .zip(&solution.cameras)
                .zip(&solution.local_corrections)
                .filter_map(|((f, cam), lc)| {
                    cam.as_ref().map(|c| ((f.image, c.clone()), lc.clone()))
                })
                .unzip();
            if kept.len() < 2 {
                set_last_error(format!(
                    "maple_pano_stitch: only {} frame(s) survived BA (drops: {:?})",
                    kept.len(),
                    solution.dropped
                ));
                return -7;
            }
            let (kept_frames, kept_cams): (Vec<_>, Vec<_>) = kept.into_iter().unzip();
            let (out_img, _comp_report) = match composite(
                &kept_frames,
                &kept_cams,
                &CompositeOptions {
                    canvas: CanvasOptions {
                        projection: ProjectionMode::Auto,
                        max_pixels: MAX_CANVAS_PX,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                &kept_local,
            ) {
                Ok(r) => r,
                Err(e) => {
                    set_last_error(format!("maple_pano_stitch: composite: {e}"));
                    return -7;
                }
            };
            emit_progress(5, 1.0);

            // ── stage 6: write PNG ────────────────────────────────────────
            emit_progress(6, 0.0);
            let out_path = std::path::Path::new(&out_png_path);
            if let Some(parent) = out_path.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        set_last_error(format!("maple_pano_stitch: create output dir: {e}"));
                        return -7;
                    }
                }
            }
            // Quantize to 16-bit unsigned (scene-linear, no sRGB encode —
            // mirrors `write_png16(path, img, srgb=false)` in pano/io.rs).
            let n = out_img.pixel_count();
            let mut data: Vec<u16> = Vec::with_capacity(n * 3);
            for i in 0..n {
                data.push((out_img.r[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
                data.push((out_img.g[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
                data.push((out_img.b[i].clamp(0.0, 1.0) * 65535.0).round() as u16);
            }
            if let Err(e) = write_frame_png(out_path, out_img.width(), out_img.height(), &data) {
                set_last_error(format!("maple_pano_stitch: write PNG: {e}"));
                return -7;
            }
            emit_progress(6, 1.0);

            // suppress unused warnings for bookkeeping values we carry
            // but don't surface through the FFI (the CLI report is not
            // returned over C ABI; caller may read the written JSON if needed).
            let _ = (
                refined_matches,
                fallback_matches,
                reverify,
                applied_opcodes,
                strategy_report,
            );
            0
        }
    }
}
