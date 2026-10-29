//! The rotation-strategy tail (stages 3–5): full-resolution refinement →
//! bundle adjustment → leveling → photometry → tiled composite. Split from
//! `stitch/mod.rs` when the head became a reusable [`SolvedAlignment`]
//! (#4578): the tail reads only the alignment and the input paths, so a
//! fresh stitch and a stitch from a preview's alignment run the same code
//! over the same state.

use std::path::PathBuf;
use std::time::Instant;

use crate::ba::{self, BaOptions};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions, ProjectionMode};
use crate::composite::{CancellableSink, CanvasSink, CompositeReport};
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::robust::RobustOptions;

use super::alignment::SolvedAlignment;
use super::degenerate::reject_degenerate_canvas;
use super::frame_cache::refine_edges_lru;
use super::photometry::solve_kept_photometry;
use super::types::{StitchError, StitchOptions, StitchOutcome};
use super::{rotation_composite, seam_gate};

/// Run stages 3–5 of the rotation strategy from a solved alignment.
/// `head_timings` are the stage 0–2 wall times to report (zero when the
/// alignment was reused rather than solved by this call).
pub(super) fn rotation_tail(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    alignment: &SolvedAlignment,
    head_timings: [f64; 3],
    sink: &mut dyn CanvasSink,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<StitchOutcome, StitchError> {
    let mut graph = alignment.graph.clone();
    let match_graph = graph.summary();
    let full_images = alignment.full_images();
    let proxy_scales = alignment.proxy_scales();
    let strategy_report = alignment.strategy_report.clone();

    // ── stage 3: full-resolution NCC refinement + reverification ──────────
    //
    // #1254: 2-entry LRU decode cache — at most 2 full-resolution frames are
    // live simultaneously.
    let t3 = Instant::now();
    progress(3, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let refine_result = refine_edges_lru(
        &mut graph,
        inputs,
        &proxy_scales,
        &full_images,
        |frac| progress(3, frac),
        is_cancelled,
    )?;
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
    let horizon_tilt_rms_deg = leveled.then(|| leveling::horizon_tilt_rms_deg(&solution));
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
    let kept_cams: Vec<Camera> = kept_meta.iter().map(|(_, c, _)| c.clone()).collect();
    reject_degenerate_canvas(&kept_cams, &canvas_opts, &strategy_report, opts)?;

    let kept_inputs: Vec<usize> = kept_meta.iter().map(|(i, _, _)| *i).collect();
    let kept_paths: Vec<PathBuf> = kept_inputs.iter().map(|&i| inputs[i].clone()).collect();
    let kept_local: Vec<Option<LocalCorrection>> =
        kept_meta.iter().map(|(_, _, lc)| lc.clone()).collect();

    let canvas =
        auto_canvas(&kept_cams, &canvas_opts).map_err(|e| StitchError::Composite(e.to_string()))?;

    let (photometry, falloff) =
        solve_kept_photometry(&kept_paths, &kept_cams, &alignment.lenses, &kept_inputs)?;

    let seam_constraints = seam_gate::for_kept_frames(&opts.seam_constraints, &kept_inputs)?;
    let tiled_report = rotation_composite::composite(
        &kept_paths,
        &kept_cams,
        &photometry,
        &kept_local,
        &canvas,
        opts,
        &seam_constraints,
        &mut CancellableSink::new(sink, is_cancelled),
    )?;
    let comp_report = CompositeReport {
        falloff,
        ..tiled_report
    };

    let t_composite = t5.elapsed().as_secs_f64();
    progress(5, 1.0);

    Ok(StitchOutcome {
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
        match_graph,
        leveled,
        horizon_tilt_deg,
        horizon_tilt_rms_deg,
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
