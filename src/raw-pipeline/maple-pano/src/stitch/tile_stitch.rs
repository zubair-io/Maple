//! Tile-strategy orchestration, lifted from `maple-cli` so it can be
//! consumed by the Apple FFI and any other caller (spec §8, ticket #1226).
//!
//! This is the planar/flat stitching path for nadir and translational sets
//! (film scans, flatbed tiles, strip mapping). After the strategy-selection
//! refactor (#1270) this module has two entry points:
//!
//! - [`stitch_tile`]: the full stand-alone tile pipeline (stages 0–5). Used
//!   for testing and any caller that wants a self-contained tile entry point.
//!   It runs its own decode + ML + match graph, then calls [`tile_tail`].
//!
//! - [`tile_tail`]: the tile-specific tail (stages 3–5: NCC refine +
//!   placement solve + composite). Called by [`super::stitch`] when
//!   strategy selection returns `Tile`, re-using the already-computed
//!   early-stage state (metas, feature sets, match graph) so the expensive
//!   ALIKED + LightGlue inference runs exactly once per stitch call (#1270).
//!
//! # Stage ordinals (progress callback)
//!
//! ```text
//! 0 — decode + priors
//! 1 — ML load + proxy feature extraction
//! 2 — match graph construction
//! 3 — full-resolution NCC refinement (no rotation reverification)
//! 4 — tile placement solve + edge verification
//! 5 — composite
//! ```
//!
//! # No I/O
//!
//! Neither function writes PNGs or JSON reports. The caller
//! (CLI or FFI) owns all output I/O so that the crate stays I/O-free.

use std::collections::HashSet;
use std::path::PathBuf;

use crate::camera::Camera;
use crate::features::{AlikedDetector, DetectorOptions, FeatureSet, LinearRgbFrame};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{
    build_match_graph, CaptureOrderProvider, DescriptorTopKProvider, GimbalPriorProvider,
    GraphImage, MatchGraph, ReverifySummary,
};
use crate::ingest::{ingest_file, proxy_to_long_edge, FramePriors, IngestedFrame, PlanarImage};
use crate::matching::{LightGlueMatcher, MatcherOptions};
use crate::models::ModelDir;
use crate::refine::{refine_correspondences, RefineOptions};
use crate::robust::RobustOptions;
use crate::stitch::interleave_planar;
use crate::strategy::StrategyReport;
use crate::tile::placement::{solve_tile_poses, TileConstraint};
use crate::tile::{composite_tile, verify_tile_edges};
use crate::twoview::PixelCorrespondence;

use super::types::{StitchError, StitchOptions, TileStitchOutcome};

// ─── Shared early-stage state ─────────────────────────────────────────────────

/// Early-stage state (stages 0–2) passed to [`tile_tail`] by [`super::stitch`].
///
/// Fields are ordered by how they are produced during the shared pipeline:
/// stage-0 meta → stage-1 features + proxy dims → stage-2 match graph.
pub(super) struct TileEarlyState<'a> {
    /// Ingested full-resolution frames; the tile refine step reads pixels here.
    pub frames: Vec<IngestedFrame>,
    /// Per-frame proxy dimensions `(width, height)`.
    pub proxy_dims: Vec<(u32, u32)>,
    /// Feature sets extracted by ALIKED (kept here for the struct but not read
    /// by `tile_tail` — the graph's match closure already consumed them during
    /// `build_match_graph`; they are stored so the caller can forward them if
    /// a future stage needs re-matching without re-running ALIKED).
    pub _feature_sets: Vec<FeatureSet>,
    /// The proxy-resolution match graph (verified edges).
    pub graph: MatchGraph,
    /// Strategy-selection report (evidence + selected strategy + warning).
    pub strategy_report: StrategyReport,
    /// Which source produced the shared camera focal seed. `None` only
    /// for the standalone [`stitch_tile`] entry point, which never
    /// resolves a real per-frame focal (always unit-focal — see
    /// `run_tile_branch`'s doc comment).
    pub focal_seed_source: Option<super::FocalSeedSource>,
    /// Wall-clock times for stages 0, 1, 2 (seconds).
    pub stage_timings_012: [f64; 3],
    /// Path list parallel to `frames` (for the stitch report).
    pub _inputs: &'a [PathBuf],
}

