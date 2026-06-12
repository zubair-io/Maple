//! Stage E — motion-tolerant frame gating (spec §8, #1216).
//!
//! Implements the "moving subjects in overlap" row of the stitching
//! spec's §8 failure-mode table: motion gets **no extra geometric
//! handling in v1** — the seam routes around it (#1179's half) and the
//! product warns ("Movement detected, some areas may show ghosting").
//! This module is the *don't-drop* half: the §5.3 acceptance gate
//! exists for MISALIGNMENT, and a frame whose static structure
//! registers tightly must not be dropped because water/foliage/people
//! in its overlaps moved between captures and inflated its residual
//! statistics.
//!
//! # The static-core discriminator
//!
//! A frame is **misaligned** when its residuals are systematically off
//! — no subset of its matches is tight. A frame is **motion-affected**
//! when a coherent static core registers tightly while a motion subset
//! is wild. For each frame failing the §5.3 budgets, its **static
//! core** is its matches minus those over the max budget in either
//! direction (exactly stage-D's exclusion rule). The frame is
//! reclassified `motion_affected` — kept, with its motion matches
//! pruned for real — iff ALL of:
//!
//! - **(a)** the core has ≥ [`MOTION_CORE_MIN_MATCHES`] matches (the
//!   spec §5.2 pair-acceptance floor) AND spans ≥ 2 verified edges when
//!   the frame has ≥ 2 (a single-edge core can be a coincidental fit);
//! - **(b)** the core's mean ≤ `mean_budget_px` and max ≤
//!   `max_budget_px` — the §5.3 budgets hold on the static remnant;
//! - **(c)** the cumulative excluded fraction of the frame's
//!   gate-round-start support is ≤ [`MOTION_MAX_FRACTION`] — beyond
//!   that the frame has too little static truth to pose reliably and
//!   drops with [`DropReason::MotionDominated`] instead.
//!
//! For qualifying frames the stage-D per-frame fraction guard is
//! waived: condition (b) is the stronger protection the guard
//! approximated. **Why this cannot mask misalignment:** a misaligned
//! frame's error is systematic — at the converged state it has no
//! ≥ 30-match tight core spanning multiple edges (its "tight" subset,
//! if any, is confined to whichever single edge the compromise solve
//! happened to favor), so it fails (a)/(b) and drops exactly as before.
//!
//! # Ordering inside one gate round
//!
//! 1. Stage-D fixed point (guard active) — mops up isolated outliers
//!    and post-prune residual nudges.
//! 2. No frame over budget → PASS.
//! 3. Any failing frame **motion-dominated** ((a)+(b) hold, (c) fails)
//!    → drop the worst-mean one FIRST. Dominated frames must leave
//!    before qualifiers prune, or their wild pairs — shared with
//!    qualifying neighbors that see the same moving water — would be
//!    pruned from the partner side and the dominated frame would end
//!    up posed on the sliver that (c) exists to forbid.
//! 4. Else any failing frame **qualifying** → prune the motion matches
//!    of all of them, re-solve once, and loop: misaligned-looking
//!    frames are re-judged against the cleaned solve before anything
//!    drops (the wild matches drag the solve, so prune-first maximizes
//!    honest rescue).
//! 5. Else every failing frame is misaligned → drop the worst-mean one
//!    with [`DropReason::HighResidual`], exactly as before this stage
//!    existed.
//!
//! The loop is bounded by [`MOTION_ROUNDS_MAX`] (each qualifying pass
//! prunes ≥ 1 pair — a frame can only qualify while it has over-budget
//! pairs — and (c) caps the cumulative shed, so the bound is a safety
//! net, not the terminator). Pruning never hollows a frame: a
//! non-qualifying endpoint always keeps its last pair, so the gate
//! still sees and judges the frame instead of silently passing a
//! zero-constraint pose.

