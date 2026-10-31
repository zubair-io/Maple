//! Tile-strategy orchestration, lifted from `maple-cli` so it can be
//! consumed by the Apple FFI and any other caller (spec §8, ticket #1226).
//!
//! This is the planar/flat stitching path for nadir and translational sets
//! (film scans, flatbed tiles, strip mapping). After the strategy-selection
//! refactor (#1270) this module has two entry points:
//!
//! - [`stitch_tile`]: the full stand-alone tile pipeline (stages 0–5). Used
//!   for testing and any caller that wants a self-contained tile entry point.
//!   It runs its own stage 0 (develop into the frame store) + ML + match
//!   graph, then calls [`tile_tail`].
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
//! 0 — develop into the frame store + proxies + priors
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
use crate::composite::{CancellableSink, CanvasSink};
use crate::features::FeatureSet;
use crate::frame_store::FrameRows;
use crate::gain::LensGroups;
use crate::graph::{
    DescriptorTopKProvider, GraphImage, GridLayout, LoopClosureCheck, LoopClosureGate, MatchGraph,
    ReverifySummary,
};
use crate::ingest::FramePriors;
use crate::local_align::planar::fit_planar_corrections;
use crate::strategy::StrategyReport;
use crate::tile::placement::{solve_tile_poses, TileConstraint};
use crate::tile::{composite_tile, verify_tile_edges};
use crate::twoview::PixelCorrespondence;

use super::refine_pass::{refine_edges, RefinePassResult};
use super::types::{StitchError, StitchOptions, TileStitchOutcome};

// ─── Shared early-stage state ─────────────────────────────────────────────────

/// Early-stage state (stages 0–2) passed to [`tile_tail`] by [`super::stitch`].
///
/// Fields are ordered by how they are produced during the shared pipeline:
/// stage-0 meta → stage-1 features + proxy dims → stage-2 match graph.
pub(super) struct TileEarlyState<'a> {
    /// Per-frame full-resolution pixel dimensions — a cheap metadata-only
    /// fact from stage 0's `FrameMeta`, not a decode (#3197). Pixels
    /// themselves are read from `frames` in per-region windows (#5560).
    pub full_dims: Vec<(u32, u32)>,
    /// Per-frame proxy dimensions `(width, height)`.
    pub proxy_dims: Vec<(u32, u32)>,
    /// The proxy-resolution match graph (verified edges).
    pub graph: MatchGraph,
    /// Strategy-selection report (evidence + selected strategy + warning).
    pub strategy_report: StrategyReport,
    /// Which source produced the shared camera focal seed. `None` only
    /// for the standalone [`stitch_tile`] entry point, which never
    /// resolves a real per-frame focal (always unit-focal — see
    /// `build_tile_graph`'s doc comment).
    pub focal_seed_source: Option<super::FocalSeedSource>,
    /// Wall-clock times for stages 0, 1, 2 (seconds).
    pub stage_timings_012: [f64; 3],
    /// Path list parallel to `full_dims`, for the stitch report and read
    /// errors.
    pub inputs: &'a [PathBuf],
    /// The stitch's developed frames, parallel to `inputs`, which
    /// `tile_tail`'s stages 3–5 read from (#5560).
    pub frames: &'a dyn FrameRows,
    /// Lens identity per input frame for the blind vignette estimate
    /// (#4522), parallel to `full_dims`.
    pub lenses: LensGroups,
}

// ─── Tile graph built during the shared head ──────────────────────────────────

