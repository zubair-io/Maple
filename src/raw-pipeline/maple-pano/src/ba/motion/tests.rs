//! Unit tests for the spec §8 static-core discriminator — split
//! from `motion/mod.rs` for the file-size budget.

use super::*;
use crate::local_align::identity_corrections;
use crate::math::Mat3;

/// Identity-rotation two-frame state: with k1 = k2 = 0, equal
/// focals, and shared principal points, projecting `p_src` into the
/// destination is the identity map, so a block's residual is
/// exactly `p_dst − p_src`.
fn flat_state(n: usize) -> (State, Vec<FrameMeta>) {
    let state = State {
        rotations: vec![Mat3::identity(); n],
        shared_focal: 500.0,
        focal_overrides: vec![None; n],
        k1: 0.0,
        k2: 0.0,
    };
    let frames = vec![
        FrameMeta {
            cx: 320.0,
            cy: 240.0
        };
        n
    ];
    (state, frames)
}

/// A correspondence between `a` and `b` whose residual magnitude is
/// `off` px in both planes.
fn pair(a: usize, b: usize, x: f64, off: f64) -> [Block; 2] {
    let p_a = (x, 100.0);
    let p_b = (x + off, 100.0);
    [
        Block {
            src: a,
            dst: b,
            p_src: p_a,
            p_dst: p_b,
        },
        Block {
            src: b,
            dst: a,
            p_src: p_b,
            p_dst: p_a,
        },
    ]
}

fn opts() -> BaOptions {
    BaOptions::default()
}

fn ctx<'a>(
    frames: &'a [FrameMeta],
    opts: &'a BaOptions,
    lm_opts: &'a LmOptions,
    n: usize,
) -> GateContext<'a> {
    GateContext {
        frames,
        n_local: n,
        gauge: 0,
        opts,
        lm_opts,
    }
}

/// 3 frames; frame 0 carries a tight 40-pair core split across both
/// partners plus 20 wild pairs — qualifies. Frame classification
/// must see the core (a), its tight stats (b), and the fraction (c).
#[test]
fn classify_qualifies_on_multi_edge_tight_core() {
    let (state, frames) = flat_state(3);
    let o = opts();
    let lm = LmOptions::default();
    let ctx = ctx(&frames, &o, &lm, 3);
    let mut blocks = Vec::new();
    for i in 0..20 {
        blocks.extend(pair(0, 1, 10.0 + i as f64, 0.5));
        blocks.extend(pair(0, 2, 10.0 + i as f64, 0.5));
        blocks.extend(pair(0, 1, 200.0 + i as f64, 12.0)); // motion
    }
    let original = pairs_per_frame(&blocks, 3);
    let stats = frame_stats(&blocks, &frames, &state, 3);
    assert!(stats[0].mean_px > o.mean_budget_px, "frame 0 must fail");
    let verdicts = classify_cores(
        &blocks,
        &state,
        &ctx,
        &identity_corrections(&frames, 3),
        &[0],
        &stats,
        &original,
        &[0; 3],
    );
    let v = &verdicts[0];
    assert!(v.qualifies, "verdict: {v:?}");
    assert!(!v.dominated);
    assert_eq!(v.core_matches, 40);
    assert!((v.motion_fraction - 20.0 / 60.0).abs() < 1e-12);
    assert!(v.core_mean_px <= o.mean_budget_px);
}

/// Same shape but the tight core lives on ONE edge only while the
/// frame has two — the single-edge-core escape (a) must reject it.
#[test]
fn classify_rejects_single_edge_core_when_frame_has_two_edges() {
    let (state, frames) = flat_state(3);
    let o = opts();
    let lm = LmOptions::default();
    let ctx = ctx(&frames, &o, &lm, 3);
    let mut blocks = Vec::new();
    for i in 0..40 {
        blocks.extend(pair(0, 1, 10.0 + i as f64, 0.5)); // tight, edge (0,1)
        blocks.extend(pair(0, 2, 10.0 + i as f64, 12.0)); // wild, edge (0,2)
    }
    let original = pairs_per_frame(&blocks, 3);
    let stats = frame_stats(&blocks, &frames, &state, 3);
    let verdicts = classify_cores(
        &blocks,
        &state,
        &ctx,
        &identity_corrections(&frames, 3),
        &[0],
        &stats,
        &original,
        &[0; 3],
    );
    let v = &verdicts[0];
    assert!(
        !v.qualifies && !v.dominated,
        "single-edge core must classify as misaligned: {v:?}"
    );
}

