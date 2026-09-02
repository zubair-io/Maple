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
//! # Tile strategy (#1270)
//!
//! When `select_strategy` returns `Strategy::Tile`, [`stitch`] hands off to
//! [`tile_stitch::run_tile_branch`] after completing stages 0–2. The
//! early-stage state (decode-proxy + ALIKED + LightGlue + match graph) is
//! shared; only the tail (stages 3–5) differs between the two paths. This
//! eliminates the previous double-decode + double-ML pattern.
//!
//! [`stitch`] returns `Result<StitchSuccess, StitchError>` where
//! `StitchSuccess::Rotation(outcome)` or `StitchSuccess::Tile(outcome)`
//! tells the caller which strategy ran. The `TileNotSupported` error variant
//! was removed in the #1270 refactor — it is no longer part of `StitchError`.
//!
//! # Memory-bounded path (#1254)
//!
//! **Stage 0** decodes each frame once to produce the long-edge-capped proxy
//! and priors, then immediately frees the full-resolution pixel buffer via
//! [`crate::ingest::ingest_file_proxy`].  Only the proxy planes and lightweight
//! metadata (`FrameMeta`) are held resident between stages.
//!
//! **Stage 3 (refinement)** uses a 2-entry LRU decode cache: each edge's pair
//! of full-resolution frames is decoded on demand and evicted when no longer
//! referenced by the next edge.  At most 2 full-resolution frames are resident
//! at once during this stage.
//!
//! **Gain solve** (just before composite): surviving frames are decoded
//! on demand one at a time, their overlap statistics accumulated, and the pixel
//! buffer freed before the next frame is decoded — so at most 1 full-resolution
//! frame is resident during the gain phase.
//!
//! **Stage 5 (composite)**: always uses the tiled path (`composite_tiled`),
//! which decodes each source frame on demand per tile strip and frees it before
//! moving to the next. The `canvas_tile_rows` option controls strip height.
//! When `canvas_tile_rows` is `None`, a default of 512 rows is used so the
//! tiled path always engages on the rotation-strategy path.
//!
//! End-to-end on pano_01 (21 DJI DNGs): the **frame-processing** peak RSS
//! drops from ~34 GB → ~4.9 GB (measured).  End-to-end peak is ~13.6 GB,
//! dominated by the ~8.7 GiB ONNX Runtime resident floor (tracked: #1275).
//! The <4 GB target is an iOS-only goal (tracked: #1274) that requires
//! ORT model pruning or on-demand ORT teardown.

mod focal_bootstrap;
mod frame_cache;
mod io;
mod tile_standalone;
mod tile_stitch;
mod types;

pub use focal_bootstrap::FocalSeedSource;
pub use io::{develop_for_display, interleave_planar, quantize_to_u16, write_display_sidecars};
pub use tile_standalone::stitch_tile;
pub use types::{StitchError, StitchOptions, StitchOutcome, StitchSuccess, TileStitchOutcome};

use std::path::PathBuf;

use crate::ba::{self, BaOptions};
use crate::camera::Camera;
use crate::canvas::{
    auto_canvas, natural_canvas_pixel_ratio, CanvasOptions, ProjectionMode, DEGENERATE_CANVAS_RATIO,
};
use crate::composite::composite_tiled;
use crate::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use crate::gain::{solve_gains_streaming, GainOptions};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{
    build_match_graph, CaptureOrderProvider, DescriptorTopKProvider, GimbalPriorProvider,
    GraphImage,
};
use crate::ingest::{ingest_file_proxy, FrameMeta};

use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::matching::{LightGlueMatcher, MatcherOptions};
use crate::models::ModelDir;
use crate::robust::RobustOptions;
use crate::strategy::{select_strategy, Strategy};
use crate::twoview::PixelCorrespondence;
use frame_cache::refine_edges_lru;
use tile_stitch::{run_tile_branch, TileBranchInput};

/// Strategy selection request (mirrors `maple_pano::strategy::StrategyRequest`
/// re-exported here so callers don't need two imports).
pub use crate::strategy::StrategyRequest;

// ─── Main entry point ─────────────────────────────────────────────────────────