/// Re-verify the head's cached matches with unit-focal cameras — the graph
/// the tile tail consumes (#1270). Runs inside `solve_alignment` when
/// strategy selection returns `Tile`, so the tile graph is part of the
/// reusable alignment (#4578). No matcher call.
pub(super) fn build_tile_graph(
    raw_matches_cache: Vec<((usize, usize), Vec<PixelCorrespondence>)>,
    proxy_dims: &[(u32, u32)],
    feature_sets: &[FeatureSet],
    grid: Option<GridLayout>,
    priors: &[FramePriors],
    full_dims: &[(u32, u32)],
) -> Result<MatchGraph, StitchError> {
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
    let descriptor_topk = DescriptorTopKProvider::new(feature_sets);
    let ground = super::graph_build::ground_footprints(priors, full_dims);
    let planar_gate = grid.map(|layout| LoopClosureGate {
        layout,
        check: LoopClosureCheck::Planar,
        ground: &ground,
    });
    let tile_graph = super::graph_build::build_stitch_graph(
        &unit_proxy_images,
        planar_gate.as_ref(),
        Some(&descriptor_topk),
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
                    // `build_tile_graph` to propagate `StitchError::MatchFailed`.
                    tile_match_failures.push(format!(
                        "tile re-verify: pair ({a},{b}) not in rotation match cache — \
                         the unit-focal candidate set requested a pair the EXIF-focal \
                         graph did not generate; stitching cannot proceed"
                    ));
                    Vec::new()
                }
            }
        },
    );
    if tile_match_failures.is_empty() {
        Ok(tile_graph)
    } else {
        Err(StitchError::MatchFailed(tile_match_failures))
    }
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
    sink: &mut dyn CanvasSink,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<TileStitchOutcome, StitchError> {
    use std::time::Instant;

    super::seam_gate::reject_on_tile(opts)?;
    let TileEarlyState {
        full_dims,
        proxy_dims,
        mut graph,
        strategy_report,
        focal_seed_source,
        stage_timings_012: [decode_s, features_s, graph_s],
        inputs,
        frames,
        lenses,
    } = state;
    let match_graph = graph.summary();

    // ── stage 3: full-resolution NCC refinement ───────────────────────────
    // No rotation geometry for the tile path; otherwise the same banded
    // store reads as the rotation path.
    let t3 = Instant::now();
    progress(3, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let proxy_scales: Vec<(f64, f64)> = full_dims
        .iter()
        .zip(&proxy_dims)
        .map(|(full, proxy)| {
            (
                full.0 as f64 / proxy.0 as f64,
                full.1 as f64 / proxy.1 as f64,
            )
        })
        .collect();
    let RefinePassResult {
        refined_matches,
        fallback_matches,
    } = refine_edges(
        &mut graph,
        &inputs,
        frames,
        &proxy_scales,
        None,
        |frac| progress(3, frac),
        &is_cancelled,
    )?;
    // No full-resolution rotation reverification for tile.
    let reverify = ReverifySummary {
        edges_dropped: 0,
        matches_dropped: 0,
    };
    let refine_s = t3.elapsed().as_secs_f64();
    progress(3, 1.0);

    let TilePlaced {
        tile_report,
        orphans: tile_orphans,
        poses_placed,
        solve_s,
        composite_s,
    } = place_and_composite(
        &graph,
        &full_dims,
        frames,
        &lenses,
        opts.local_align,
        |_, _| opts.max_canvas_px,
        sink,
        &mut progress,
        &is_cancelled,
    )?;

    let mean_planar_residual_px = tile_report.mean_planar_residual_px;
    let max_planar_residual_px = tile_report.max_planar_residual_px;

    Ok(TileStitchOutcome {
        tile_report,
        strategy_report,
        focal_seed_source,
        applied_opcodes,
        priors,
        refined_matches,
        fallback_matches,
        reverify,
        match_graph,
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

/// What [`place_and_composite`] produced.
pub(super) struct TilePlaced {
    pub tile_report: crate::tile::TileCompositeReport,
    pub orphans: Vec<usize>,
    pub poses_placed: usize,
    pub solve_s: f64,
    pub composite_s: f64,
}

/// Tile stages 4–5: verify edges, solve placement, cap the canvas, then
/// composite from `frames`. `dims[i]` is the size of the frames `frames`
/// serves and of the coordinates `graph`'s matches are in — full
/// resolution for the stitch, proxy resolution for the preview (#4578).
/// `canvas_cap_px` maps the solved natural canvas size to its pixel cap.
#[allow(clippy::too_many_arguments)]
pub(super) fn place_and_composite(
    graph: &MatchGraph,
    dims: &[(u32, u32)],
    frames: &dyn FrameRows,
    lenses: &LensGroups,
    local_align: bool,
    canvas_cap_px: impl FnOnce(u32, u32) -> usize,
    sink: &mut dyn CanvasSink,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<TilePlaced, StitchError> {
    use std::time::Instant;

    // ── stage 4: tile placement solve + edge verification ─────────────────
    let t4 = Instant::now();
    progress(4, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let tile_edges = verify_tile_edges(graph, 0x1226_cafe_dead_bee1, &Default::default(), dims);
    if tile_edges.is_empty() {
        return Err(StitchError::MatchFailed(vec![
            "no edges passed the similarity verifier — \
             try --strategy rotation or capture with more overlap"
                .into(),
        ]));
    }
    let constraints: Vec<TileConstraint> = tile_edges
        .iter()
        .map(|e| TileConstraint {
            a: e.a,
            b: e.b,
            sim_ab: e.estimate.transform,
            weight: e.inlier_matches.len() as f64,
        })
        .collect();
    let (solved_poses, solved_canvas, orphans) =
        solve_tile_poses(dims.len(), &constraints, 0, dims)
            .map_err(|e| StitchError::BaSolve(format!("tile placement: {e}")))?;
    // Honor the total-canvas pixel cap (uniform downscale to fit) — the
    // same `--max-canvas-px` contract the rotation path applies via
    // `auto_canvas` (#3086).
    let cap_px = canvas_cap_px(solved_canvas.width, solved_canvas.height);
    let (poses, canvas_spec) = crate::tile::apply_canvas_cap(solved_poses, solved_canvas, cap_px)
        .map_err(|e| StitchError::BaSolve(format!("tile placement: {e}")))?;
    let solve_s = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    let poses_placed = poses.len();
    // #3197: `poses[i].frame_idx` identifies which original frame each pose
    // covers, and `composite_tile` reads its windows from `frames`.
    let reachable_set: HashSet<usize> = poses.iter().map(|p| p.frame_idx).collect();
    let component_edges: Vec<crate::tile::TileEdge> = tile_edges
        .iter()
        .filter(|e| reachable_set.contains(&e.a) && reachable_set.contains(&e.b))
        .cloned()
        .collect();

    if poses.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: poses.len(),
            dropped: vec![],
        });
    }

    let corrections = local_align.then(|| fit_planar_corrections(&poses, dims, &component_edges));

    // ── stage 5: composite ─────────────────────────────────────────────────
    let t5 = Instant::now();
    progress(5, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let tile_report = composite_tile(
        frames,
        dims,
        &component_edges,
        &poses,
        corrections.as_deref(),
        &canvas_spec,
        lenses,
        &Default::default(),
        None,
        &mut CancellableSink::new(sink, is_cancelled),
    )
    .map_err(super::seam_gate::composite_error)?;
    let composite_s = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    Ok(TilePlaced {
        tile_report,
        orphans,
        poses_placed,
        solve_s,
        composite_s,
    })
}