/// Over the fraction ceiling with a perfectly tight multi-edge core
/// → dominated, not qualifying.
#[test]
fn classify_dominates_past_the_fraction_ceiling() {
    let (state, frames) = flat_state(3);
    let o = opts();
    let lm = LmOptions::default();
    let ctx = ctx(&frames, &o, &lm, 3);
    let mut blocks = Vec::new();
    for i in 0..20 {
        blocks.extend(pair(0, 1, 10.0 + i as f64, 0.5));
        blocks.extend(pair(0, 2, 10.0 + i as f64, 0.5));
    }
    for i in 0..100 {
        blocks.extend(pair(0, 1, 300.0 + i as f64, 15.0));
    }
    let original = pairs_per_frame(&blocks, 3);
    let stats = frame_stats(&blocks, &frames, &state, 3);
    let verdicts = classify_cores(
        &blocks,
        &state,
        &ctx,
        &identity_corrections(&frames, 3),
        &[0],
        &stats,
        &original,
        &[0; 3],
    );
    let v = &verdicts[0];
    assert!(v.dominated, "verdict: {v:?}");
    assert!(!v.qualifies);
    assert!(v.motion_fraction > MOTION_MAX_FRACTION);
    assert_eq!(v.core_matches, 40);
}

/// The hollow guard: pruning frame 0's motion pairs may not strip a
/// non-qualifying partner to zero pairs — its last pair stays.
#[test]
fn prune_never_hollows_a_nonqualifying_partner() {
    let (state, frames) = flat_state(3);
    let o = opts();
    let lm = LmOptions::default();
    let ctx = ctx(&frames, &o, &lm, 3);
    let mut blocks = Vec::new();
    // Frame 2's ONLY support: two wild pairs with frame 0.
    blocks.extend(pair(0, 2, 10.0, 20.0));
    blocks.extend(pair(0, 2, 50.0, 20.0));
    for i in 0..40 {
        blocks.extend(pair(0, 1, 10.0 + i as f64, 0.5));
    }
    let qualifying = [true, false, false];
    let mut pruned_pairs = vec![0usize; 3];
    let mut book = MotionBook::new(3);
    let retained = prune_motion_blocks(
        &blocks,
        &state,
        &ctx,
        &identity_corrections(&frames, 3),
        &qualifying,
        &mut pruned_pairs,
        &mut book,
    )
    .expect("one wild pair is prunable");
    let remaining = pairs_per_frame(&retained, 3);
    assert_eq!(remaining[2], 1, "frame 2 keeps its last pair");
    assert_eq!(book.pruned[0], 1, "only frame 0 counts the motion prune");
    assert_eq!(book.pruned[2], 0);
    assert_eq!(pruned_pairs[0], 1);
    assert_eq!(
        pruned_pairs[2], 1,
        "round-cumulative accounting is per endpoint"
    );
}

/// Bookkeeping publishes only flagged frames that survived.
#[test]
fn book_reports_surviving_flagged_frames_only() {
    let mut book = MotionBook::new(3);
    book.flagged[0] = true;
    book.pruned[0] = 7;
    book.flagged[2] = true;
    book.pruned[2] = 9;
    let mut solution = BaSolution {
        cameras: vec![None; 5],
        shared_focal_px: 1.0,
        k1: 0.0,
        k2: 0.0,
        frame_stats: vec![None; 5],
        dropped: vec![],
        mean_reproj_px: 0.0,
        max_reproj_px: 0.0,
        mean_reproj_before_local_px: 0.0,
        max_reproj_before_local_px: 0.0,
        lm_iterations: 0,
        final_cost: 0.0,
        converged: true,
        solve_rounds: 0,
        pruned_matches: 0,
        motion_affected: vec![],
        motion_pruned_matches: vec![],
        local_corrections: vec![None; 5],
        local_correction_rms: vec![0.0; 5],
    };
    let cam = crate::camera::Camera::new([0.0; 3], 500.0, 0.0, 0.0, 640, 480);
    solution.cameras[1] = Some(cam); // round_active[0] = global 1
    solution.cameras[4] = None; //              round_active[2] = global 4 dropped
    book.write_into(&mut solution, &[1, 3, 4]);
    assert_eq!(solution.motion_affected, vec![1]);
    assert_eq!(solution.motion_pruned_matches, vec![7]);
}