use super::lm::{minimize, LmOptions};
use super::residual::{Block, FrameMeta, ParamLayout, State};
#[cfg(test)]
use super::support::frame_stats;
use super::support::{pairs_per_frame, prune_outlier_blocks, PRUNE_ROUNDS_MAX};
use super::types::{BaOptions, BaSolution, DropReason, FrameStats, RetentionPolicy};
use crate::local_align::{
    corrected_block_residual, fit_local_corrections, identity_corrections, stats_after_local,
    LocalCorrection,
};

/// Minimum static-core size — the spec §5.2 pair-acceptance floor (a
/// pairwise edge needs ≥ 30 verified inliers to exist at all; a pose
/// resting on fewer tight matches is below the evidence bar the rest
/// of the pipeline runs on).
pub(super) const MOTION_CORE_MIN_MATCHES: usize = 30;
/// Condition (c): ceiling on the cumulative over-budget (motion)
/// fraction of a frame's gate-round-start support. Beyond this the
/// frame is motion-dominated and drops with a distinct reason.
pub(super) const MOTION_MAX_FRACTION: f64 = 0.7;
/// Safety bound on prune-and-resolve motion iterations per gate round
/// (mirrors [`PRUNE_ROUNDS_MAX`]; see the module docs on termination).
pub(super) const MOTION_ROUNDS_MAX: usize = 8;

/// Per-gate-round motion bookkeeping, indexed by local frame. Reset
/// each round (blocks are rebuilt from the graph per round); only the
/// finalizing round's classification is reported.
pub(super) struct MotionBook {
    flagged: Vec<bool>,
    pruned: Vec<usize>,
}

impl MotionBook {
    pub(super) fn new(n_local: usize) -> Self {
        Self {
            flagged: vec![false; n_local],
            pruned: vec![0; n_local],
        }
    }

    /// Publish the round's classification into the solution:
    /// `motion_affected` + parallel pruned counts, restricted to frames
    /// that actually survived (`cameras[global]` set — a frame flagged
    /// early in the round can still drop later in the same round).
    pub(super) fn write_into(&self, solution: &mut BaSolution, round_active: &[usize]) {
        for (local, &global) in round_active.iter().enumerate() {
            if self.flagged[local] && solution.cameras[global].is_some() {
                solution.motion_affected.push(global);
                solution.motion_pruned_matches.push(self.pruned[local]);
            }
        }
    }
}

/// One failing frame's static-core measurement (module docs).
#[derive(Debug, Clone)]
struct CoreVerdict {
    local: usize,
    mean_px: f64,
    max_px: f64,
    /// (a) ∧ (b) ∧ (c): keep the frame, prune its motion matches.
    qualifies: bool,
    /// (a) ∧ (b) ∧ ¬(c): drop as [`DropReason::MotionDominated`].
    dominated: bool,
    core_matches: usize,
    core_mean_px: f64,
    motion_fraction: f64,
}

/// What the gate phase decided for this round.
pub(super) enum GateOutcome {
    /// Every surviving frame passes §5.3 on its (possibly
    /// motion-cleaned) stats; finalize on these.
    Pass { stats: Vec<FrameStats> },
    /// `local` must drop with `reason`; the caller re-solves the rest.
    Drop { local: usize, reason: DropReason },
}

/// Everything the gate phase needs from the enclosing solve round.
pub(super) struct GateContext<'a> {
    pub frames: &'a [FrameMeta],
    pub n_local: usize,
    pub gauge: usize,
    pub opts: &'a BaOptions,
    pub lm_opts: &'a LmOptions,
}

