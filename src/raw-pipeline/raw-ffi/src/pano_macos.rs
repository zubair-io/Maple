//! macOS stitch implementation for `maple_pano_stitch` (M3 of #1234, #1235).
//!
//! Split from `pano.rs` per the 600-LOC per-file budget. This module is
//! `#[cfg(target_os = "macos")]` only — it is entirely absent from the
//! iOS / iOS-sim compilation units. See `pano.rs` for the entry point,
//! ABI types, and the iOS stub that returns error −3.

use crate::cancel::{token_from_ptr, SendCancelPtr};
use crate::error::set_last_error;

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use maple_pano::ba::{self, BaOptions, RetentionPolicy};
use maple_pano::canvas::{CanvasOptions, ProjectionMode};
use maple_pano::composite::{composite, CompositeOptions};
use maple_pano::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use maple_pano::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
use maple_pano::leveling;
use maple_pano::matching::LightGlueMatcher;
use maple_pano::models::ModelDir;
use maple_pano::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use maple_pano::render::write_frame_png;
use maple_pano::robust::RobustOptions;
use maple_pano::strategy::{select_strategy, Strategy, StrategyRequest};
use maple_pano::twoview::PixelCorrespondence;

use super::{MaplePanoLocalAlign, MaplePanoRetention, MaplePanoStrategy};

/// Default proxy long-edge (mirrors CLI default: 1600 px).
const PROXY_LONG_EDGE: u32 = 1600;
/// Default canvas pixel cap (matches CLI: 256 M px).
const MAX_CANVAS_PX: usize = 256_000_000;
/// Spec §5.3 mean reprojection budget (px).
const MEAN_BUDGET_PX: f64 = 1.5;
/// Spec §5.3 max reprojection budget (px).
const MAX_BUDGET_PX: f64 = 6.0;

/// Full macOS stitch pipeline. Called by `maple_pano_stitch` after argument
/// validation; runs on a large-stack worker thread (see `with_large_stack`
/// in the caller). Returns 0 on success, negative on failure (last_error set).
pub(super) fn run_stitch_macos(
    input_paths: Vec<String>,
    out_png_path: String,
    retention: MaplePanoRetention,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    cb_fn_usize: usize,
    cb_user_usize: usize,
    send_cancel: SendCancelPtr,
) -> i32 {
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
        // SAFETY: the pointer is from maple_cancel_flag_new; the host guarantees
        // it outlives this synchronous call.
        if let Some(atomic_ptr) = unsafe { token_from_ptr(send_cancel.0) } {
            unsafe { atomic_ptr.as_ref() }.load(Ordering::Relaxed)
        } else {
            false
        }
    };

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
        // Full tile FFI support is tracked as the next sub-task of #1235.
        // The CLI tile path is unaffected.
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
        Strategy::Rotation => rotation_stitch(
            frames,
            &full_images,
            &proxy_dims,
            &mut graph,
            retention_policy,
            local_align_enabled,
            out_png_path,
            applied_opcodes,
            strategy_report,
            emit_progress,
            is_cancelled,
        ),
    }
}

/// The rotation-strategy stitch path (stage 3 through 6). Extracted so the
/// `match` arm above stays readable and `run_stitch_macos` stays within
/// the 600-LOC budget split.
#[allow(clippy::too_many_arguments)]
fn rotation_stitch(
    frames: Vec<IngestedFrame>,
    full_images: &[GraphImage],
    proxy_dims: &[(u32, u32)],
    graph: &mut maple_pano::graph::MatchGraph,
    retention_policy: RetentionPolicy,
    local_align_enabled: bool,
    out_png_path: String,
    applied_opcodes: Vec<Vec<String>>,
    strategy_report: maple_pano::strategy::StrategyReport,
    emit_progress: impl Fn(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> i32 {
    // ── stage 3: full-resolution NCC refinement + reverification ──────────
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
    let reverify = match graph.reverify(full_images, &RobustOptions::default()) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(format!("maple_pano_stitch: reverify: {e}"));
            return -7;
        }
    };
    emit_progress(3, 1.0);

    // ── stage 4: bundle adjustment ─────────────────────────────────────────
    emit_progress(4, 0.0);
    if is_cancelled() {
        set_last_error("maple_pano_stitch: cancelled by caller".into());
        return -7;
    }
    let mut solution = match ba::solve(
        full_images,
        graph,
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

    // ── stage 5: composite ─────────────────────────────────────────────────
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
        .filter_map(|((f, cam), lc)| cam.as_ref().map(|c| ((f.image, c.clone()), lc.clone())))
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

    // ── stage 6: write PNG (scene-linear 16-bit) ───────────────────────────
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
    // Quantize to 16-bit (scene-linear, no sRGB — mirrors
    // `write_png16(path, img, srgb=false)` in maple-cli pano/io.rs).
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

    // Suppress unused-variable warnings for bookkeeping values we track but
    // don't surface through the C ABI (CLI JSON report not returned here).
    let _ = (
        refined_matches,
        fallback_matches,
        reverify,
        applied_opcodes,
        strategy_report,
    );
    0
}