// ─── Tile branch helper called from stitch() ─────────────────────────────────

/// State passed from `stitch()` into the tile branch.
///
/// Contains everything `stitch()` computed in stages 0–2 that the tile
/// branch needs, plus the raw LightGlue match cache so the graph can be
/// re-built with unit-focal cameras without re-running ONNX inference.
pub(super) struct TileBranchInput<'a> {
    /// Paths of the input files (used for on-demand full-res decode).
    pub inputs: &'a [std::path::PathBuf],
    /// Options forwarded from the `stitch()` caller.
    pub opts: &'a super::types::StitchOptions,
    /// Raw LightGlue correspondences keyed by `(a, b)` in candidate order.
    pub raw_matches_cache: Vec<((usize, usize), Vec<PixelCorrespondence>)>,
    /// Per-frame proxy dimensions `(width, height)` from stage 0.
    pub proxy_dims: Vec<(u32, u32)>,
    /// Feature sets from stage 1 (kept for future re-matching without ALIKED).
    pub feature_sets: Vec<FeatureSet>,
    /// Strategy report (evidence + selected strategy + warning).
    pub strategy_report: StrategyReport,
    /// Which source produced the shared camera focal seed — EXIF, or the
    /// homography self-calibration fallback (spec §5.3, ticket #1214).
    /// Computed in `stitch()` before strategy selection, so it's known
    /// regardless of which strategy ultimately ran.
    pub focal_seed_source: super::FocalSeedSource,
    /// Stage 0–2 wall-clock timings (decode, features, match_graph).
    pub stage_timings_012: [f64; 3],
    /// Per-frame opcode lists from stage 0.
    pub applied_opcodes: Vec<Vec<String>>,
    /// Per-frame EXIF/gimbal priors from stage 0.
    pub priors: Vec<crate::ingest::FramePriors>,
}