/// Stage D + Stage E for one gate round: bounded outlier pruning, then
/// the §5.3 gate with the spec §8 static-core discriminator (module
/// docs for the full ordering). Mutates `blocks`/`state` in place and
/// accounts LM work + prune counts into `solution`.
pub(super) fn gate_frames(
    blocks: &mut Vec<Block>,
    state: &mut State,
    ctx: &GateContext,
    solution: &mut BaSolution,
    book: &mut MotionBook,
) -> GateOutcome {
    let original_pairs = pairs_per_frame(blocks, ctx.n_local);
    let mut pruned_pairs = vec![0usize; ctx.n_local];

    for motion_round in 0..=MOTION_ROUNDS_MAX {
        // Stage D: bounded hard outlier rejection (guard active) — the
        // robust verifier admits the occasional confidently-wrong match
        // and Huber bounds its influence on the solve, but the §5.3
        // gate counts it raw. Re-run after every motion prune so a
        // handful of re-solve-nudged residuals never reach the
        // discriminator looking like "motion".
        for _ in 0..PRUNE_ROUNDS_MAX {
            let Some((retained, pruned)) = prune_outlier_blocks(
                blocks,
                ctx.frames,
                state,
                ctx.n_local,
                ctx.opts.max_budget_px,
                &original_pairs,
                &mut pruned_pairs,
            ) else {
                break;
            };
            solution.pruned_matches += pruned;
            *blocks = retained;
            resolve(blocks, state, ctx, solution);
        }

        // Stage F (#1218, spec §8): fit per-frame local corrections and use
        // corrected stats to decide which frames are truly failing.  The fit
        // runs on every motion_round so that after motion pruning + re-solve
        // the parallax-floor frames remain correctly classified as passing.
        // The corrections do NOT feed back into the optimiser — only the
        // corrected residual stats are used for pass/fail decisions.
        let corrections = if ctx.opts.local_align {
            fit_local_corrections(blocks, ctx.frames, state, ctx.n_local, ctx.opts.max_budget_px)
        } else {
            identity_corrections(ctx.frames, ctx.n_local)
        };
        let corrected = stats_after_local(blocks, ctx.frames, state, &corrections, ctx.n_local);

        let failing: Vec<usize> = (0..ctx.n_local)
            .filter(|&f| {
                corrected[f].blocks > 0
                    && (corrected[f].mean_px > ctx.opts.mean_budget_px
                        || corrected[f].max_px > ctx.opts.max_budget_px)
            })
            .collect();

        if failing.is_empty() {
            // All frames pass on corrected stats — stage F absorbed
            // the parallax floor.  Return corrected stats as the
            // end-of-chain measurement (spec §5.3 / #1218).
            return GateOutcome::Pass { stats: corrected };
        }

        let effective_stats = corrected;

        // Stage E: the static-core discriminator.  Use corrected stats so
        // frames whose parallax was absorbed by stage F are not visible to
        // the motion discriminator (they are not in `failing`).
        let verdicts = classify_cores(
            blocks,
            state,
            ctx,
            &corrections,
            &failing,
            &effective_stats,
            &original_pairs,
            &pruned_pairs,
        );

        // Condition (c) is a drop criterion only under Strict retention:
        // a dominated frame's pose is still certified by (a)+(b), and the
        // product policy (spec §8) keeps every posable photo — the wild
        // majority of its support is pruned and seam-routed like any
        // other non-rigid content, with the warning carrying the
        // evidence. Strict mode preserves the conservative drop.
        if ctx.opts.retention == RetentionPolicy::Strict {
            if let Some(v) = worst_mean(&verdicts, |v| v.dominated) {
                return GateOutcome::Drop {
                    local: v.local,
                    reason: DropReason::MotionDominated {
                        core_mean_px: v.core_mean_px,
                        core_matches: v.core_matches,
                        motion_fraction: v.motion_fraction,
                    },
                };
            }
        }

        let keep_dominated = ctx.opts.retention == RetentionPolicy::KeepAlignable;
        let qualifying = {
            let mut q = vec![false; ctx.n_local];
            for v in verdicts
                .iter()
                .filter(|v| v.qualifies || (keep_dominated && v.dominated))
            {
                q[v.local] = true;
            }
            q
        };
        let any_qualifying = qualifying.iter().any(|&x| x);
        if !any_qualifying || motion_round == MOTION_ROUNDS_MAX {
            // No motion path left (or the safety bound hit): worst-mean
            // failing frame drops on its raw stats, as before stage E.
            let v = worst_mean(&verdicts, |_| true).expect("failing is non-empty");
            return GateOutcome::Drop {
                local: v.local,
                reason: DropReason::HighResidual {
                    mean_px: v.mean_px,
                    max_px: v.max_px,
                },
            };
        }

        match prune_motion_blocks(
            blocks,
            state,
            ctx,
            &corrections,
            &qualifying,
            &mut pruned_pairs,
            book,
        ) {
            Some(retained) => {
                *blocks = retained;
                for (local, &q) in qualifying.iter().enumerate() {
                    if q {
                        book.flagged[local] = true;
                    }
                }
                resolve(blocks, state, ctx, solution);
            }
            // Unreachable by construction (a qualifying frame has ≥ 1
            // over-budget pair — see the module docs), kept as an
            // honest fallback: no progress possible ⇒ gate as before.
            None => {
                let v = worst_mean(&verdicts, |_| true).expect("failing is non-empty");
                return GateOutcome::Drop {
                    local: v.local,
                    reason: DropReason::HighResidual {
                        mean_px: v.mean_px,
                        max_px: v.max_px,
                    },
                };
            }
        }
    }
    unreachable!("the final motion round returns Pass or Drop")
}

