//! Single shared orchestration for `maple_pano_stitch` FFI (epic #1234, M3)
//! and `maple-cli pano stitch` — the full rotation-strategy pipeline:
//!
//! decode → proxy features → match graph → strategy selection →
//! full-resolution NCC refinement → bundle adjustment → leveling →
//! composite → 16-bit PNG (written to `out_png` by callers).
//!
//! # Why here?
//!
//! `maple-cli pano/mod.rs` and `raw-ffi/src/pano_macos.rs` previously
//! each contained an inline copy of the identical stage sequence (CLAUDE.md
//! principle #4 — parity is a merge gate, not an aspiration). This module
//! is the single source of truth. Both call [`stitch`] with the same
//! options; the CLI additionally uses the returned bookkeeping fields to
//! assemble the `StitchReport` JSON (spec §6).
//!
//! # Progress callback
//!
//! The caller supplies a `FnMut(stage: u32, frac: f32)` Rust closure.
//! The FFI shim adapts its C callback into this closure (no raw pointer
//! math here — the FFI owns the C ABI, this module is pure Rust).
//!
//! Stage ordinals (same as the C ABI contract in `pano.rs`):
//! ```text
//! 0 — decode + priors
//! 1 — ML load + proxy feature extraction
//! 2 — match graph construction
//! 3 — full-resolution NCC refinement + reverification
//! 4 — bundle adjustment + leveling
//! 5 — composite
//! ```
//!
//! # Tile strategy
//!
//! The tile strategy is implemented separately in `maple-cli/src/commands/
//! pano/tile.rs` (CLI) and is not yet surfaced through the FFI (tracked as
//! the next sub-task of #1235). When `select_strategy` returns
//! `Strategy::Tile`, [`stitch`] returns
//! `Err(StitchError::TileNotSupported)`. The CLI caller falls through to its
//! tile path; the FFI returns error code −7 with a descriptive message.

use std::path::PathBuf;

use crate::ba::{self, BaOptions, BaSolution, RetentionPolicy};
use crate::camera::Camera;
use crate::canvas::{CanvasOptions, ProjectionMode};
use crate::composite::{composite, CompositeOptions, CompositeReport};
use crate::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use crate::ingest::{ingest_file, proxy_to_long_edge, FramePriors, IngestedFrame, PlanarImage};
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::matching::LightGlueMatcher;
use crate::models::ModelDir;
use crate::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use crate::robust::RobustOptions;
use crate::strategy::{select_strategy, Strategy, StrategyReport};
use crate::twoview::PixelCorrespondence;

// ─── Input options ───────────────────────────────────────────────────────────

/// All tunable parameters for a single stitch run. Callers construct this
/// with `StitchOptions::default()` and override what they need.
#[derive(Clone)]
pub struct StitchOptions {
    /// Frame-retention policy passed to the BA solver.
    pub retention: RetentionPolicy,
    /// Enable Stage-F bilinear-mesh local alignment (#1218).
    pub local_align: bool,
    /// Content-based / forced strategy selection (#1226).
    pub strategy: StrategyRequest,
    /// Spec §5.3 mean reprojection-error acceptance gate (px).
    pub mean_budget_px: f64,
    /// Spec §5.3 max reprojection-error acceptance gate (px).
    pub max_budget_px: f64,
    /// Optional explicit models directory; `None` reads `MAPLE_PANO_MODELS`.
    pub models_dir: Option<PathBuf>,
    /// Long-edge cap for the feature-extraction proxy (px).
    /// Default 1600 (CLI) / 1280 for iOS (M6-D #1244: 1280px feeds ALIKED at
    /// its native input resolution, halving proxy size vs 1600 with no quality
    /// loss). M6-D will wire the iOS default via the FFI's target_os gate.
    pub proxy_long_edge: u32,
    /// Total output canvas pixel cap (uniform downscale to fit).
    pub max_canvas_px: usize,
    // M6-C (#1244 follow-up): CoreML EP wiring for iOS. When that lands,
    // add an `execution_providers: Vec<ExecutionProvider>` field here (or a
    // bool `use_coreml: bool`) so the Apple FFI can request CoreML EP without
    // touching the CLI path. `StitchOptions::default()` should set it to
    // CPU-only (the M6-A/B baseline); M6-C enables it by default on iOS.
}

