//! Global bundle adjustment (M1b, #1154 — spec §5.3).
//!
//! Refines all camera rotations plus shared intrinsics (focal, k1, k2)
//! by minimizing the symmetric reprojection error over **all verified
//! inlier correspondences in the match graph**, with a Huber loss
//! (δ = 2 px). State per spec/eng-design §5: per-image axis-angle
//! (3·N) + shared focal + k1 + k2, extended with per-image focals where
//! the decision-§9.2 fallback triggers ([`fallback`]).
//!
//! # Solver choice (decision §9.1 — documented here as required)
//!
//! Levenberg–Marquardt with **analytic Jacobians**
//! ([`residual`]), residual/Jacobian evaluation **rayon-parallel**, and
//! the normal equations solved by an **in-tree dense Cholesky**
//! ([`linalg`]). Spec §9.1 names `argmin` as the no-Ceres solver; this
//! implementation honors the same intent one step further: the state is
//! ≤ ~500 parameters even at 150 cameras (3·N + 3), the cost is entirely
//! residual evaluation, and an external LM framework would contribute
//! nothing but a dependency tree to vendor. The crate already hand-rolls
//! its linear algebra ([`crate::math`], [`crate::eigen`]) under a
//! zero-dep policy; the LM loop ([`lm`]) is ~100 lines next to them. The
//! §9.1 convergence-basin benchmark gates this choice in CI (perturbed
//! inits 5–15° must reach the same minimum — `tests/basin_bench.rs`).
//!
//! # Gauge
//!
//! A pure-rotation BA cost is invariant under one global rotation of all
//! cameras. The gauge is fixed by **freezing the first frame of the
//! active component** (smallest image index — also the spanning-tree
//! root) at its initialization value; its 3 rotation parameters never
//! enter the state. The absolute orientation of the result is therefore
//! the init's (prior-aligned when gimbal priors exist —
//! [`init::align_gauge_to_priors`]); [`crate::leveling`] corrects the
//! up-vector afterwards.
//!
//! # Two-stage schedule
//!
//! Each fresh solve runs **stage A** (rotations only, intrinsics frozen
//! at their seed) and then **stage B** (joint). Far-from-init rotations
//! (the basin bench's 5–15° perturbations) otherwise let the early,
//! wildly wrong residuals push focal/distortion off before the
//! rotations settle; freezing intrinsics first costs a handful of cheap
//! iterations and makes the basin boundary a rotation-only question.
//!
//! # Acceptance gates (spec §5.3) + motion tolerance (spec §8)
//!
//! After convergence every frame's residuals (measured in its own pixel
//! plane) are summarized as [`FrameStats`]; frames violating
//! `mean ≤ mean_budget_px` / `max ≤ max_budget_px` (defaults 1.5 / 6)
//! are **dropped and reported** ([`DropReason::HighResidual`]), worst
//! mean first, and the remaining set is re-solved (warm start) until
//! every surviving frame passes. The §5.3 gate exists for
//! MISALIGNMENT; per spec §8's moving-subjects row, a failing frame
//! whose **static core** still registers tightly is instead
//! reclassified motion-affected — its motion matches are pruned, the
//! frame is KEPT, and the product warns about possible ghosting
//! ([`motion`] has the discriminator, the keep/drop conditions, and
//! why it cannot mask misalignment). Images outside the graph's
//! largest component were never solvable and are reported as
//! [`DropReason::Disconnected`] (consuming [`MatchGraph::orphans`] —
//! "stitch the largest component and report the orphans").

pub mod focal;
pub mod init;
pub mod linalg;

mod lm;
// pub(crate): `local_align` accesses Block/FrameMeta/State/eval_residual
// directly from `crate::ba::residual` (#1218, spec §8).  The module stays
// private to external crates.
pub(crate) mod residual;

use crate::graph::{GraphImage, MatchGraph};
use crate::local_align::fit_local_corrections;
use crate::math::Mat3;
use lm::{minimize, LmOptions};
use residual::{FrameMeta, ParamLayout, State};

mod motion;
mod support;
mod types;