/// Warm-started joint re-solve after a prune (same layout stage D used:
/// full joint with whatever focals stage C freed).
fn resolve(blocks: &[Block], state: &mut State, ctx: &GateContext, solution: &mut BaSolution) {
    let freed: Vec<usize> = (0..ctx.n_local)
        .filter(|&f| state.focal_overrides[f].is_some())
        .collect();
    let layout = ParamLayout::full(ctx.n_local, ctx.gauge, &freed);
    let run = minimize(
        blocks,
        ctx.frames,
        state,
        &layout,
        ctx.opts.huber_delta_px,
        ctx.lm_opts,
    );
    solution.lm_iterations += run.iterations;
    solution.converged &= run.converged;
    solution.final_cost = run.final_cost;
}

/// The worst-mean verdict among those matching `pred`, by raw frame
/// mean — preserves the pre-existing "worst mean first" drop ordering.
fn worst_mean(
    verdicts: &[CoreVerdict],
    pred: impl Fn(&CoreVerdict) -> bool,
) -> Option<&CoreVerdict> {
    verdicts
        .iter()
        .filter(|v| pred(v))
        .max_by(|x, y| x.mean_px.total_cmp(&y.mean_px))
}

/// Measure every failing frame's static core at the current state.
///
/// Core membership uses stage-D's exclusion rule (a pair is excluded
/// when its residual exceeds the max budget in EITHER direction); core
/// statistics are measured in the frame's own pixel plane, matching
/// [`frame_stats`]. Condition (c)'s numerator is cumulative over the
/// gate round (`pruned_pairs` — every over-budget pair the frame
/// already lost to stage D or earlier motion passes, whichever plane
/// was wild), denominated in the round-start support.
fn classify_cores(
    blocks: &[Block],
    state: &State,
    ctx: &GateContext,
    corrections: &[LocalCorrection],
    failing: &[usize],
    stats: &[FrameStats],
    original_pairs: &[usize],
    pruned_pairs: &[usize],
) -> Vec<CoreVerdict> {
    let mut is_failing = vec![false; ctx.n_local];
    for &f in failing {
        is_failing[f] = true;
    }

    #[derive(Default, Clone)]
    struct Accum {
        core_sum: f64,
        core_max: f64,
        core_n: usize,
        excluded_n: usize,
        core_partners: std::collections::BTreeSet<usize>,
        all_partners: std::collections::BTreeSet<usize>,
    }
    let mut accum: Vec<Accum> = vec![Accum::default(); ctx.n_local];

    debug_assert_eq!(blocks.len() % 2, 0, "blocks come in directed pairs");
    for pair in blocks.chunks_exact(2) {
        let (fwd, rev) = (&pair[0], &pair[1]);
        debug_assert_eq!((fwd.src, fwd.dst), (rev.dst, rev.src));
        if !is_failing[fwd.src] && !is_failing[fwd.dst] {
            continue;
        }
        let s_fwd = corrected_block_residual(state, ctx.frames, corrections, fwd);
        let s_rev = corrected_block_residual(state, ctx.frames, corrections, rev);
        let over = s_fwd > ctx.opts.max_budget_px || s_rev > ctx.opts.max_budget_px;
        // (frame, its-plane residual, partner) views of this pair.
        for (frame, s_own, partner) in [(fwd.dst, s_fwd, fwd.src), (rev.dst, s_rev, rev.src)] {
            if !is_failing[frame] {
                continue;
            }
            let a = &mut accum[frame];
            a.all_partners.insert(partner);
            if over {
                a.excluded_n += 1;
            } else {
                a.core_sum += s_own;
                a.core_max = a.core_max.max(s_own);
                a.core_n += 1;
                a.core_partners.insert(partner);
            }
        }
    }

    failing
        .iter()
        .map(|&f| {
            let a = &accum[f];
            let core_mean = if a.core_n > 0 {
                a.core_sum / a.core_n as f64
            } else {
                f64::INFINITY
            };
            let cond_a = a.core_n >= MOTION_CORE_MIN_MATCHES
                && (a.all_partners.len() < 2 || a.core_partners.len() >= 2);
            let cond_b =
                core_mean <= ctx.opts.mean_budget_px && a.core_max <= ctx.opts.max_budget_px;
            let cumulative_excluded = pruned_pairs[f] + a.excluded_n;
            let motion_fraction = if original_pairs[f] > 0 {
                cumulative_excluded as f64 / original_pairs[f] as f64
            } else {
                1.0
            };
            let cond_c = motion_fraction <= MOTION_MAX_FRACTION;
            CoreVerdict {
                local: f,
                mean_px: stats[f].mean_px,
                max_px: stats[f].max_px,
                qualifies: cond_a && cond_b && cond_c,
                dominated: cond_a && cond_b && !cond_c,
                core_matches: a.core_n,
                core_mean_px: core_mean,
                motion_fraction,
            }
        })
        .collect()
}

