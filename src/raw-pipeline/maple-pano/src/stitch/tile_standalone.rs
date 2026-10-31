//! Stand-alone tile-strategy entry point (stages 0–5). Split from
//! `tile_stitch.rs` for the file-size budget (#3086).
//!
//! [`stitch_tile`] runs the whole tile pipeline by itself — its own
//! stage 0, ALIKED + LightGlue pass and match graph — then hands off to
//! [`super::tile_stitch::tile_tail`] for stages 3–5. `super::stitch`
//! does the same thing but re-uses the early-stage state it already
//! computed, so it never pays for a second stage 0 + ML pass (#1270).
//! This entry point exists for standalone tests and any caller that
//! wants the tile path unconditionally.

use std::path::PathBuf;

use crate::composite::CanvasSink;
use crate::graph::{DescriptorTopKProvider, LoopClosureCheck, LoopClosureGate, MatchGraph};
use crate::ingest::FramePriors;
use crate::strategy::StrategyReport;

use super::engine::extract_features;
use super::tile_stitch::{tile_tail, TileEarlyState};
use super::types::{StitchError, StitchOptions, TileStitchOutcome};

// ─── Stand-alone entry point (stages 0–5) ────────────────────────────────────

/// Run the tile-strategy panorama pipeline on the given RAW frames.
///
/// `inputs` must have at least 2 elements. `progress` is called with
/// `(stage, fraction)` at each pipeline stage (ordinals 0–5, see module
/// docs). `is_cancelled` is polled between stages — return `true` to
/// abort with [`StitchError::Cancelled`].
///
/// On success the caller owns all I/O (PNG writing, JSON report). This
/// function is pure computation: decode → features → graph → refine →
/// solve → composite.
///
/// # Implementation note
///
/// After the #1270 refactor this is a thin wrapper: it runs stages 0–2
/// to build early state, then calls [`tile_tail`] for stages 3–5.
/// The shared [`super::stitch`] entry point does the same thing but
/// re-uses the early state it already computed (skipping a second decode
/// and ML pass for sets that auto-select tile). This function exists for
/// standalone tests and any caller that wants to run the tile path
/// unconditionally without first calling [`super::stitch`].
pub fn stitch_tile(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    strategy_report: StrategyReport,
    sink: &mut dyn CanvasSink,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<TileStitchOutcome, StitchError> {
    use std::time::Instant;

    if inputs.len() < 2 {
        return Err(StitchError::TooFewFrames(inputs.len()));
    }
    super::graph_build::validate_grid(opts, inputs.len())?;

    // ── stage 0: develop into the frame store + proxies (#5554) ──────────
    // Same stage 0 as `stitch::stitch`: each frame is developed once into
    // the store and its proxy read back; `tile_tail` reads full-resolution
    // pixels from the store.
    let t0 = Instant::now();
    let (store, metas) = super::frames::decode_into_store(
        inputs,
        opts.proxy_long_edge,
        &mut progress,
        &is_cancelled,
    )?;
    let decode_s = t0.elapsed().as_secs_f64();

    let applied_opcodes: Vec<Vec<String>> =
        metas.iter().map(|m| m.applied_opcodes.clone()).collect();
    let priors: Vec<FramePriors> = metas.iter().map(|m| m.priors.clone()).collect();
    let full_dims: Vec<(u32, u32)> = metas
        .iter()
        .map(|m| (m.full_width, m.full_height))
        .collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    let t1 = Instant::now();
    progress(1, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }

    let (feature_sets, mut pair_matcher) =
        extract_features(&metas, opts, &mut progress, &is_cancelled)?;
    let proxy_dims: Vec<(u32, u32)> = metas
        .iter()
        .map(|m| (m.proxy.width(), m.proxy.height()))
        .collect();
    let features_s = t1.elapsed().as_secs_f64();

    // Build proxy-resolution camera seeds with unit focal (1.0). The tile
    // path uses pixel correspondences directly and skips perspective BA, so
    // no EXIF focal is needed.
    let proxy_images: Vec<crate::graph::GraphImage> = metas
        .iter()
        .enumerate()
        .map(|(i, _m)| crate::graph::GraphImage {
            camera: crate::camera::Camera::new(
                [0.0; 3],
                1.0,
                0.0,
                0.0,
                proxy_dims[i].0,
                proxy_dims[i].1,
            ),
            prior_rotation: None,
        })
        .collect();

    // ── stage 2: match graph ──────────────────────────────────────────────
    let t2 = Instant::now();
    progress(2, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let mut match_failures: Vec<String> = Vec::new();
    // #1215: content-based nomination for unordered / metadata-free tile
    // input (film scans, nadir strips) — exactly this entry point's own
    // motivating scenario.
    let descriptor_topk = DescriptorTopKProvider::new(&feature_sets);
    let ground = super::graph_build::ground_footprints(&priors, &full_dims);
    let planar_gate = opts.grid.map(|layout| LoopClosureGate {
        layout,
        check: LoopClosureCheck::Planar,
        ground: &ground,
    });
    let graph: MatchGraph = super::graph_build::build_stitch_graph(
        &proxy_images,
        planar_gate.as_ref(),
        Some(&descriptor_topk),
        |a, b| {
            if is_cancelled() {
                return Vec::new();
            }
            match pair_matcher.match_pair(&feature_sets[a], &feature_sets[b]) {
                Ok(corrs) => corrs,
                Err(e) => {
                    match_failures.push(format!("pair ({a},{b}): {e}"));
                    Vec::new()
                }
            }
        },
    );
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    if !match_failures.is_empty() {
        return Err(StitchError::MatchFailed(match_failures));
    }
    let graph_s = t2.elapsed().as_secs_f64();
    progress(2, 1.0);

    // ── stages 3–5: NCC refine + placement + composite ────────────────────
    tile_tail(
        TileEarlyState {
            full_dims,
            proxy_dims,
            graph,
            strategy_report,
            // This standalone entry point never resolves EXIF/homography
            // focal — it always uses unit focal (see the comment above
            // `proxy_images`), so there is no seed source to report.
            focal_seed_source: None,
            stage_timings_012: [decode_s, features_s, graph_s],
            inputs,
            frames: &store,
            lenses: crate::gain::LensGroups::from_metas(&metas),
        },
        opts,
        applied_opcodes,
        priors,
        sink,
        progress,
        is_cancelled,
    )
}
