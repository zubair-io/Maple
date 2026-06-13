//! Tile-strategy execution for `pano stitch` (spec §8, ticket #1226).
//! Split from `pano/mod.rs` for the file-size budget.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use maple_pano::features::{AlikedDetector, DetectorOptions, LinearRgbFrame};
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, MatchGraph, ReverifySummary,
};
use maple_pano::ingest::{ingest_file, proxy_to_long_edge, IngestedFrame, PlanarImage};
use maple_pano::matching::LightGlueMatcher;
use maple_pano::models::ModelDir;
use maple_pano::refine::{refine_correspondences, RefineOptions};
use maple_pano::robust::RobustOptions;
use maple_pano::stitch::{interleave_planar, StitchOptions};
use maple_pano::strategy::StrategyReport;
use maple_pano::tile::placement::{solve_tile_poses, TileConstraint};
use maple_pano::tile::{composite_tile, verify_tile_edges};

use super::io::{tile_stitch_report, write_png16, TileReportContext};

/// Arguments for the tile path when called after `stitch()` returned
/// `TileNotSupported`. All frame data is re-derived from paths (the
/// shared `stitch` function already consumed the frames on the rotation
/// path before detecting tile).
pub(super) struct TilePathArgs<'a> {
    pub inputs: &'a [PathBuf],
    pub opts: &'a StitchOptions,
    pub strategy_report: &'a StrategyReport,
    pub outs_linear: &'a Path,
    pub outs_display: Option<&'a Path>,
    pub outs_report: Option<&'a Path>,
    pub t0: Instant,
}