/// Run the shared panorama pipeline on the given RAW frames, branching to the
/// rotation or tile tail based on strategy selection.
///
/// `inputs` must have at least 2 elements. `progress` is called with
/// `(stage, fraction)` at each pipeline stage (see module-level ordinal
/// table). `is_cancelled` is polled between stages — return `true` to
/// abort with `StitchError::Cancelled`.
///
/// Stages 0–2 (decode-proxy + ALIKED + LightGlue + match graph) run once
/// for every call regardless of the selected strategy. Stage 3 onwards
/// branches:
/// - **Rotation** → NCC refinement → BA → leveling → equirect composite;
///   returns `Ok(StitchSuccess::Rotation(_))`.
/// - **Tile** → NCC refinement → planar placement → planar composite;
///   returns `Ok(StitchSuccess::Tile(_))`.
///
/// On success the return value is either `Ok(StitchSuccess::Rotation(_))` or
/// `Ok(StitchSuccess::Tile(_))` depending on which strategy was selected.
/// `StitchError::TileNotSupported` no longer exists — callers that previously
/// caught it to drive a second `stitch_tile` call should consume
/// `StitchSuccess::Tile` directly.
pub fn stitch(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<StitchSuccess, StitchError> {
    use std::time::Instant;

    if inputs.len() < 2 {
        return Err(StitchError::TooFewFrames(inputs.len()));
    }

    // ── stage 0: decode proxy + priors (full-res freed immediately) ───────
    //
    // #1254: each frame is decoded once here to produce the long-edge proxy
    // and priors.  `ingest_file_proxy` allocates the full-res buffer
    // internally for the downscale, then drops it before returning — only
    // the lightweight `FrameMeta` (proxy planes + metadata) survives.
    let t0 = Instant::now();
    progress(0, 0.0);
    let mut metas: Vec<FrameMeta> = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        metas.push(ingest_file_proxy(path, opts.proxy_long_edge).map_err(|e| {
            StitchError::Decode {
                path: path.clone(),
                cause: e.to_string(),
            }
        })?);
        progress(0, (i + 1) as f32 / inputs.len() as f32);
    }
    let t_decode = t0.elapsed().as_secs_f64();

    let applied_opcodes: Vec<Vec<String>> =
        metas.iter().map(|m| m.applied_opcodes.clone()).collect();
    let priors: Vec<crate::ingest::FramePriors> = metas.iter().map(|m| m.priors.clone()).collect();

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

    let mut feature_sets: Vec<FeatureSet> = Vec::with_capacity(metas.len());
    // proxy_scale and proxy_dims are now stored in FrameMeta.
    let proxy_dims: Vec<(u32, u32)> = metas
        .iter()
        .map(|m| (m.proxy.width(), m.proxy.height()))
        .collect();

    for (i, meta) in metas.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        // Proxy was already computed in stage 0; re-use it directly.
        let rgb = interleave_planar(&meta.proxy);
        let lin =
            LinearRgbFrame::new(meta.proxy.width(), meta.proxy.height(), rgb).map_err(|e| {
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
        progress(1, (i + 1) as f32 / metas.len() as f32);
    }
    drop(detector); // #3197: ALIKED done — free its ONNX session before stages 3–5
    let t_features = t1.elapsed().as_secs_f64();

    // Per-frame x and y proxy→full-res scale factors (stored in FrameMeta).
    let proxy_scale: Vec<(f64, f64)> = metas
        .iter()
        .map(|m| (m.proxy_scale_x, m.proxy_scale_y))
        .collect();

    // Camera seeds (spec §5.3): EXIF focal when any frame has one (the
    // shared median fills gaps), else an assumed-FOV bootstrap (#1214)
    // good enough to verify a graph — self-calibrated below from that graph.
    let mut focal_seed = focal_bootstrap::seed_from_priors(&metas);
    let (mut full_images, mut proxy_images) =
        focal_bootstrap::build_graph_images(&metas, &focal_seed.full_px, &proxy_dims, &proxy_scale);

    // ── stage 2: match graph ──────────────────────────────────────────────
    //
    // Raw LightGlue matches are cached keyed by `(a, b)` so that if the tile
    // branch needs to re-build the graph with unit-focal cameras, it can
    // re-use the ONNX output without running inference a second time (#1270).
    // The cache is a `Vec` indexed by the deterministic candidate order
    // (ascending `(a, b)`) — pairs not in the candidate set are never
    // requested twice, so a simple `Vec<((usize,usize), Vec<_>)>` is enough.
    let t2 = Instant::now();
    progress(2, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let mut match_failures: Vec<String> = Vec::new();
    // `raw_matches_cache[i] = ((a, b), correspondences)` in the order
    // `build_match_graph` requests them (deterministic from candidate sort).
    let mut raw_matches_cache: Vec<((usize, usize), Vec<PixelCorrespondence>)> = Vec::new();
    // §5.2(c) / #1215: content-based nomination for unordered / metadata-free
    // input, where capture order is meaningless and no gimbal prior exists.
    // Additive only — verification still decides, so it costs nothing on a
    // well-ordered/metadata-rich set beyond a few redundant candidate checks.
    let descriptor_topk = DescriptorTopKProvider::new(&feature_sets);
    let mut graph = build_match_graph(
        &proxy_images,
        &[
            &CaptureOrderProvider,
            &GimbalPriorProvider::default(),
            &descriptor_topk,
        ],
        |a, b| -> Vec<PixelCorrespondence> {
            let corrs = match matcher.match_features(&feature_sets[a], &feature_sets[b]) {
                Ok(ml_matches) => ml_matches_to_correspondences(&ml_matches, DEFAULT_MIN_SCORE),
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            };
            raw_matches_cache.push(((a, b), corrs.clone()));
            corrs
        },
        &RobustOptions::default(),
    );
    if !match_failures.is_empty() {
        return Err(StitchError::MatchFailed(match_failures));
    }

    // ── homography-fallback refinement (#1214) ──────────────────────────────
    // Replace the assumed-FOV bootstrap with the self-calibrated focal and
    // rebuild the graph every downstream stage reads; a live-matcher failure
    // on a pair the bootstrap never requested is a real `MatchFailed`.
    focal_bootstrap::refine_if_needed(
        &mut focal_seed,
        &metas,
        &proxy_dims,
        &proxy_scale,
        &mut graph,
        &mut full_images,
        &mut proxy_images,
        &mut raw_matches_cache,
        |a, b| {
            matcher
                .match_features(&feature_sets[a], &feature_sets[b])
                .map(|ml| ml_matches_to_correspondences(&ml, DEFAULT_MIN_SCORE))
                .map_err(|e| e.to_string())
        },
    )?;
    drop(matcher); // #3197: LightGlue done too — same reasoning as above
    drop(models);
    // Timed after refinement, not just the bootstrap build, so the stage
    // duration covers any fallback rebuild work too.
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

    // ── tile branch: hand off to run_tile_branch (tile_stitch.rs) ──────────
    //
    // #1270: Previously `stitch` returned `Err(TileNotSupported)` here and
    // callers re-ran the full pipeline via `stitch_tile`. Now the shared
    // ALIKED + LightGlue results (stage 1) are re-used directly via
    // `run_tile_branch`, which re-builds the graph with unit-focal cameras
    // (using cached raw matches — no ONNX call) and then runs the tile tail.
    //
    // Cost vs before: ALIKED × N once (saved); LightGlue × edges once
    // (saved); re-verification (CPU-only RANSAC) × edges once (cheap, ~ms).
    if strategy_report.selected == Strategy::Tile {
        let tile_outcome = run_tile_branch(
            TileBranchInput {
                inputs,
                opts,
                raw_matches_cache,
                full_dims: metas
                    .iter()
                    .map(|m| (m.full_width, m.full_height))
                    .collect(), // #3197: free reuse
                proxy_dims,
                feature_sets,
                strategy_report,
                focal_seed_source: focal_seed.source,
                stage_timings_012: [t_decode, t_features, t_graph],
                applied_opcodes,
                priors,
            },
            &mut progress,
            &is_cancelled,
        )?;
        return Ok(StitchSuccess::Tile(tile_outcome));
    }

    // ── stage 3: full-resolution NCC refinement + reverification ──────────
    //
    // #1254: 2-entry LRU decode cache — at most 2 full-resolution frames are
    // live simultaneously. The loop is factored into `frame_cache::refine_edges_lru`
    // to keep this file under the 600-LOC budget.
    let t3 = Instant::now();
    progress(3, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let refine_result = refine_edges_lru(&mut graph, inputs, &metas, &full_images, |frac| {
        progress(3, frac)
    })?;
    let (refined_matches, fallback_matches) = (
        refine_result.refined_matches,
        refine_result.fallback_matches,
    );

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

    let kept_meta: Vec<(usize, Camera, Option<LocalCorrection>)> = metas
        .iter()
        .enumerate()
        .zip(&solution.cameras)
        .zip(&solution.local_corrections)
        .filter_map(|(((inp_idx, _m), cam), lc)| {
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
    // Threshold = `DEGENERATE_CANVAS_RATIO`, a small multiple of the cap
    // (#1269: "a sane ceiling, a small multiple of max_canvas_px"). It is
    // single-sourced in `crate::canvas` so this guard and its unit tests can't
    // drift; see there for the measured anchors behind the value.
    {
        let kept_cams_guard: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
        if let Some(ratio) = natural_canvas_pixel_ratio(&kept_cams_guard, &canvas_opts) {
            if ratio > DEGENERATE_CANVAS_RATIO {
                // Tailor the hint to how we ended up here.
                // - Auto chose rotation: the content-based vote said rotation, but
                //   the BA geometry is still degenerate.  The frames likely share
                //   only a thin sliver of overlap or the matched region is mostly
                //   planar — suggest Tile or recapture with more overlap.
                // - User forced --strategy rotation: the set may not be a rotation
                //   pano at all; suggest Auto or Tile.
                let hint = match strategy_report.requested {
                    StrategyRequest::Auto => {
                        "Auto selected Rotation, but the solved geometry is degenerate — \
                         the frames may not form a true rotation panorama, or overlap is too \
                         narrow for a reliable rotation solve. Try --strategy Tile, or \
                         recapture with more overlap between frames."
                    }
                    _ => "try --strategy Auto or --strategy Tile",
                };
                return Err(StitchError::DegenerateGeometry(format!(
                    "natural canvas is {ratio:.0}× larger than the {mp} MP cap — \
                     the rotation geometry is likely degenerate (near-parallel or \
                     translational frames). {hint} \
                     If this is a genuinely large panorama, raise --max-canvas-px.",
                    mp = opts.max_canvas_px as f64 / 1_000_000.0,
                )));
            }
        }
    }

    // ── Gain solve: decode surviving frames on-demand, one at a time ───────
    //
    // #1254: the previous code cloned all surviving full-res frames into
    // `kept_frames_for_gain` — the dominant ~18 GB memory driver on pano_01.
    // Instead we decode each surviving frame, accumulate its overlap stats
    // into a partial-stats table, then drop the pixels before decoding the
    // next frame.  At most 1 full-resolution frame is resident at a time.
    //
    // `solve_gains` needs simultaneous access to all frames for its pairwise
    // sampling.  We instead call the streaming helper `solve_gains_streaming`
    // which accumulates overlap statistics frame-by-frame.
    let kept_paths: Vec<PathBuf> = kept_meta
        .iter()
        .map(|(inp_idx, _, _)| inputs[*inp_idx].clone())
        .collect();
    let kept_cams: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
    let kept_local: Vec<Option<LocalCorrection>> =
        kept_meta.iter().map(|(_, _, lc)| lc.clone()).collect();

    let canvas =
        auto_canvas(&kept_cams, &canvas_opts).map_err(|e| StitchError::Composite(e.to_string()))?;

    // Solve gains by decoding frames one at a time.
    // We use the streaming gain solve that accepts frames individually.
    let gains = solve_gains_streaming(&kept_paths, &kept_cams, &GainOptions::default())
        .map_err(|e| StitchError::Composite(e.to_string()))?;

    // ── Tiled composite (always engaged on this path — #1254) ─────────────
    //
    // `canvas_tile_rows` controls the strip height; when `None` we default
    // to 512 rows so the tiled path (and its memory bound of ≤1 full-res
    // frame resident per strip pass) always engages.
    let tile_rows = opts.canvas_tile_rows.unwrap_or(512);
    let (image, comp_report) = composite_tiled(
        &kept_paths,
        &kept_cams,
        &gains,
        &kept_local,
        &canvas,
        tile_rows,
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;

    let t_composite = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    Ok(StitchSuccess::Rotation(StitchOutcome {
        image,
        comp_report,
        solution,
        local_corrections,
        strategy_report,
        focal_seed_source: focal_seed.source,
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
    }))
}
