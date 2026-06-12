//! Tile-strategy execution for `pano stitch` (spec §8, ticket #1226).
//! Split from `pano/mod.rs` for the file-size budget.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

use maple_pano::graph::{MatchGraph, ReverifySummary};
use maple_pano::ingest::{IngestedFrame, PlanarImage};
use maple_pano::refine::{refine_correspondences, RefineOptions};
use maple_pano::strategy::StrategyReport;
use maple_pano::tile::placement::{solve_tile_poses, TileConstraint};
use maple_pano::tile::{composite_tile, verify_tile_edges};

use super::io::{tile_stitch_report, write_png16, TileReportContext};
use super::SetOutputs;

/// All inputs the tile execution path needs (borrowed from `stitch_set`).
pub(super) struct TileInput<'a> {
    pub inputs: &'a [PathBuf],
    pub applied_opcodes: &'a [Vec<String>],
    pub frames: Vec<IngestedFrame>,
    pub proxy_dims: &'a [(u32, u32)],
    pub graph: &'a mut MatchGraph,
    pub strategy_report: &'a StrategyReport,
    pub outs: &'a SetOutputs,
    pub t0: Instant,
    pub decode_s: f64,
    pub features_s: f64,
    pub graph_s: f64,
}

/// Run the tile strategy and return the stitch report JSON.
pub(super) fn run_tile(inp: TileInput<'_>) -> Result<serde_json::Value, String> {
    let TileInput {
        inputs,
        applied_opcodes,
        frames,
        proxy_dims,
        graph,
        strategy_report,
        outs,
        t0,
        decode_s,
        features_s,
        graph_s,
    } = inp;

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
        // For tile path, refine without rotation-model geometry
        // compensation (the geometry is a translation, not a rotation).
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
    // No full-res rotation reverification for tile: the rotation model
    // would drop all edges on translation-dominant sets.
    let reverify = ReverifySummary {
        edges_dropped: 0,
        matches_dropped: 0,
    };
    let refine_s = t_refine.elapsed().as_secs_f64();
    eprintln!(
        "pano: tile refine — {refined_matches} matches NCC-refined at full res, \
         {fallback_matches} kept proxy accuracy ({refine_s:.1}s)"
    );

    let t_solve = Instant::now();

    // Verify tile edges (similarity model on full-res matches).
    let tile_edges = verify_tile_edges(graph, 0x1226_cafe_dead_bee1, &Default::default());
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
            "pano: tile placement — frame(s) {:?} disconnected from anchor, \
             reported as orphans (largest component stitched)",
            tile_orphans
        );
    }
    eprintln!(
        "pano: tile solve — {} poses, {} orphan(s), canvas {}×{} ({solve_s:.1}s)",
        poses.len(),
        tile_orphans.len(),
        canvas_spec.width,
        canvas_spec.height,
    );

    // Build the reachable-frame list and filter edges to the component,
    // mirroring the rotation path's solution.cameras filter.
    let reachable_set: HashSet<usize> = poses.iter().map(|p| p.frame_idx).collect();
    let all_frame_images: Vec<PlanarImage> = frames.into_iter().map(|f| f.image).collect();
    // poses is already sorted by frame_idx (BFS order from anchor 0);
    // collect frames in the same pose-order so frames[i] ↔ poses[i].
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
        "pano: tile composite — {}×{}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
        out_img.width(),
        out_img.height(),
        tile_report.mean_planar_residual_px,
        tile_report.max_planar_residual_px,
    );

    let t_out = Instant::now();
    write_png16(&outs.linear, &out_img, false)?;
    if let Some(display) = &outs.display {
        write_png16(display, &out_img, true)?;
    }
    let write_s = t_out.elapsed().as_secs_f64();

    let report = tile_stitch_report(&TileReportContext {
        inputs,
        applied_opcodes,
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
    if let Some(path) = &outs.report {
        let pretty = serde_json::to_string_pretty(&report).expect("report serializes");
        std::fs::write(path, &pretty).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    eprintln!(
        "pano: wrote {} ({}x{}) in {:.1}s",
        outs.linear.display(),
        out_img.width(),
        out_img.height(),
        t0.elapsed().as_secs_f64()
    );
    Ok(report)
}