impl Default for StitchOptions {
    fn default() -> Self {
        Self {
            retention: RetentionPolicy::KeepAlignable,
            local_align: true,
            strategy: StrategyRequest::Auto,
            mean_budget_px: 1.5,
            max_budget_px: 6.0,
            models_dir: None,
            proxy_long_edge: 1600,
            max_canvas_px: 256_000_000,
        }
    }
}

/// Strategy selection request (mirrors `maple_pano::strategy::StrategyRequest`
/// re-exported here so callers don't need two imports).
pub use crate::strategy::StrategyRequest;

// ─── Output ──────────────────────────────────────────────────────────────────

/// Everything `stitch` returns on success. The composited image is the
/// primary product; all other fields are bookkeeping the CLI uses to
/// assemble the `StitchReport` JSON (spec §6). The FFI caller ignores
/// those fields.
pub struct StitchOutcome {
    /// Scene-linear Rec.2020 composite (the value the PNG/DNG writer encodes).
    pub image: PlanarImage,
    /// The compositing stage report (projection, canvas dims, gains, …).
    pub comp_report: CompositeReport,
    /// Bundle-adjustment solution (cameras, reproj stats, drops, …).
    pub solution: BaSolution,
    /// Per-frame local-alignment corrections (parallel to `solution.cameras`).
    pub local_corrections: Vec<Option<LocalCorrection>>,
    /// Strategy-selection outcome (evidence + selection + optional warning).
    pub strategy_report: StrategyReport,
    /// Decoded input frames (applied_opcodes survives frame consumption).
    pub applied_opcodes: Vec<Vec<String>>,
    /// Per-frame EXIF/gimbal priors (needed for CLI report).
    pub priors: Vec<FramePriors>,
    /// Number of full-resolution NCC-refined correspondences.
    pub refined_matches: usize,
    /// Number of correspondences that fell back to proxy accuracy.
    pub fallback_matches: usize,
    /// Summary of the full-resolution reverification (edges/matches dropped).
    pub reverify: crate::graph::ReverifySummary,
    /// Whether the BA solution was roll-leveled.
    pub leveled: bool,
    /// Horizon tilt in degrees when leveling was applied.
    pub horizon_tilt_deg: Option<f64>,
    /// Stage wall-clock timings (seconds). Indices are stage ordinals above.
    /// Entry 5 = composite; entry 6 = not used (write is the caller's job).
    pub stage_timings_s: [f64; 6],
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Errors from [`stitch`].
#[derive(Debug)]
pub enum StitchError {
    /// Fewer than 2 input paths were provided.
    TooFewFrames(usize),
    /// ML environment unavailable (models dir or ORT dylib missing).
    MlUnavailable(String),
    /// Frame decode or prior extraction failed.
    Decode { path: PathBuf, cause: String },
    /// Feature extraction failed for a frame.
    Feature { frame_idx: usize, cause: String },
    /// LightGlue matching failed on one or more pairs.
    MatchFailed(Vec<String>),
    /// Bundle adjustment failed.
    BaSolve(String),
    /// Reverification failed.
    Reverify(String),
    /// Compositing failed.
    Composite(String),
    /// Strategy returned `Tile` — the caller must route to its tile path.
    /// The strategy evidence is included so the caller can log it.
    TileNotSupported(StrategyReport),
    /// Too few frames survived bundle adjustment to composite.
    TooFewSurvivors {
        survived: usize,
        dropped: Vec<ba::DroppedFrame>,
    },
    /// No EXIF 35mm focal length available for seeding the camera model.
    NoFocal { path: PathBuf },
    /// Cancelled by the caller.
    Cancelled,
}

impl std::fmt::Display for StitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooFewFrames(n) => write!(f, "need at least 2 frames, got {n}"),
            Self::MlUnavailable(e) => write!(
                f,
                "ML environment unavailable: {e}\n\
                 Set MAPLE_PANO_MODELS to the models dir and ORT_DYLIB_PATH \
                 to libonnxruntime (>= 1.23)"
            ),
            Self::Decode { path, cause } => write!(f, "{}: {cause}", path.display()),
            Self::Feature { frame_idx, cause } => {
                write!(f, "frame {frame_idx}: feature extraction: {cause}")
            }
            Self::MatchFailed(pairs) => {
                write!(
                    f,
                    "LightGlue failed on {} pair(s): {}",
                    pairs.len(),
                    pairs.join("; ")
                )
            }
            Self::BaSolve(e) => write!(f, "BA solve: {e}"),
            Self::Reverify(e) => write!(f, "reverify: {e}"),
            Self::Composite(e) => write!(f, "composite: {e}"),
            Self::TileNotSupported(_) => write!(
                f,
                "tile strategy selected; tile FFI path not yet implemented"
            ),
            Self::TooFewSurvivors { survived, dropped } => write!(
                f,
                "only {survived} frame(s) survived BA (drops: {dropped:?})"
            ),
            Self::NoFocal { path } => write!(
                f,
                "{}: no EXIF 35mm focal length — cannot seed camera model",
                path.display()
            ),
            Self::Cancelled => write!(f, "cancelled by caller"),
        }
    }
}

