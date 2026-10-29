//! Tile-strategy CLI driver for `pano stitch` (spec §8, ticket #1226).
//! Split from `pano/mod.rs` for the file-size budget.
//!
//! After the #1270 refactor this module exposes a single entry point:
//! [`run_tile_from_outcome`], which accepts a [`TileStitchOutcome`] that
//! `stitch()` already computed (stages 0–5 ran inside the unified pipeline,
//! sharing ALIKED + LightGlue inference with the rotation path). This
//! function only handles the I/O tail: PNG writes and JSON report assembly.
//! `run_tile_from_paths` was removed in the #1270 refactor.

use std::path::{Path, PathBuf};
use std::time::Instant;

use maple_pano::stitch::TileStitchOutcome;

use super::io::{tile_stitch_report, TileReportContext};

// ─── Primary entry point: outcome already computed ────────────────────────────

/// Arguments for [`run_tile_from_outcome`].
///
/// Called by `stitch_set` when [`maple_pano::stitch::stitch`] returned
/// `StitchSuccess::Tile` — the tile pipeline already ran inside `stitch`
/// (with shared ALIKED + LightGlue from #1270). This function only owns
/// the report tail; the PNGs streamed out during the composite (#5452).
pub(super) struct TileOutcomeArgs<'a> {
    pub outcome: TileStitchOutcome,
    /// The PNG reported as written: the display PNG when one was asked for.
    pub written: &'a Path,
    pub inputs: &'a [PathBuf],
    /// Seconds spent closing the streamed PNGs after the composite.
    pub write_s: f64,
    pub t0: Instant,
}

/// Write outputs for a tile stitch that already ran inside `stitch()` (#1270).
///
/// After the unified pipeline the tile outcome arrives pre-computed;
/// this function only handles the logging and JSON report assembly that
/// `stitch_set` can't do generically.
pub(super) fn run_tile_from_outcome(
    args: TileOutcomeArgs<'_>,
) -> Result<serde_json::Value, String> {
    let TileOutcomeArgs {
        outcome,
        written,
        inputs,
        write_s,
        t0,
    } = args;
    let (width, height) = (
        outcome.tile_report.canvas.width,
        outcome.tile_report.canvas.height,
    );

    let [decode_s, features_s, graph_s, refine_s, solve_s, composite_s] = outcome.stage_timings_s;

    eprintln!(
        "pano: strategy — selected=tile tile_votes={} rotation_votes={}{}",
        outcome.strategy_report.evidence.tile_votes,
        outcome.strategy_report.evidence.rotation_votes,
        outcome
            .strategy_report
            .warning
            .map(|w| format!(" [WARN: {w}]"))
            .unwrap_or_default(),
    );
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
        "pano[tile]: composite — {width}×{height}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
        outcome.mean_planar_residual_px,
        outcome.max_planar_residual_px,
    );

    let report = tile_stitch_report(&TileReportContext {
        inputs,
        applied_opcodes: &outcome.applied_opcodes,
        strategy: &outcome.strategy_report,
        refined_matches: outcome.refined_matches,
        fallback_matches: outcome.fallback_matches,
        reverify: &outcome.reverify,
        match_graph: &outcome.match_graph,
        tile_report: &outcome.tile_report,
        tile_orphans: &outcome.orphans,
        focal_seed_source: outcome.focal_seed_source.map(|s| s.as_str()),
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
    eprintln!(
        "pano[tile]: wrote {} ({width}x{height}) in {:.1}s",
        written.display(),
        t0.elapsed().as_secs_f64()
    );
    Ok(report)
}