/// Run the tile strategy from raw paths (re-decodes + re-features since
/// `stitch()` already consumed the frames internally before returning
/// `TileNotSupported`).
pub(super) fn run_tile_from_paths(args: TilePathArgs<'_>) -> Result<serde_json::Value, String> {
    let TilePathArgs {
        inputs,
        opts,
        strategy_report,
        outs_linear,
        outs_display,
        outs_report,
        t0,
    } = args;

    // ---- Decode + priors ------------------------------------------------
    let t_decode = Instant::now();
    let mut frames: Vec<IngestedFrame> = Vec::with_capacity(inputs.len());
    for path in inputs {
        eprintln!("pano[tile]: decoding {}", path.display());
        frames.push(ingest_file(path).map_err(|e| format!("{}: {e}", path.display()))?);
    }
    let decode_s = t_decode.elapsed().as_secs_f64();
    let applied_opcodes: Vec<Vec<String>> =
        frames.iter().map(|f| f.applied_opcodes.clone()).collect();

    // ---- ML load + proxy features ---------------------------------------
    let t_feat = Instant::now();
    let models = ModelDir::resolve(opts.models_dir.as_deref()).map_err(|e| {
        format!(
            "ML environment unavailable: {e}\n\
             set MAPLE_PANO_MODELS and ORT_DYLIB_PATH (>= 1.23)"
        )
    })?;
    let mut detector = AlikedDetector::load(&models, DetectorOptions::default())
        .map_err(|e| format!("ALIKED load failed: {e}"))?;
    let mut matcher = LightGlueMatcher::load(&models, Default::default())
        .map_err(|e| format!("LightGlue load failed: {e}"))?;

    let mut feature_sets = Vec::with_capacity(frames.len());
    let mut proxy_scale: Vec<f64> = Vec::with_capacity(frames.len());
    let mut proxy_dims: Vec<(u32, u32)> = Vec::with_capacity(frames.len());
    for (i, frame) in frames.iter().enumerate() {
        let proxy = proxy_to_long_edge(&frame.image, opts.proxy_long_edge);
        proxy_scale.push(frame.image.width() as f64 / proxy.width() as f64);
        proxy_dims.push((proxy.width(), proxy.height()));
        let rgb = interleave_planar(&proxy);
        let lin = LinearRgbFrame::new(proxy.width(), proxy.height(), rgb)
            .map_err(|e| format!("frame {i}: {e}"))?;
        feature_sets.push(
            detector
                .detect(&lin)
                .map_err(|e| format!("frame {i}: detect: {e}"))?,
        );
    }
    let features_s = t_feat.elapsed().as_secs_f64();

    // Build proxy-resolution camera seeds (no EXIF focal needed for tile).
    // We use unit focal (1.0) since the tile path uses pixel correspondences
    // directly and doesn't run a perspective BA.
    let proxy_images: Vec<maple_pano::graph::GraphImage> = frames
        .iter()
        .enumerate()
        .map(|(i, _f)| maple_pano::graph::GraphImage {
            camera: maple_pano::camera::Camera::new(
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

    // ---- Match graph ----------------------------------------------------
    let t_graph = Instant::now();
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
    let graph_s = t_graph.elapsed().as_secs_f64();
    if !match_failures.is_empty() {
        return Err(format!(
            "LightGlue failed on {} pair(s):\n{}",
            match_failures.len(),
            match_failures.join("\n")
        ));
    }

    // ---- Full-res NCC refinement (no rotation geometry for tile) --------
    let t_refine = Instant::now();
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
    // No full-res rotation reverification for tile.
    let reverify = ReverifySummary {
        edges_dropped: 0,
        matches_dropped: 0,
    };
    let refine_s = t_refine.elapsed().as_secs_f64();
    eprintln!(
        "pano[tile]: refine — {refined_matches} matches NCC-refined at full res, \
         {fallback_matches} kept proxy accuracy ({refine_s:.1}s)"
    );

    // ---- Tile placement + composite ------------------------------------
    let t_solve = Instant::now();
    let tile_edges = verify_tile_edges(&graph, 0x1226_cafe_dead_bee1, &Default::default());
    if tile_edges.is_empty() {
        return Err(
            "tile strategy selected but no edges passed the similarity verifier — \
             try --strategy rotation or capture with more overlap"
                .into(),
        );
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
            .map_err(|e| format!("tile placement failed: {e}"))?;
    let solve_s = t_solve.elapsed().as_secs_f64();
    if !tile_orphans.is_empty() {
        eprintln!(
            "pano[tile]: placement — frame(s) {:?} disconnected from anchor, \
             reported as orphans (largest component stitched)",
            tile_orphans
        );
    }
    eprintln!(
        "pano[tile]: solve — {} poses, {} orphan(s), canvas {}×{} ({solve_s:.1}s)",
        poses.len(),
        tile_orphans.len(),
        canvas_spec.width,
        canvas_spec.height,
    );

    let reachable_set: HashSet<usize> = poses.iter().map(|p| p.frame_idx).collect();
    let all_frame_images: Vec<PlanarImage> = frames.into_iter().map(|f| f.image).collect();
    let component_frames: Vec<PlanarImage> = poses
        .iter()
        .map(|p| all_frame_images[p.frame_idx].clone())
        .collect();
    let component_edges: Vec<maple_pano::tile::TileEdge> = tile_edges
        .iter()
        .filter(|e| reachable_set.contains(&e.a) && reachable_set.contains(&e.b))
        .cloned()
        .collect();

    if component_frames.len() < 2 {
        return Err(format!(
            "only {} frame(s) in the tile component — nothing to composite \
             (orphans: {:?})",
            component_frames.len(),
            tile_orphans
        ));
    }

    let t_comp = Instant::now();
    let (out_img, tile_report) = composite_tile(
        &component_frames,
        component_frames.len(),
        &component_edges,
        &poses,
        &canvas_spec,
        &Default::default(),
        None,
    )
    .map_err(|e| e.to_string())?;
    let composite_s = t_comp.elapsed().as_secs_f64();
    eprintln!(
        "pano[tile]: composite — {}×{}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
        out_img.width(),
        out_img.height(),
        tile_report.mean_planar_residual_px,
        tile_report.max_planar_residual_px,
    );

    let t_out = Instant::now();
    write_png16(outs_linear, &out_img, false)?;
    if let Some(display) = outs_display {
        write_png16(display, &out_img, true)?;
    }
    let write_s = t_out.elapsed().as_secs_f64();

    let report = tile_stitch_report(&TileReportContext {
        inputs,
        applied_opcodes: &applied_opcodes,
        strategy: strategy_report,
        refined_matches,
        fallback_matches,
        reverify: &reverify,
        tile_report: &tile_report,
        tile_orphans: &tile_orphans,
        timings_s: [
            ("decode", decode_s),
            ("features", features_s),
            ("match_graph", graph_s),
            ("refine", refine_s),
            ("solve", solve_s),
            ("composite", composite_s),
            ("write", write_s),
            ("total", t0.elapsed().as_secs_f64()),
        ],
    });
    if let Some(path) = outs_report {
        let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
        std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    eprintln!(
        "pano[tile]: wrote {} ({}x{}) in {:.1}s",
        outs_linear.display(),
        out_img.width(),
        out_img.height(),
        t0.elapsed().as_secs_f64()
    );
    Ok(report)
}
