//! Tile-strategy CLI driver for `pano stitch` (spec §8, ticket #1226).
//! Split from `pano/mod.rs` for the file-size budget.
//!
//! This module is a thin CLI tail: it delegates all orchestration to
//! [`maple_pano::stitch::stitch_tile`] and owns only the output I/O
//! (PNG writes and the `StitchReport` JSON assembly). Identical outputs
//! to the previous inline implementation — behavior is unchanged.

use std::path::{Path, PathBuf};
use std::time::Instant;

use maple_pano::stitch::{stitch_tile, StitchOptions};
use maple_pano::strategy::StrategyReport;

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
/// `TileNotSupported`). Delegates all orchestration to `stitch_tile` in
/// the maple-pano crate; only PNG I/O and the report JSON stay here.
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

    let outcome = stitch_tile(
        inputs,
        opts,
        strategy_report.clone(),
        |stage, _frac| {
            let label = match stage {
                0 => "decode",
                1 => "features",
                2 => "match_graph",
                3 => "refine",
                4 => "solve",
                5 => "composite",
                _ => "?",
            };
            eprintln!("pano[tile]: stage {label}");
        },
        || false,
    )
    .map_err(|e| e.to_string())?;

    let [decode_s, features_s, graph_s, refine_s, solve_s, composite_s] =
        outcome.stage_timings_s;

    eprintln!(
        "pano[tile]: refine — {} matches NCC-refined at full res, \
         {} kept proxy accuracy ({refine_s:.1}s)",
        outcome.refined_matches, outcome.fallback_matches,
    );
    if !outcome.orphans.is_empty() {
        eprintln!(
            "pano[tile]: placement — frame(s) {:?} disconnected from anchor, \
             reported as orphans (largest component stitched)",
            outcome.orphans
        );
    }
    eprintln!(
        "pano[tile]: solve — {} poses, {} orphan(s), canvas {}×{} ({solve_s:.1}s)",
        outcome.poses_placed,
        outcome.orphans.len(),
        outcome.tile_report.canvas.width,
        outcome.tile_report.canvas.height,
    );
    eprintln!(
        "pano[tile]: composite — {}×{}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
        outcome.image.width(),
        outcome.image.height(),
        outcome.mean_planar_residual_px,
        outcome.max_planar_residual_px,
    );

    let t_out = Instant::now();
    write_png16(outs_linear, &outcome.image, false)?;
    if let Some(display) = outs_display {
        write_png16(display, &outcome.image, true)?;
    }
    let write_s = t_out.elapsed().as_secs_f64();

    let report = tile_stitch_report(&TileReportContext {
        inputs,
        applied_opcodes: &outcome.applied_opcodes,
        strategy: &outcome.strategy_report,
        refined_matches: outcome.refined_matches,
        fallback_matches: outcome.fallback_matches,
        reverify: &outcome.reverify,
        tile_report: &outcome.tile_report,
        tile_orphans: &outcome.orphans,
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
        outcome.image.width(),
        outcome.image.height(),
        t0.elapsed().as_secs_f64()
    );
    Ok(report)
}