// ─── Interleave helper (pub for CLI io.rs) ───────────────────────────────────

/// Interleave a planar image into the ALIKED detector's packed-RGB f32 layout.
pub fn interleave_planar(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/// Run the full rotation-strategy panorama pipeline on the given RAW frames.
///
/// `inputs` must have at least 2 elements. `progress` is called with
/// `(stage, fraction)` at each pipeline stage (see module-level ordinal
/// table). `is_cancelled` is polled between stages — return `true` to
/// abort with `StitchError::Cancelled`.
///
/// On `TileNotSupported`, the returned `StrategyReport` has the evidence
/// for the caller to log; CLI routes to its tile path, FFI returns an error.
pub fn stitch(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<StitchOutcome, StitchError> {
    use std::time::Instant;

    if inputs.len() < 2 {
        return Err(StitchError::TooFewFrames(inputs.len()));
    }

    // ── stage 0: decode + priors ──────────────────────────────────────────
    let t0 = Instant::now();
    progress(0, 0.0);
    let mut frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        frames.push(ingest_file(path).map_err(|e| StitchError::Decode {
            path: path.clone(),
            cause: e.to_string(),
        })?);
        progress(0, (i + 1) as f32 / inputs.len() as f32);
    }
    let t_decode = t0.elapsed().as_secs_f64();

    let applied_opcodes: Vec<Vec<String>> =
        frames.iter().map(|f| f.applied_opcodes.clone()).collect();
    let priors: Vec<FramePriors> = frames.iter().map(|f| f.priors.clone()).collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    let t1 = Instant::now();
    progress(1, 0.0);

    let models = ModelDir::resolve(opts.models_dir.as_deref())
        .map_err(|e| StitchError::MlUnavailable(e.to_string()))?;
    let mut detector = AlikedDetector::load(&models, DetectorOptions::default())
        .map_err(|e| StitchError::MlUnavailable(format!("ALIKED load failed: {e}")))?;
    let mut matcher = LightGlueMatcher::load(&models, Default::default())
        .map_err(|e| StitchError::MlUnavailable(format!("LightGlue load failed: {e}")))?;

    let mut feature_sets: Vec<FeatureSet> = Vec::with_capacity(frames.len());
    let mut proxy_scale: Vec<f64> = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());

    for (i, frame) in frames.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        let proxy = proxy_to_long_edge(&frame.image, opts.proxy_long_edge);
        proxy_scale.push(frame.image.width() as f64 / proxy.width() as f64);
        proxy_dims.push((proxy.width(), proxy.height()));
        let rgb = interleave_planar(&proxy);
        let lin = LinearRgbFrame::new(proxy.width(), proxy.height(), rgb).map_err(|e| {
            StitchError::Feature {
                frame_idx: i,
                cause: e.to_string(),
            }
        })?;
        let fs = detector.detect(&lin).map_err(|e| StitchError::Feature {
            frame_idx: i,
            cause: e.to_string(),
        })?;
        feature_sets.push(fs);
        progress(1, (i + 1) as f32 / frames.len() as f32);
    }
    let t_features = t1.elapsed().as_secs_f64();

    // Camera seeds (full resolution, EXIF focal in native pixels).
    let full_images: Vec<GraphImage> = frames
        .iter()
        .zip(inputs)
        .map(|(f, path)| {
            let focal_px = f
                .priors
                .focal_px
                .ok_or_else(|| StitchError::NoFocal { path: path.clone() })?;
            Ok(GraphImage {
                camera: Camera::new(
                    [0.0; 3],
                    focal_px,
                    0.0,
                    0.0,
                    f.image.width(),
                    f.image.height(),
                ),
                prior_rotation: f.priors.gimbal.as_ref().map(ba::init::rotation_from_gimbal),
            })
        })
        .collect::<Result<_, StitchError>>()?;

    let proxy_images: Vec<GraphImage> = full_images
        .iter()
        .enumerate()
        .map(|(i, img)| GraphImage {
            camera: Camera::new(
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
    let t2 = Instant::now();
    progress(2, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
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
        return Err(StitchError::MatchFailed(match_failures));
    }
    let t_graph = t2.elapsed().as_secs_f64();
    progress(2, 1.0);

    // ── strategy selection (runs on proxy graph, before full-res reverify) ─
    let mean_focal_px = {
        let vals: Vec<f64> = full_images.iter().map(|img| img.camera.focal_px).collect();
        if vals.is_empty() {
            1.0
        } else {
            vals.iter().sum::<f64>() / vals.len() as f64
        }
    };
    let strategy_report = select_strategy(
        opts.strategy,
        &graph,
        &priors,
        mean_focal_px,
        0x1226_cafe_dead_beef,
    );

    if strategy_report.selected == Strategy::Tile {
        return Err(StitchError::TileNotSupported(strategy_report));
    }

    // ── stage 3: full-resolution NCC refinement + reverification ──────────
    let t3 = Instant::now();
    progress(3, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
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
    let reverify = graph
        .reverify(&full_images, &RobustOptions::default())
        .map_err(|e| StitchError::Reverify(e.to_string()))?;
    let t_refine = t3.elapsed().as_secs_f64();
    progress(3, 1.0);

    // ── stage 4: bundle adjustment + leveling ─────────────────────────────
    let t4 = Instant::now();
    progress(4, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let mut solution = ba::solve(
        &full_images,
        &graph,
        &BaOptions {
            mean_budget_px: opts.mean_budget_px,
            max_budget_px: opts.max_budget_px,
            retention: opts.retention,
            local_align: opts.local_align,
            ..Default::default()
        },
    )
    .map_err(|e| StitchError::BaSolve(e.to_string()))?;
    let leveled = leveling::apply(&mut solution);
    let horizon_tilt_deg = leveled.then(|| leveling::horizon_tilt_deg(&solution));
    let t_solve = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    // ── stage 5: composite ─────────────────────────────────────────────────
    let t5 = Instant::now();
    progress(5, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }

    // Pull local_corrections out BEFORE consuming frames (the solution's
    // local_corrections are parallel to the input frame list).
    let local_corrections = solution.local_corrections.clone();

    let (kept, kept_local): (Vec<(PlanarImage, Camera)>, Vec<Option<LocalCorrection>>) = frames
        .into_iter()
        .zip(&solution.cameras)
        .zip(&solution.local_corrections)
        .filter_map(|((f, cam), lc)| cam.as_ref().map(|c| ((f.image, c.clone()), lc.clone())))
        .unzip();

    if kept.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: kept.len(),
            dropped: solution.dropped.clone(),
        });
    }

    let (kept_frames, kept_cams): (Vec<_>, Vec<_>) = kept.into_iter().unzip();
    let (image, comp_report) = composite(
        &kept_frames,
        &kept_cams,
        &CompositeOptions {
            canvas: CanvasOptions {
                projection: ProjectionMode::Auto,
                max_pixels: opts.max_canvas_px,
                ..Default::default()
            },
            ..Default::default()
        },
        &kept_local,
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;
    let t_composite = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    Ok(StitchOutcome {
        image,
        comp_report,
        solution,
        local_corrections,
        strategy_report,
        applied_opcodes,
        priors,
        refined_matches,
        fallback_matches,
        reverify,
        leveled,
        horizon_tilt_deg,
        stage_timings_s: [
            t_decode,
            t_features,
            t_graph,
            t_refine,
            t_solve,
            t_composite,
        ],
    })
}

// ─── Shared 16-bit PNG quantizer (pub for callers) ────────────────────────────

/// Quantize the scene-linear composite to a 16-bit packed RGB buffer
/// (row-major, R/G/B interleaved). Values are clamped to [0, 1].
/// Optionally applies IEC 61966 sRGB transfer for an eyeball-able preview.
pub fn quantize_to_u16(img: &PlanarImage, srgb: bool) -> Vec<u16> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    data
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
