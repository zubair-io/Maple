//! Tile-strategy orchestration, lifted from `maple-cli` so it can be
//! consumed by the Apple FFI and any other caller (spec §8, ticket #1226).
//!
//! This is the planar/flat stitching path for nadir and translational sets
//! (film scans, flatbed tiles, strip mapping). It is deliberately separate
//! from the rotation-strategy [`super::stitch`] and shares no stage with it.
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
//! This function does **not** write PNGs or JSON reports. The caller
//! (CLI or FFI) owns all output I/O so that the crate stays I/O-free.

use std::collections::HashSet;
use std::path::PathBuf;

use crate::features::{AlikedDetector, DetectorOptions, LinearRgbFrame};
use crate::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use crate::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, MatchGraph, ReverifySummary,
};
use crate::ingest::{ingest_file, proxy_to_long_edge, FramePriors, IngestedFrame, PlanarImage};
use crate::matching::LightGlueMatcher;
use crate::models::ModelDir;
use crate::refine::{refine_correspondences, RefineOptions};
use crate::robust::RobustOptions;
use crate::stitch::interleave_planar;
use crate::strategy::StrategyReport;
use crate::tile::placement::{solve_tile_poses, TileConstraint};
use crate::tile::{composite_tile, verify_tile_edges};

use super::types::{StitchError, StitchOptions, TileStitchOutcome};

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
    let mut matcher = LightGlueMatcher::load(&models, Default::default())
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
    let mut graph: MatchGraph = build_match_graph(
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
    let (poses, canvas_spec, tile_orphans) =
        solve_tile_poses(frames.len(), &constraints, 0, &frame_dims)
            .map_err(|e| StitchError::BaSolve(format!("tile placement: {e}")))?;
    let solve_s = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    let poses_placed = poses.len();
    let reachable_set: HashSet<usize> = poses.iter().map(|p| p.frame_idx).collect();
    let all_frame_images: Vec<PlanarImage> = frames.into_iter().map(|f| f.image).collect();
    let component_frames: Vec<PlanarImage> = poses
        .iter()
        .map(|p| all_frame_images[p.frame_idx].clone())
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
