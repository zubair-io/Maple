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
//! When `select_strategy` returns `Strategy::Tile`, the head builds the
//! unit-focal tile graph from the cached LightGlue matches
//! (`tile_stitch::build_tile_graph`) and the tile tail runs instead of the
//! rotation tail. The early-stage state (decode-proxy + ALIKED + LightGlue +
//! match graph) is shared; only the tail (stages 3–5) differs between the
//! two paths. This eliminates the previous double-decode + double-ML pattern.
//!
//! # Preview and reusable alignment (#4578)
//!
//! `solve_alignment` is the head (stages 0–2 + strategy selection) and
//! returns a [`SolvedAlignment`]; [`stitch_reusing`] runs the tail from it,
//! skipping the head when an offered alignment's [`AlignmentKey`] matches.
//! [`preview`] runs the head (or reuses an alignment) and composites the
//! proxies onto a ~2048 px canvas without full-resolution refinement.
//!
//! [`stitch`] returns `Result<StitchSuccess, StitchError>` where
//! `StitchSuccess::Rotation(outcome)` or `StitchSuccess::Tile(outcome)`
//! tells the caller which strategy ran. The `TileNotSupported` error variant
//! was removed in the #1270 refactor — it is no longer part of `StitchError`.
//!
//! # Memory-bounded path (#1254, #5554)
//!
//! **Stage 0** develops each frame once, band by band, into the stitch's
//! [`crate::frame_store::FrameStore`] on disk, and reads its long-edge
//! proxy back from there ([`frames::decode_into_store`]). Only the proxy
//! planes and lightweight metadata (`FrameMeta`) are held resident between
//! stages; no stage decodes a RAW again.
//!
//! **Stage 3 (refinement)** reads each edge's two frames from the store
//! through a 2-entry cache, so at most 2 full-resolution frames are
//! resident at once.
//!
//! **Gain solve** (just before composite): surviving frames are read one
//! at a time, their overlap statistics accumulated, and the pixels freed
//! before the next — at most 1 full-resolution frame resident. The
//! residual exposure field (#4521) is solved right after it the same way,
//! onto the ~1 MP seam canvas.
//!
//! **Stage 5 (composite)**: always uses the tiled path (`composite_tiled`),
//! which reads per strip only the source rows that strip's warp taps. The
//! `canvas_tile_rows` option controls strip height; when it is `None`, a
//! default of 512 rows is used so the tiled path always engages on the
//! rotation-strategy path.
//!
//! End-to-end on pano_01 (21 DJI DNGs): the **frame-processing** peak RSS
//! drops from ~34 GB → ~4.9 GB (measured).  End-to-end peak is ~13.6 GB,
//! dominated by the ~8.7 GiB ONNX Runtime resident floor (tracked: #1275).
//! The <4 GB target is an iOS-only goal (tracked: #1274) that requires
//! ORT model pruning or on-demand ORT teardown.

mod aligned;
mod alignment;
mod alignment_codec;
mod degenerate;
mod engine;
mod focal_bootstrap;
mod frame_cache;
mod frames;
mod graph_build;
mod io;
mod photometry;
mod preview;
mod rotation_composite;
mod rotation_tail;
mod save;
mod seam_gate;
mod sidecars;
mod tile_standalone;
mod tile_stitch;
mod types;

pub use aligned::{stitch_reusing, AlignedStitch};
pub use alignment::{
    AlignedFrame, AlignmentKey, AlignmentReuse, InputIdentity, SolvedAlignment,
    ALIGNMENT_FORMAT_VERSION,
};
pub use engine::FeatureEngine;
pub use focal_bootstrap::FocalSeedSource;
pub use io::{develop_for_display, interleave_planar, quantize_to_u16};
pub use preview::{preview, PanoPreview, PREVIEW_LONG_EDGE_PX};
pub use save::{DisplayPng, PngCanvasSink};
pub use sidecars::SidecarDownscaler;
pub use tile_standalone::stitch_tile;
pub use types::{StitchError, StitchOptions, StitchOutcome, StitchSuccess, TileStitchOutcome};

use std::path::PathBuf;