/// Run the tile branch from inside `stitch()` (#1270).
///
/// `stitch()` calls this when `select_strategy` returns `Tile`.  The raw
/// LightGlue matches from stage 2 are re-used verbatim; only the geometric
/// verification is re-run with unit-focal cameras (no ONNX call).
///
/// Returns a `TileStitchOutcome` ready for `StitchSuccess::Tile`.
pub(super) fn run_tile_branch(
    input: TileBranchInput<'_>,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<TileStitchOutcome, super::types::StitchError> {
    use super::types::StitchError;

    let TileBranchInput {
        inputs,
        opts,
        raw_matches_cache,
        proxy_dims,
        feature_sets,
        strategy_report,
        focal_seed_source,
        stage_timings_012,
        applied_opcodes,
        priors,
    } = input;

    // Build unit-focal proxy cameras (same as stitch_tile does).  The tile
    // path uses pixel correspondences directly; it doesn't need real focal.
    let unit_proxy_images: Vec<GraphImage> = proxy_dims
        .iter()
        .map(|&(w, h)| GraphImage {
            camera: Camera::new([0.0; 3], 1.0, 0.0, 0.0, w, h),
            prior_rotation: None,
        })
        .collect();

    // Re-build the match graph using cached LightGlue matches + unit focal
    // cameras so the rotation verifier (σ_max_rad at unit focal is very large)
    // passes through the translational correspondences, exactly replicating
    // what stitch_tile produces and making the tile output byte-identical to
    // the pre-#1270 behavior.
    //
    // Key-based lookup: the rotation graph (EXIF focal, with gimbal priors)
    // may have generated MORE candidate pairs than the unit-focal graph
    // (no priors → GimbalPriorProvider produces no pairs).  A sequential
    // cache iterator would mis-assign cached matches if the pair sets differ.
    // Instead we index the cache by `(a, b)` and look up each pair by key.
    use std::collections::HashMap;
    let match_cache_map: HashMap<(usize, usize), Vec<PixelCorrespondence>> =
        raw_matches_cache.into_iter().collect();
    let mut tile_match_failures: Vec<String> = Vec::new();
    // #1215: descriptor top-k is focal-independent (reads only
    // `feature_sets`, never the camera), so it nominates the exact same
    // pairs here as it did in the rotation-graph build above — every one
    // of those pairs is already in `match_cache_map`, so including it
    // here costs no new cache misses while keeping the tile path's
    // candidate topology consistent with the rotation path's.
    let descriptor_topk = DescriptorTopKProvider::new(&feature_sets);
    let tile_graph = build_match_graph(
        &unit_proxy_images,
        &[
            &CaptureOrderProvider,
            &GimbalPriorProvider::default(),
            &descriptor_topk,
        ],
        |a, b| -> Vec<PixelCorrespondence> {
            match match_cache_map.get(&(a, b)) {
                Some(cached) => cached.clone(),
                None => {
                    // This pair was requested by the unit-focal graph but was
                    // absent from the rotation graph's candidate set (which used
                    // EXIF focal + gimbal priors, so it may have generated a
                    // *different* candidate set). We do NOT re-run LightGlue
                    // inference here — the matcher and models are no longer
                    // available in this scope. Instead we record a failure and
                    // return an empty correspondence list; the graph will drop
                    // this edge, and `tile_match_failures` will cause
                    // `run_tile_branch` to propagate `StitchError::MatchFailed`.
                    tile_match_failures.push(format!(
                        "tile re-verify: pair ({a},{b}) not in rotation match cache — \
                         the unit-focal candidate set requested a pair the EXIF-focal \
                         graph did not generate; stitching cannot proceed"
                    ));
                    Vec::new()
                }
            }
        },
        &RobustOptions::default(),
    );
    if !tile_match_failures.is_empty() {
        return Err(StitchError::MatchFailed(tile_match_failures));
    }

    // Decode full-res frames for NCC refinement.  This is the first work of
    // the tile tail (stage 3), which runs *after* stages 0–2 completed in
    // `stitch()`.  Report progress on ordinal 3 so callers see a monotonically
    // increasing stage number (0→1→2→3→4→5) and the fraction does not appear
    // to go backwards.
    // For pano_00 (3 frames, ~130 MP total) this is ~3 GB transient RSS;
    // the rotation path avoids this via the 2-entry LRU cache (#1254).
    progress(3, 0.0);
    let mut tile_frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        tile_frames.push(ingest_file(path).map_err(|e| StitchError::Decode {
            path: path.clone(),
            cause: e.to_string(),
        })?);
        progress(3, (i + 1) as f32 / inputs.len() as f32);
    }

    tile_tail(
        TileEarlyState {
            frames: tile_frames,
            proxy_dims,
            _feature_sets: feature_sets,
            graph: tile_graph,
            strategy_report,
            focal_seed_source: Some(focal_seed_source),
            stage_timings_012,
            _inputs: inputs,
        },
        opts,
        applied_opcodes,
        priors,
        progress,
        is_cancelled,
    )
}

// ─── Tile tail (stages 3–5) ───────────────────────────────────────────────────