use motion::{gate_frames, GateContext, GateOutcome, MotionBook};
use support::{
    build_blocks, finalize, finalize_trivial, focal_fallback, largest_subcomponent, median,
};
pub use types::{
    BaError, BaOptions, BaSolution, DropReason, DroppedFrame, FrameStats, RetentionPolicy,
};

/// Bounded convergence polish: how many times a single logical solve
/// (stage B, gate re-solves) may repeat its LM iteration budget while
/// unconverged. Sized so the worst case stays well under a second of
/// LM work at pano scale.
pub(crate) const SOLVE_POLISH_MAX: usize = 5;

/// Global bundle adjustment over a verified match graph.
///
/// `images` is the same list the graph was built from: the cameras'
/// intrinsics are the seed (focal from EXIF via
/// [`init::focal_seed_px`]-shaped priors or an assumed FOV; k1/k2
/// usually 0), poses are ignored, and `prior_rotation` — when present —
/// gauge-aligns the initialization ([`init`]). See the module docs for
/// the solver, gauge, staging, and gate semantics.
pub fn solve(
    images: &[GraphImage],
    graph: &MatchGraph,
    opts: &BaOptions,
) -> Result<BaSolution, BaError> {
    if images.len() != graph.image_count {
        return Err(BaError::ImageCountMismatch {
            images: images.len(),
            graph: graph.image_count,
        });
    }
    if let Some(init) = &opts.initial_rotations {
        if init.len() != images.len() {
            return Err(BaError::InitialRotationsLength {
                given: init.len(),
                expected: images.len(),
            });
        }
    }

    let mut dropped: Vec<DroppedFrame> = graph
        .orphans
        .iter()
        .map(|&index| DroppedFrame {
            index,
            reason: DropReason::Disconnected,
        })
        .collect();
    let mut active: Vec<usize> = graph.components.first().cloned().unwrap_or_default();

    // Seeds: median over the active frames' camera intrinsics.
    let focal_seed = median(active.iter().map(|&i| images[i].camera.focal_px)).unwrap_or(1.0);
    let k1_seed = median(active.iter().map(|&i| images[i].camera.k1)).unwrap_or(0.0);
    let k2_seed = median(active.iter().map(|&i| images[i].camera.k2)).unwrap_or(0.0);

    // Initialization: spanning tree, prior gauge alignment, warm-start
    // overrides (in that order — later wins).
    let mut rotations: Vec<Option<Mat3>> = init::spanning_tree_rotations(graph);
    let priors: Vec<Option<Mat3>> = images.iter().map(|img| img.prior_rotation).collect();
    init::align_gauge_to_priors(&mut rotations, &priors);
    if let Some(overrides) = &opts.initial_rotations {
        for (slot, over) in rotations.iter_mut().zip(overrides) {
            if let Some(r) = over {
                *slot = Some(*r);
            }
        }
    }

    let lm_opts = LmOptions {
        max_iterations: opts.max_lm_iterations,
        cost_rel_tol: opts.cost_rel_tol,
        ..LmOptions::default()
    };

    let n_images = images.len();
    let mut solution = BaSolution {
        cameras: vec![None; n_images],
        shared_focal_px: focal_seed,
        k1: k1_seed,
        k2: k2_seed,
        frame_stats: vec![None; n_images],
        dropped: Vec::new(),
        mean_reproj_px: 0.0,
        max_reproj_px: 0.0,
        mean_reproj_before_local_px: 0.0,
        max_reproj_before_local_px: 0.0,
        lm_iterations: 0,
        final_cost: 0.0,
        converged: true,
        solve_rounds: 0,
        pruned_matches: 0,
        motion_affected: Vec::new(),
        motion_pruned_matches: Vec::new(),
        local_corrections: vec![None; n_images],
        local_correction_rms: vec![0.0; n_images],
    };

    let mut state = State {
        rotations: Vec::new(),
        shared_focal: focal_seed,
        focal_overrides: Vec::new(),
        k1: k1_seed,
        k2: k2_seed,
    };
    let mut first_round = true;
    let mut fallback_probed = false;

    loop {
        solution.solve_rounds += 1;

        // Local subproblem over the active frames.
        let mut local_of = vec![usize::MAX; images.len()];
        for (local, &global) in active.iter().enumerate() {
            local_of[global] = local;
        }
        let frames: Vec<FrameMeta> = active
            .iter()
            .map(|&g| {
                let (cx, cy) = images[g].camera.principal_point();
                FrameMeta { cx, cy }
            })
            .collect();
        let mut blocks = build_blocks(graph, &local_of);
        state.rotations = active
            .iter()
            .map(|&g| rotations[g].expect("active frames are initialized"))
            .collect();
        state.focal_overrides = vec![None; active.len()];

        let gauge = 0; // Local index of the smallest active image index.
        if first_round {
            // Stage A: rotations only, intrinsics frozen at the seed —
            // graduated non-convexity. Far inits (the §9.1 basin bench
            // perturbs 5–15° ≈ hundreds of px) sit deep in the Huber
            // linear regime where a δ=2 px landscape folds into twist
            // minima; widening δ first makes the far field quadratic and
            // walks the rotations home, then the tight δ restores
            // outlier robustness. Final accuracy is set by Stage B.
            let layout_a = ParamLayout::rotations_only(active.len(), gauge);
            for delta_scale in [32.0, 8.0, 1.0] {
                let a = minimize(
                    &blocks,
                    &frames,
                    &mut state,
                    &layout_a,
                    opts.huber_delta_px * delta_scale,
                    &lm_opts,
                );
                solution.lm_iterations += a.iterations;
                solution.converged &= a.converged;
            }
        }
        // Stage B: joint rotations + shared focal + k1 + k2, iterated
        // to convergence (bounded). One per-call iteration budget was
        // sized for the drop-loop era where every drop re-entered the
        // solve; under keep retention there is exactly one gate round,
        // so B must converge on its own.
        let layout_b = ParamLayout::full(active.len(), gauge, &[]);
        let mut b_converged = false;
        for _ in 0..SOLVE_POLISH_MAX {
            let b = minimize(
                &blocks,
                &frames,
                &mut state,
                &layout_b,
                opts.huber_delta_px,
                &lm_opts,
            );
            solution.lm_iterations += b.iterations;
            solution.final_cost = b.final_cost;
            if b.converged {
                b_converged = true;
                break;
            }
        }
        solution.converged &= b_converged;
        first_round = false;

        // Stage C (decision §9.2, once per solve): cohort-outlier frames
        // get their focals tested by a joint re-solve; a freed focal is
        // kept only when it moves materially off the shared value AND
        // rescues its frame to within the acceptance budget. Shared focal
        // stays the regularizer for everything else; frames whose problem
        // is not focal fall through to the gate below. See
        // `support::focal_fallback` for the full decision rule.
        if !fallback_probed {
            fallback_probed = true;
            if let Some(stage_c) = focal_fallback(
                &blocks,
                &frames,
                &mut state,
                active.len(),
                gauge,
                opts,
                &lm_opts,
            ) {
                solution.lm_iterations += stage_c.iterations;
                solution.converged &= stage_c.converged;
                solution.final_cost = stage_c.final_cost;
            }
        }

        // Stages D + E + F: bounded hard outlier rejection, then the
        // §5.3 acceptance gate with the spec §8 static-core
        // discriminator, with stage-F corrections re-fit every gate
        // round and the CORRECTED stats deciding pass/fail (end-of-chain
        // measurement). The optimiser itself still runs on the original
        // blocks — feeding it corrected blocks would absorb the
        // correction into the rotations, undoing it. The fit below is a
        // re-fit on the final block set purely to STORE the fields for
        // composite time.
        let n_local = active.len();
        let mut book = MotionBook::new(active.len());
        let outcome = gate_frames(
            &mut blocks,
            &mut state,
            &GateContext {
                frames: &frames,
                n_local: active.len(),
                gauge,
                opts,
                lm_opts: &lm_opts,
            },
            &mut solution,
            &mut book,
        );

        // Persist the round's rotations (the warm start for re-solves).
        for (local, &global) in active.iter().enumerate() {
            rotations[global] = Some(state.rotations[local]);
        }

        let (bad_local, reason) = match outcome {
            GateOutcome::Pass {
                stats: corrected_stats,
            } => {
                // gate_frames returned corrected stats (stage F was applied
                // inside the gate's pass check — spec §8 / #1218).
                // corrected_stats is the end-of-chain measurement.

                // Pre-local: raw global mean/max for auditability.
                {
                    use residual::{eval_residual, INVALID_BLOCK_RESIDUAL_PX};
                    let (mut sum, mut max, mut count) = (0.0_f64, 0.0_f64, 0usize);
                    for b in &blocks {
                        let s = match eval_residual(&state, &frames, b) {
                            Some(r) => (r[0] * r[0] + r[1] * r[1]).sqrt(),
                            None => INVALID_BLOCK_RESIDUAL_PX,
                        };
                        sum += s;
                        if s > max {
                            max = s;
                        }
                        count += 1;
                    }
                    solution.mean_reproj_before_local_px =
                        if count > 0 { sum / count as f64 } else { 0.0 };
                    solution.max_reproj_before_local_px = max;
                }

                // Re-fit corrections on the final post-gate block set to
                // store the `LocalCorrection` objects for composite time.
                // (gate_frames computed them internally for pass/fail but
                // doesn't expose them — this second fit is cheap and
                // deterministic from the same blocks+state.)
                let corrections_local = if opts.local_align {
                    fit_local_corrections(&blocks, &frames, &state, n_local)
                } else {
                    crate::local_align::identity_corrections(&frames, n_local)
                };

                // Global corrected mean/max for the solution summary.
                use crate::local_align::global_stats_after_local;
                let (mean_after, max_after) =
                    global_stats_after_local(&blocks, &frames, &state, &corrections_local);

                // Finalize with corrected per-frame stats (end-of-chain,
                // spec §5.3 / #1218).
                finalize(
                    &mut solution,
                    images,
                    &active,
                    &state,
                    &corrected_stats,
                    &blocks,
                    &frames,
                );
                solution.mean_reproj_px = mean_after;
                solution.max_reproj_px = max_after;

                // Store per-frame local corrections (global indices).
                for (local, &global) in active.iter().enumerate() {
                    let c = &corrections_local[local];
                    // Store only corrections that actually move pixels:
                    // identity fits (no signal, or refused by the
                    // envelope) stay `None` so the doc'd invariant
                    // "`Some` always warps" holds.
                    if c.fit_blocks > 0 && c.rms_px > 0.0 {
                        solution.local_corrections[global] = Some(c.clone());
                        solution.local_correction_rms[global] = c.rms_px;
                    }
                }
                book.write_into(&mut solution, &active);
                solution.dropped.append(&mut dropped);
                solution.dropped.sort_by_key(|d| d.index);
                return Ok(solution);
            }
            GateOutcome::Drop { local, reason } => (local, reason),
        };

        let bad_global = active[bad_local];
        dropped.push(DroppedFrame {
            index: bad_global,
            reason,
        });
        // This round's local → global map, for the trivial finalizers'
        // motion bookkeeping (write_into skips non-survivors itself).
        let round_active = active.clone();
        active.retain(|&g| g != bad_global);

        if round_active.len() <= 2 {
            // Dropping below two frames leaves nothing to adjust: report
            // the violator and finalize with what passes.
            finalize_trivial(&mut solution, images, &active, &rotations, &state);
            book.write_into(&mut solution, &round_active);
            solution.dropped.append(&mut dropped);
            solution.dropped.sort_by_key(|d| d.index);
            return Ok(solution);
        }

        // Re-derive connectivity among the survivors — a drop can split
        // the component, and split-off frames are Disconnected.
        let (largest, disconnected) = largest_subcomponent(graph, &active);
        for index in disconnected {
            dropped.push(DroppedFrame {
                index,
                reason: DropReason::Disconnected,
            });
        }
        active = largest;
        if active.len() < 2 {
            finalize_trivial(&mut solution, images, &active, &rotations, &state);
            book.write_into(&mut solution, &round_active);
            solution.dropped.append(&mut dropped);
            solution.dropped.sort_by_key(|d| d.index);
            return Ok(solution);
        }
    }
}
