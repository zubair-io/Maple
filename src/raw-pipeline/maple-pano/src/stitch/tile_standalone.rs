//! Stand-alone tile-strategy entry point (stages 0–5). Split from
//! `tile_stitch.rs` for the file-size budget (#3086).
//!
//! [`stitch_tile`] runs the whole tile pipeline by itself — its own
//! decode, ALIKED + LightGlue pass and match graph — then hands off to
//! [`super::tile_stitch::tile_tail`] for stages 3–5. `super::stitch`
//! does the same thing but re-uses the early-stage state it already
//! computed, so it never pays for a second decode + ML pass (#1270).
//! This entry point exists for standalone tests and any caller that
//! wants the tile path unconditionally.

use std::path::PathBuf;

use crate::features::{AlikedDetector, DetectorOptions, LinearRgbFrame};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, MatchGraph};
use crate::ingest::{ingest_file, proxy_to_long_edge, FramePriors, IngestedFrame};
use crate::matching::{LightGlueMatcher, MatcherOptions};
use crate::models::ModelDir;
use crate::robust::RobustOptions;
use crate::stitch::interleave_planar;
use crate::strategy::StrategyReport;

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
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<TileStitchOutcome, StitchError> {
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
    let decode_s = t0.elapsed().as_secs_f64();

    let applied_opcodes: Vec<Vec<String>> =
        frames.iter().map(|f| f.applied_opcodes.clone()).collect();
    let priors: Vec<FramePriors> = frames.iter().map(|f| f.priors.clone()).collect();

    // ── stage 1: ML load + proxy feature extraction ───────────────────────
    let t1 = Instant::now();
    progress(1, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }

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
            ..MatcherOptions::default()
        },
    )
    .map_err(|e| StitchError::MlUnavailable(format!("LightGlue load failed: {e}")))?;

    let mut feature_sets = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());

    for (i, frame) in frames.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        let proxy = proxy_to_long_edge(&frame.image, opts.proxy_long_edge);
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
            cause: format!("detect: {e}"),
        })?;
        feature_sets.push(fs);
        progress(1, (i + 1) as f32 / frames.len() as f32);
    }
    let features_s = t1.elapsed().as_secs_f64();

    // Build proxy-resolution camera seeds with unit focal (1.0). The tile
    // path uses pixel correspondences directly and skips perspective BA, so
    // no EXIF focal is needed.
    let proxy_images: Vec<crate::graph::GraphImage> = frames
        .iter()
        .enumerate()
        .map(|(i, _f)| crate::graph::GraphImage {
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
    let graph: MatchGraph = build_match_graph(
        &proxy_images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| match matcher.match_features(&feature_sets[a], &feature_sets[b]) {
            Ok(ml_matches) => ml_matches_to_correspondences(&ml_matches, DEFAULT_MIN_SCORE),
            Err(e) => {
                match_failures.push(format!("pair ({a},{b}): {e}"));
                Vec::new()
            }
        },
        &RobustOptions::default(),
    );
    if !match_failures.is_empty() {
        return Err(StitchError::MatchFailed(match_failures));
    }
    let graph_s = t2.elapsed().as_secs_f64();
    progress(2, 1.0);

    // ── stages 3–5: NCC refine + placement + composite ────────────────────
    tile_tail(
        TileEarlyState {
            frames,
            proxy_dims,
            _feature_sets: feature_sets,
            graph,
            strategy_report,
            stage_timings_012: [decode_s, features_s, graph_s],
            _inputs: inputs,
        },
        opts,
        applied_opcodes,
        priors,
        progress,
        is_cancelled,
    )
}
