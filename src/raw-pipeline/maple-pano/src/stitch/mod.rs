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
//!
//! # Memory-bounded path (M6-D, #1248)
//!
//! When `StitchOptions::canvas_tile_rows` is `Some(n)`, the composite phase
//! uses a streaming path that keeps at most **one decoded full-resolution
//! frame** resident at a time. The gain solve runs before the pixel drop.
//! Measured peak RSS on pano_01 (21 DJI DNGs): **17.83 GB** (see
//! composite module doc and #1254 for the memory driver details).

mod io;
mod tile_stitch;
mod types;

pub use io::{interleave_planar, quantize_to_u16};
pub use tile_stitch::stitch_tile;
pub use types::{StitchError, StitchOptions, StitchOutcome, TileStitchOutcome};

use std::path::PathBuf;

use crate::ba::{self, BaOptions};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, natural_canvas_pixel_ratio, CanvasOptions, ProjectionMode};
use crate::composite::{composite, composite_tiled, CompositeOptions};
use crate::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use crate::gain::{solve_gains, GainOptions};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use crate::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::matching::{LightGlueMatcher, MatcherOptions};
use crate::models::ModelDir;
use crate::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use crate::robust::RobustOptions;
use crate::strategy::{select_strategy, Strategy};
use crate::twoview::PixelCorrespondence;

/// Strategy selection request (mirrors `maple_pano::strategy::StrategyRequest`
/// re-exported here so callers don't need two imports).
pub use crate::strategy::StrategyRequest;

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
    let priors: Vec<crate::ingest::FramePriors> = frames.iter().map(|f| f.priors.clone()).collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    let t1 = Instant::now();
    progress(1, 0.0);

    let models = ModelDir::resolve(opts.models_dir.as_deref())
        .map_err(|e| StitchError::MlUnavailable(e.to_string()))?;
    let mut detector = AlikedDetector::load(
        &models,
        DetectorOptions {
            use_coreml: opts.use_coreml,
            ..DetectorOptions::default()
        },
    )
    .map_err(|e| StitchError::MlUnavailable(format!("ALIKED load failed: {e}")))?;
    let mut matcher = LightGlueMatcher::load(
        &models,
        MatcherOptions {
            use_coreml: opts.use_coreml,
            ..Default::default()
        },
    )
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

    let local_corrections = solution.local_corrections.clone();

    let kept_meta: Vec<(usize, Camera, Option<LocalCorrection>)> = frames
        .iter()
        .enumerate()
        .zip(&solution.cameras)
        .zip(&solution.local_corrections)
        .filter_map(|(((inp_idx, _f), cam), lc)| {
            cam.as_ref().map(|c| (inp_idx, c.clone(), lc.clone()))
        })
        .collect();

    if kept_meta.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: kept_meta.len(),
            dropped: solution.dropped.clone(),
        });
    }

    let canvas_opts = CanvasOptions {
        projection: ProjectionMode::Auto,
        max_pixels: opts.max_canvas_px,
        ..Default::default()
    };

    // ── Degeneracy guard (must run BEFORE any composite allocation) ────────
    // A *connected* near-parallel / translational set forced through the
    // rotation path produces a BA solution whose spherical projection spans a
    // huge angular extent — the natural (unclamped) canvas balloons to tens or
    // hundreds of GB. The max_canvas_px cap only bites *inside* composite(),
    // after that giant buffer (and the decoded frames) are already allocated —
    // which is how a nadir set ballooned to ~317 GB (#1267). We fail fast here,
    // before any allocation, comparing the natural canvas pixel count to the cap.
    //
    // NOTE this is a *backstop*. A fully translational set whose frames don't
    // overlap rotationally (e.g. the pano_00 nadir set) disconnects in the
    // match graph and is already rejected above as TooFewSurvivors; `auto`
    // routes such sets to tile (#1271). This guard catches the remaining case:
    // frames that DO connect but whose rotation BA is degenerate enough to blow
    // up the canvas.
    //
    // Threshold — a small multiple of the cap (#1269: "a sane ceiling, a small
    // multiple of max_canvas_px"). Measured anchors: a legit 21-frame DJI
    // rotation pano (pano_01) sizes to ratio ≈ 1.08× at the 256 MP default; the
    // ~317 GB blowup back-of-envelopes to ≈ 26–103× natural. 8× sits well clear
    // of legit content yet fires before the blowup across that range. The risk
    // is asymmetric — failing fast on a borderline-large pano is recoverable
    // (raise --max-canvas-px, which lowers the ratio), but letting a degenerate
    // set through hangs the host — so we err toward the lower bound.
    const DEGENERATE_CANVAS_RATIO: f64 = 8.0;
    {
        let kept_cams_guard: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
        if let Some(ratio) = natural_canvas_pixel_ratio(&kept_cams_guard, &canvas_opts) {
            if ratio > DEGENERATE_CANVAS_RATIO {
                return Err(StitchError::DegenerateGeometry(format!(
                    "natural canvas is {ratio:.0}× larger than the {mp} MP cap — the rotation \
                     geometry is likely degenerate (near-parallel or translational frames; try \
                     Auto or Tile). If this is a genuinely large panorama, raise --max-canvas-px",
                    mp = opts.max_canvas_px / 1_000_000,
                )));
            }
        }
    }

    let (image, comp_report) = if let Some(tile_rows) = opts.canvas_tile_rows {
        // ── Memory-bounded tiled path (M6-D, #1248) ─────────────────────
        // #1254: `kept_frames_for_gain` is a full-res clone and the primary
        // memory driver of the 17.83 GB peak RSS measured on pano_01.
        let kept_cams_for_gain: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
        let kept_frames_for_gain: Vec<PlanarImage> = kept_meta
            .iter()
            .map(|(inp_idx, _, _)| frames[*inp_idx].image.clone())
            .collect();
        let gains = solve_gains(
            &kept_frames_for_gain,
            &kept_cams_for_gain,
            &GainOptions::default(),
        )
        .map_err(|e| StitchError::Composite(e.to_string()))?;
        drop(kept_frames_for_gain);
        drop(frames);

        let kept_paths: Vec<PathBuf> = kept_meta
            .iter()
            .map(|(inp_idx, _, _)| inputs[*inp_idx].clone())
            .collect();
        let kept_cams: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
        let kept_local: Vec<Option<LocalCorrection>> =
            kept_meta.iter().map(|(_, _, lc)| lc.clone()).collect();

        let canvas = auto_canvas(&kept_cams, &canvas_opts)
            .map_err(|e| StitchError::Composite(e.to_string()))?;
        composite_tiled(
            &kept_paths,
            &kept_cams,
            &gains,
            &kept_local,
            &canvas,
            tile_rows,
        )
        .map_err(|e| StitchError::Composite(e.to_string()))?
    } else {
        // ── Full all-resident path (default; backward compatible) ────────
        let (kept, kept_local): (Vec<(PlanarImage, Camera)>, Vec<Option<LocalCorrection>>) = frames
            .into_iter()
            .zip(&solution.cameras)
            .zip(&solution.local_corrections)
            .filter_map(|((f, cam), lc)| cam.as_ref().map(|c| ((f.image, c.clone()), lc.clone())))
            .unzip();
        let (kept_frames, kept_cams): (Vec<_>, Vec<_>) = kept.into_iter().unzip();
        composite(
            &kept_frames,
            &kept_cams,
            &CompositeOptions {
                canvas: canvas_opts,
                ..Default::default()
            },
            &kept_local,
        )
        .map_err(|e| StitchError::Composite(e.to_string()))?
    };
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
