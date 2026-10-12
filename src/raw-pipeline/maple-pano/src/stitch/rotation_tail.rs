//! The rotation-strategy tail (stages 3–5): full-resolution refinement →
//! bundle adjustment → leveling → gain → tiled composite. Split from
//! `stitch/mod.rs` when the head became a reusable [`SolvedAlignment`]
//! (#4578): the tail reads only the alignment and the input paths, so a
//! fresh stitch and a stitch from a preview's alignment run the same code
//! over the same state.

use std::path::PathBuf;
use std::time::Instant;

use crate::ba::{self, BaOptions};
use crate::camera::Camera;
use crate::canvas::{
    auto_canvas, natural_canvas_pixel_ratio, CanvasOptions, ProjectionMode, DEGENERATE_CANVAS_RATIO,
};
use crate::composite::composite_tiled;
use crate::gain::{solve_gains_streaming, GainOptions};
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::robust::RobustOptions;
use crate::strategy::StrategyRequest;

use super::alignment::SolvedAlignment;
use super::frame_cache::refine_edges_lru;
use super::types::{StitchError, StitchOptions, StitchOutcome};

/// Run stages 3–5 of the rotation strategy from a solved alignment.
/// `head_timings` are the stage 0–2 wall times to report (zero when the
/// alignment was reused rather than solved by this call).
pub(super) fn rotation_tail(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    alignment: &SolvedAlignment,
    head_timings: [f64; 3],
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<StitchOutcome, StitchError> {
    let mut graph = alignment.graph.clone();
    let full_images = alignment.full_images();
    let proxy_scales = alignment.proxy_scales();
    let strategy_report = alignment.strategy_report.clone();

    // ── stage 3: full-resolution NCC refinement + reverification ──────────
    //
    // #1254: 2-entry LRU decode cache — at most 2 full-resolution frames are
    // live simultaneously. The loop is factored into `frame_cache::refine_edges_lru`
    // to keep this file under the 600-LOC budget.
    let t3 = Instant::now();
    progress(3, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let refine_result =
        refine_edges_lru(&mut graph, inputs, &proxy_scales, &full_images, |frac| {
            progress(3, frac)
        })?;
    let (refined_matches, fallback_matches) = (
        refine_result.refined_matches,
        refine_result.fallback_matches,
    );

    let reverify = graph
        .reverify(&full_images, &RobustOptions::default())
        .map_err(|e| StitchError::Reverify(e.to_string()))?;
    let t_refine = t3.elapsed().as_secs_f64();
    progress(3, 1.0);

    // ── stage 4: bundle adjustment + leveling ─────────────────────────────
    let t4 = Instant::now();
    progress(4, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let mut solution = ba::solve(
        &full_images,
        &graph,
        &BaOptions {
            mean_budget_px: opts.mean_budget_px,
            max_budget_px: opts.max_budget_px,
            retention: opts.retention,
            local_align: opts.local_align,
            ..Default::default()
        },
    )
    .map_err(|e| StitchError::BaSolve(e.to_string()))?;
    let leveled = leveling::apply(&mut solution);
    let horizon_tilt_deg = leveled.then(|| leveling::horizon_tilt_deg(&solution));
    let t_solve = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    // ── stage 5: composite ─────────────────────────────────────────────────
    let t5 = Instant::now();
    progress(5, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }

    let local_corrections = solution.local_corrections.clone();

    let kept_meta: Vec<(usize, Camera, Option<LocalCorrection>)> = (0..alignment.frames.len())
        .zip(&solution.cameras)
        .zip(&solution.local_corrections)
        .filter_map(|((inp_idx, cam), lc)| cam.as_ref().map(|c| (inp_idx, c.clone(), lc.clone())))
        .collect();

    if kept_meta.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: kept_meta.len(),
            dropped: solution.dropped.clone(),
        });
    }

    let canvas_opts = CanvasOptions {
        projection: ProjectionMode::Auto,
        max_pixels: opts.max_canvas_px,
        ..Default::default()
    };

    // ── Degeneracy guard (must run BEFORE any composite allocation) ────────
    let kept_cams_guard: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
    check_degenerate(
        &kept_cams_guard,
        &canvas_opts,
        strategy_report.requested,
        opts.max_canvas_px,
    )?;

    // ── Gain solve: decode surviving frames on-demand, one at a time ───────
    //
    // #1254: the previous code cloned all surviving full-res frames into
    // `kept_frames_for_gain` — the dominant ~18 GB memory driver on pano_01.
    // Instead we decode each surviving frame, accumulate its overlap stats
    // into a partial-stats table, then drop the pixels before decoding the
    // next frame.  At most 1 full-resolution frame is resident at a time.
    //
    // `solve_gains` needs simultaneous access to all frames for its pairwise
    // sampling.  We instead call the streaming helper `solve_gains_streaming`
    // which accumulates overlap statistics frame-by-frame.
    let kept_paths: Vec<PathBuf> = kept_meta
        .iter()
        .map(|(inp_idx, _, _)| inputs[*inp_idx].clone())
        .collect();
    let kept_cams: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
    let kept_local: Vec<Option<LocalCorrection>> =
        kept_meta.iter().map(|(_, _, lc)| lc.clone()).collect();

    let canvas =
        auto_canvas(&kept_cams, &canvas_opts).map_err(|e| StitchError::Composite(e.to_string()))?;

    // Solve gains by decoding frames one at a time.
    // We use the streaming gain solve that accepts frames individually.
    let gains = solve_gains_streaming(&kept_paths, &kept_cams, &GainOptions::default())
        .map_err(|e| StitchError::Composite(e.to_string()))?;

    // ── Tiled composite (always engaged on this path — #1254) ─────────────
    //
    // `canvas_tile_rows` controls the strip height; when `None` we default
    // to 512 rows so the tiled path (and its memory bound of ≤1 full-res
    // frame resident per strip pass) always engages.
    let tile_rows = opts.canvas_tile_rows.unwrap_or(512);
    let (image, comp_report) = composite_tiled(
        &kept_paths,
        &kept_cams,
        &gains,
        &kept_local,
        &canvas,
        tile_rows,
        opts.seam_strategy,
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;

    let t_composite = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    Ok(StitchOutcome {
        image,
        comp_report,
        solution,
        local_corrections,
        strategy_report,
        focal_seed_source: alignment.focal_seed_source,
        applied_opcodes: alignment.applied_opcodes(),
        priors: alignment.priors(),
        refined_matches,
        fallback_matches,
        reverify,
        leveled,
        horizon_tilt_deg,
        stage_timings_s: [
            head_timings[0],
            head_timings[1],
            head_timings[2],
            t_refine,
            t_solve,
            t_composite,
        ],
    })
}

/// Fail fast, before any composite allocation, when the solved rotation
/// geometry is degenerate.
///
/// A *connected* near-parallel / translational set forced through the
/// rotation path produces a BA solution whose spherical projection spans a
/// huge angular extent — the natural (unclamped) canvas balloons to tens or
/// hundreds of GB. The max_canvas_px cap only bites *inside* composite(),
/// after that giant buffer (and the decoded frames) are already allocated —
/// which is how a nadir set ballooned to ~317 GB (#1267).
///
/// This is a *backstop*. A fully translational set whose frames don't
/// overlap rotationally (e.g. the pano_00 nadir set) disconnects in the
/// match graph and is rejected as TooFewSurvivors; `auto` routes such sets
/// to tile (#1271). This guard catches frames that DO connect but whose
/// rotation BA is degenerate enough to blow up the canvas.
///
/// Threshold = `DEGENERATE_CANVAS_RATIO` × `canvas_opts.max_pixels`
/// (#1269), single-sourced in `crate::canvas`. `stated_cap_px` is the cap
/// the operator set, quoted in the message (the preview scales the
/// effective cap to its own pixel density).
pub(super) fn check_degenerate(
    cameras: &[Camera],
    canvas_opts: &CanvasOptions,
    requested: StrategyRequest,
    stated_cap_px: usize,
) -> Result<(), StitchError> {
    let Some(ratio) = natural_canvas_pixel_ratio(cameras, canvas_opts) else {
        return Ok(());
    };
    if ratio <= DEGENERATE_CANVAS_RATIO {
        return Ok(());
    }
    // Auto chose rotation but the geometry is still degenerate: the frames
    // likely share a thin sliver of overlap or the matched region is mostly
    // planar. A forced rotation may simply not be a rotation pano.
    let hint = match requested {
        StrategyRequest::Auto => {
            "Auto selected Rotation, but the solved geometry is degenerate — \
             the frames may not form a true rotation panorama, or overlap is too \
             narrow for a reliable rotation solve. Try --strategy Tile, or \
             recapture with more overlap between frames."
        }
        _ => "try --strategy Auto or --strategy Tile",
    };
    Err(StitchError::DegenerateGeometry(format!(
        "natural canvas is {ratio:.0}× larger than the {mp} MP cap — \
         the rotation geometry is likely degenerate (near-parallel or \
         translational frames). {hint} \
         If this is a genuinely large panorama, raise --max-canvas-px.",
        mp = stated_cap_px as f64 / 1_000_000.0,
    )))
}