/// Prune the motion matches of the qualifying frames: every pair over
/// the max budget in either direction that touches a qualifying frame,
/// with the stage-D fraction guard WAIVED (condition (b) is the
/// stronger protection) — except that a non-qualifying endpoint always
/// keeps its last pair (never hollow a frame the gate still has to
/// judge; the kept pair is over budget, so the frame fails the max
/// gate and is handled honestly next iteration).
///
/// Updates the round-cumulative `pruned_pairs` for both endpoints (it
/// feeds the stage-D guard and condition (c)) and the qualifying
/// endpoints' [`MotionBook`] pruned counts. Returns the retained
/// blocks, or `None` when nothing qualified for pruning.
fn prune_motion_blocks(
    blocks: &[Block],
    state: &State,
    ctx: &GateContext,
    corrections: &[LocalCorrection],
    qualifying: &[bool],
    pruned_pairs: &mut [usize],
    book: &mut MotionBook,
) -> Option<Vec<Block>> {
    debug_assert_eq!(blocks.len() % 2, 0, "blocks come in directed pairs");
    let mut remaining = pairs_per_frame(blocks, ctx.n_local);
    let mut retained = Vec::with_capacity(blocks.len());
    let mut pruned = 0usize;
    for pair in blocks.chunks_exact(2) {
        let (fwd, rev) = (&pair[0], &pair[1]);
        let over = corrected_block_residual(state, ctx.frames, corrections, fwd)
            > ctx.opts.max_budget_px
            || corrected_block_residual(state, ctx.frames, corrections, rev)
                > ctx.opts.max_budget_px;
        let touches_qualifying = qualifying[fwd.src] || qualifying[fwd.dst];
        let hollows = [fwd.src, fwd.dst]
            .iter()
            .any(|&e| !qualifying[e] && remaining[e] <= 1);
        if over && touches_qualifying && !hollows {
            pruned += 1;
            for e in [fwd.src, fwd.dst] {
                remaining[e] -= 1;
                pruned_pairs[e] += 1;
                if qualifying[e] {
                    book.pruned[e] += 1;
                }
            }
        } else {
            retained.push(*fwd);
            retained.push(*rev);
        }
    }
    (pruned > 0).then_some(retained)
}

#[cfg(test)]
mod tests;