/// Run the tile-specific tail (NCC refinement → placement solve → composite)
/// using already-computed early-stage state.
///
/// Called by [`super::stitch`] when `select_strategy` returns `Tile` — the
/// shared ALIKED + LightGlue inference and match graph from stages 0–2 are
/// re-used directly, so no re-decode or re-inference happens (#1270).
///
/// Also called by [`stitch_tile`] after it builds its own early state.
pub(super) fn tile_tail(
    state: TileEarlyState<'_>,
    opts: &StitchOptions,
    applied_opcodes: Vec<Vec<String>>,
    priors: Vec<FramePriors>,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<TileStitchOutcome, StitchError> {
    use std::time::Instant;

    let TileEarlyState {
        frames,
        proxy_dims,
        _feature_sets: _,
        mut graph,
        strategy_report,
        focal_seed_source,
        stage_timings_012: [decode_s, features_s, graph_s],
        _inputs: _,
    } = state;

    // ── stage 3: full-resolution NCC refinement ───────────────────────────
    // No rotation geometry for the tile path — pass `None` for geometry.
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
        let outcome = refine_correspondences(
            img_a,
            img_b,
            scale_of(img_a, edge.a),
            scale_of(img_b, edge.b),
            None,
            &edge.inlier_matches,
            &RefineOptions::default(),
        );
        refined_matches += outcome.refined_count;
        fallback_matches += outcome.fallback_count;
        edge.inlier_matches = outcome.refined;
    }
    // No full-resolution rotation reverification for tile.
    let reverify = ReverifySummary {
        edges_dropped: 0,
        matches_dropped: 0,
    };
    let refine_s = t3.elapsed().as_secs_f64();
    progress(3, 1.0);

    // ── stage 4: tile placement solve + edge verification ─────────────────
    let t4 = Instant::now();
    progress(4, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let tile_edges = verify_tile_edges(&graph, 0x1226_cafe_dead_bee1, &Default::default());
    if tile_edges.is_empty() {
        return Err(StitchError::MatchFailed(vec![
            "no edges passed the similarity verifier — \
             try --strategy rotation or capture with more overlap"
                .into(),
        ]));
    }
    let frame_dims: Vec<(u32, u32)> = frames
        .iter()
        .map(|f| (f.image.width(), f.image.height()))
        .collect();
    let constraints: Vec<TileConstraint> = tile_edges
        .iter()
        .map(|e| TileConstraint {
            a: e.a,
            b: e.b,
            sim_ab: e.estimate.transform,
            weight: e.inlier_matches.len() as f64,
        })
        .collect();
    let (solved_poses, solved_canvas, tile_orphans) =
        solve_tile_poses(frames.len(), &constraints, 0, &frame_dims)
            .map_err(|e| StitchError::BaSolve(format!("tile placement: {e}")))?;
    // Honor the total-canvas pixel cap (uniform downscale to fit) — the
    // same `--max-canvas-px` contract the rotation path applies via
    // `auto_canvas` (#3086).
    let (poses, canvas_spec) =
        crate::tile::apply_canvas_cap(solved_poses, solved_canvas, opts.max_canvas_px)
            .map_err(|e| StitchError::BaSolve(format!("tile placement: {e}")))?;
    let solve_s = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    let poses_placed = poses.len();
    let reachable_set: HashSet<usize> = poses.iter().map(|p| p.frame_idx).collect();
    // Move (don't clone) each placed frame's full-resolution image out of
    // `frames` into the composite input. `poses` carries strictly distinct,
    // in-bounds `frame_idx` values (see `solve_tile_poses`: built from the
    // ascending `reachable` set), so every slot is taken at most once and the
    // `expect` cannot fire. Avoids deep-copying full-res planes (#1254).
    let mut frame_slots: Vec<Option<PlanarImage>> =
        frames.into_iter().map(|f| Some(f.image)).collect();
    let component_frames: Vec<PlanarImage> = poses
        .iter()
        .map(|p| {
            frame_slots[p.frame_idx]
                .take()
                .expect("each pose maps a distinct, present frame")
        })
        .collect();
    let component_edges: Vec<crate::tile::TileEdge> = tile_edges
        .iter()
        .filter(|e| reachable_set.contains(&e.a) && reachable_set.contains(&e.b))
        .cloned()
        .collect();

    if component_frames.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: component_frames.len(),
            dropped: vec![],
        });
    }

    // ── stage 5: composite ─────────────────────────────────────────────────
    let t5 = Instant::now();
    progress(5, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let (image, tile_report) = composite_tile(
        &component_frames,
        component_frames.len(),
        &component_edges,
        &poses,
        &canvas_spec,
        &Default::default(),
        None,
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;
    let composite_s = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    let mean_planar_residual_px = tile_report.mean_planar_residual_px;
    let max_planar_residual_px = tile_report.max_planar_residual_px;

    Ok(TileStitchOutcome {
        image,
        tile_report,
        strategy_report,
        focal_seed_source,
        applied_opcodes,
        priors,
        refined_matches,
        fallback_matches,
        reverify,
        orphans: tile_orphans,
        poses_placed,
        mean_planar_residual_px,
        max_planar_residual_px,
        stage_timings_s: [
            decode_s,
            features_s,
            graph_s,
            refine_s,
            solve_s,
            composite_s,
        ],
    })
}