use crate::composite::CanvasSink;
use crate::gain::LensGroups;
use crate::graph::{DescriptorTopKProvider, LoopClosureCheck, LoopClosureGate};
use crate::ingest::{ingest_file_proxy, FrameMeta};
use crate::strategy::Strategy;
use crate::twoview::PixelCorrespondence;
use graph_build::{build_stitch_graph, ground_footprints, validate_grid};
use tile_stitch::build_tile_graph;

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
/// Stages 0–2 (decode-proxy + features + match graph) run once for every
/// call regardless of the selected strategy. Stage 3 onwards branches:
/// - **Rotation** → NCC refinement → BA → leveling → equirect composite;
///   returns `Ok(StitchSuccess::Rotation(_))`.
/// - **Tile** → NCC refinement → planar placement → planar composite;
///   returns `Ok(StitchSuccess::Tile(_))`.
///
/// The composited canvas streams into `sink` strip by strip (#5452).
///
/// Equivalent to [`stitch_reusing`] with no alignment offered.
pub fn stitch(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    sink: &mut dyn CanvasSink,
    progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<StitchSuccess, StitchError> {
    stitch_reusing(inputs, opts, None, sink, progress, is_cancelled).map(|run| run.success)
}

/// Request checks shared by the stitch and the preview, before any decode.
pub(super) fn validate_request(
    inputs: &[PathBuf],
    opts: &StitchOptions,
) -> Result<(), StitchError> {
    if inputs.len() < 2 {
        return Err(StitchError::TooFewFrames(inputs.len()));
    }
    seam_gate::validate(opts, inputs.len())?;
    validate_grid(opts, inputs.len())
}

/// Stage 0 for the preview, which needs no full-resolution frames: decode
/// every frame to its long-edge proxy + priors.
///
/// #1254: `ingest_file_proxy` allocates the full-res buffer internally for
/// the downscale, then drops it before returning — only the lightweight
/// `FrameMeta` (proxy planes + metadata) survives.
pub(super) fn decode_proxies(
    inputs: &[PathBuf],
    proxy_long_edge: u32,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<FrameMeta>, StitchError> {
    progress(0, 0.0);
    let mut metas: Vec<FrameMeta> = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        metas.push(
            ingest_file_proxy(path, proxy_long_edge).map_err(|e| StitchError::Decode {
                path: path.clone(),
                cause: e.to_string(),
            })?,
        );
        progress(0, (i + 1) as f32 / inputs.len() as f32);
    }
    Ok(metas)
}

/// What stages 0–2 hand on: the reusable alignment, the decoded proxies
/// (the preview composites them; the full stitch drops them), and timings.
pub(super) struct SolvedHead {
    pub alignment: SolvedAlignment,
    pub metas: Vec<FrameMeta>,
    pub stage_timings_012: [f64; 3],
}

/// Stages 1–2 plus strategy selection over stage 0's `metas` (decoded in
/// `t_decode` seconds) — everything up to the boundary a
/// [`SolvedAlignment`] captures (#4578).
pub(super) fn solve_alignment(
    metas: Vec<FrameMeta>,
    t_decode: f64,
    opts: &StitchOptions,
    key: AlignmentKey,
    mut progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<SolvedHead, StitchError> {
    use std::time::Instant;

    let priors: Vec<crate::ingest::FramePriors> = metas.iter().map(|m| m.priors.clone()).collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    let t1 = Instant::now();
    progress(1, 0.0);

    let (feature_sets, mut pair_matcher) =
        engine::extract_features(&metas, opts, &mut progress, &is_cancelled)?;
    let proxy_dims: Vec<(u32, u32)> = metas
        .iter()
        .map(|m| (m.proxy.width(), m.proxy.height()))
        .collect();
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
    let full_dims: Vec<(u32, u32)> = metas
        .iter()
        .map(|m| (m.full_width, m.full_height))
        .collect();
    let ground = ground_footprints(&priors, &full_dims);
    let rotation_gate = opts.grid.map(|layout| LoopClosureGate {
        layout,
        check: LoopClosureCheck::Rotation,
        ground: &ground,
    });
    let mut graph = build_stitch_graph(
        &proxy_images,
        rotation_gate.as_ref(),
        Some(&descriptor_topk),
        |a, b| -> Vec<PixelCorrespondence> {
            // Candidates arrive in ascending (a, b) order, so the first index
            // is a monotone (if uneven) measure of how far matching has got.
            progress(2, a as f32 / metas.len() as f32);
            if is_cancelled() {
                return Vec::new();
            }
            let corrs = match pair_matcher.match_pair(&feature_sets[a], &feature_sets[b]) {
                Ok(corrs) => corrs,
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            };
            raw_matches_cache.push(((a, b), corrs.clone()));
            corrs
        },
    );
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
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
        rotation_gate.as_ref(),
        Some(&descriptor_topk),
        |a, b| {
            if is_cancelled() {
                Err("cancelled by caller".into())
            } else {
                pair_matcher.match_pair(&feature_sets[a], &feature_sets[b])
            }
        },
    )
    .map_err(|e| {
        if is_cancelled() {
            StitchError::Cancelled
        } else {
            e
        }
    })?;
    pair_matcher.release();
    // Timed after refinement, not just the bootstrap build, so the stage
    // duration covers any fallback rebuild work too.
    let t_graph = t2.elapsed().as_secs_f64();
    progress(2, 1.0);

    // ── strategy selection (runs on proxy graph, before full-res reverify) ─
    let focal_full_px: Vec<f64> = full_images.iter().map(|img| img.camera.focal_px).collect();
    let strategy_report =
        alignment::select_strategy_for(opts.strategy, &graph, &priors, &focal_full_px);

    // #1270: the tile branch re-verifies the cached matches with unit-focal
    // cameras (no second matcher pass) — done here so the tile graph is
    // part of the reusable alignment.
    let tile_graph = (strategy_report.selected == Strategy::Tile)
        .then(|| {
            build_tile_graph(
                raw_matches_cache,
                &proxy_dims,
                &feature_sets,
                opts.grid,
                &priors,
                &full_dims,
            )
        })
        .transpose()?;

    let frames: Vec<AlignedFrame> = metas
        .iter()
        .zip(&full_images)
        .map(|(m, img)| AlignedFrame {
            full_dims: (m.full_width, m.full_height),
            proxy_dims: (m.proxy.width(), m.proxy.height()),
            proxy_scale: (m.proxy_scale_x, m.proxy_scale_y),
            focal_full_px: img.camera.focal_px,
            priors: m.priors.clone(),
            applied_opcodes: m.applied_opcodes.clone(),
        })
        .collect();

    Ok(SolvedHead {
        alignment: SolvedAlignment {
            key,
            frames,
            focal_seed_source: focal_seed.source,
            graph,
            tile_graph,
            strategy_report,
            lenses: LensGroups::from_metas(&metas),
        },
        metas,
        stage_timings_012: [t_decode, t_features, t_graph],
    })
}
