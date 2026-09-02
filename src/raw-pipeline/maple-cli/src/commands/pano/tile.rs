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

use maple_pano::render::PngMetadata;
use maple_pano::stitch::TileStitchOutcome;

use super::io::{tile_stitch_report, write_png16, TileReportContext};

// ─── Primary entry point: outcome already computed ────────────────────────────

/// Arguments for [`run_tile_from_outcome`].
///
/// Called by `stitch_set` when [`maple_pano::stitch::stitch`] returned
/// `StitchSuccess::Tile` — the tile pipeline already ran inside `stitch`
/// (with shared ALIKED + LightGlue from #1270). This function only owns
/// the I/O tail (PNG write + JSON report assembly).
pub(super) struct TileOutcomeArgs<'a> {
    pub outcome: TileStitchOutcome,
    pub outs_linear: &'a Path,
    pub outs_display: Option<&'a Path>,
    pub outs_report: Option<&'a Path>,
    pub inputs: &'a [PathBuf],
    /// PNG metadata (EXIF blob + sRGB tag) pre-computed BEFORE stitch() ran
    /// so that this write phase does not re-read any source RAW at peak RSS
    /// (#1349 fix). `None` iff `outs_display` is `None`.
    pub display_meta: Option<PngMetadata>,
    pub t0: Instant,
}

/// Write outputs for a tile stitch that already ran inside `stitch()` (#1270).
///
/// After the unified pipeline the tile outcome arrives pre-computed;
/// this function only handles the PNG writes and JSON report assembly that
/// `stitch_set` can't do generically.
pub(super) fn run_tile_from_outcome(
    args: TileOutcomeArgs<'_>,
) -> Result<serde_json::Value, String> {
    let TileOutcomeArgs {
        outcome,
        outs_linear,
        outs_display,
        outs_report,
        inputs,
        display_meta,
        t0,
    } = args;

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
        "pano[tile]: composite — {}×{}, mean planar {:.3}px, max {:.3}px ({composite_s:.1}s)",
        outcome.image.width(),
        outcome.image.height(),
        outcome.mean_planar_residual_px,
        outcome.max_planar_residual_px,
    );

    let t_out = Instant::now();
    write_png16(outs_linear, &outcome.image, false)?;
    if let Some(display) = outs_display {
        // Finished, display-referred sRGB (#1335): AgX view tail like a RAW
        // render. develop_for_display returns the encoded 16-bit buffer
        // directly → write it straight out (no re-quantize).
        let data = maple_pano::stitch::develop_for_display(&outcome.image);
        // EXIF + sRGB tag were computed BEFORE stitch() to avoid re-reading
        // the source RAW at peak RSS (#1349 fix).
        let meta = display_meta.expect("display_meta is Some when outs_display is Some");
        maple_pano::render::write_frame_png(
            display,
            outcome.image.width(),
            outcome.image.height(),
            &data,
            &meta,
        )
        .map_err(|e| format!("{}: {e}", display.display()))?;
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
