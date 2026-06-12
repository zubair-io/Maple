//! M1b acceptance gates (#1154) — global bundle adjustment on synthetic
//! ground truth: rotation/focal recovery under noise + outliers, the
//! §9.2 per-image focal fallback, up-vector leveling, the §9.1
//! convergence-basin bench, gate-driven frame drops, and the 30-frame
//! timing measurement.

use std::time::Instant;

mod common;

use common::{
    build_graph, realistic_matches, relative_set, ring_options, seed_images, REALISTIC_NOISE_PX,
    REALISTIC_OUTLIERS,
};

use maple_pano::ba::{solve, BaOptions, DropReason, RetentionPolicy};
use maple_pano::camera::Camera;
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use maple_pano::leveling;
use maple_pano::math::{axis_angle_to_matrix, matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, CameraSetOptions, Pattern};
use maple_pano::robust::RobustOptions;
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use maple_pano::twoview::rotation_angle_between;

/// Worst absolute rotation error (degrees) against ground truth. Valid
/// when the solve was gauge-aligned to ground-truth priors.
fn worst_abs_rotation_err_deg(solution: &maple_pano::ba::BaSolution, cams: &[Camera]) -> f64 {
    let mut worst = 0.0_f64;
    for (est, truth) in solution.cameras.iter().zip(cams) {
        let est = est.as_ref().expect("frame solved");
        worst = worst.max(rotation_angle_between(&est.rotation, &truth.rotation).to_degrees());
    }
    worst
}

/// Worst pairwise-relative rotation error vs. ground truth (degrees) —
/// the gauge-free recovery metric. NOTE the form: with camera-to-world
/// rotations, `R_iᵀ·R_0` (the cam0→camᵢ frame change) is invariant
/// under a global rotation `R → g·R`; the world-frame form `R_i·R_0ᵀ`
/// is only *covariant* (it conjugates by `g`) and would report pure
/// gauge differences as errors.
fn worst_rel_rotation_err_deg(solution: &maple_pano::ba::BaSolution, cams: &[Camera]) -> f64 {
    let solved: Vec<&Camera> = solution
        .cameras
        .iter()
        .map(|c| c.as_ref().expect("frame solved"))
        .collect();
    let mut worst = 0.0_f64;
    for i in 1..cams.len() {
        let rel_est = solved[i].rotation.transpose().mul_mat(&solved[0].rotation);
        let rel_gt = cams[i].rotation.transpose().mul_mat(&cams[0].rotation);
        worst = worst.max(rotation_angle_between(&rel_est, &rel_gt).to_degrees());
    }
    worst
}

/// Gate (spec §7 / ticket): jittered closed ring, σ=1 px + 30 %
/// outliers — global rotations within 0.1° of truth, shared focal
/// within 0.5 %, every frame inside the acceptance budget, no drops.
#[test]
fn gate_ring_rotation_and_focal_recovery() {
    let gt = build_camera_set(&ring_options(10), &mut SplitMix64::new(7)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let true_focal = cams[0].focal_px;
    let images = seed_images(&cams, true);
    let graph = build_graph(&images, &cams, &realistic_matches());
    assert!(graph.orphans.is_empty(), "ring must be fully connected");

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(solution.converged);
    assert!(
        solution.dropped.is_empty(),
        "dropped: {:?}",
        solution.dropped
    );

    let rot_err = worst_abs_rotation_err_deg(&solution, &cams);
    let focal_err = (solution.shared_focal_px - true_focal).abs() / true_focal;
    println!(
        "ring10: worst rotation err {rot_err:.4}°, focal err {:.4}%, mean reproj {:.3}px, max {:.3}px, {} LM iters",
        focal_err * 100.0,
        solution.mean_reproj_px,
        solution.max_reproj_px,
        solution.lm_iterations
    );
    assert!(rot_err < 0.1, "worst rotation error {rot_err}°");
    assert!(focal_err < 0.005, "focal error {}%", focal_err * 100.0);
    assert!(solution.mean_reproj_px <= 1.5);
    assert!(solution.max_reproj_px <= 6.0);
}

/// Same recovery gate on a 3×4 grid (multi-row pano), measured with
/// the gauge-free relative metric. Grid sets need the gimbal-prior
/// candidate provider for cross-row pairs (capture order jumps rows at
/// the wrap; the no-prior retrieval provider is staged to #1139), so
/// priors are present for *nomination* — recovery is still judged on
/// relative rotations.
#[test]
fn gate_grid_rotation_recovery() {
    let opts = CameraSetOptions {
        count: 12,
        pattern: Pattern::Grid { rows: 3 },
        jitter_deg: 2.0,
        ..ring_options(12)
    };
    let gt = build_camera_set(&opts, &mut SplitMix64::new(11)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let graph = build_graph(&images, &cams, &realistic_matches());
    assert!(graph.orphans.is_empty(), "grid must be fully connected");

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(solution.converged);
    assert!(
        solution.dropped.is_empty(),
        "dropped: {:?}",
        solution.dropped
    );
    let rel_err = worst_rel_rotation_err_deg(&solution, &cams);
    println!("grid12: worst relative rotation err {rel_err:.4}°");
    assert!(rel_err < 0.1, "worst relative rotation error {rel_err}°");
}

/// Decision §9.2 gate: two frames shot at 1.15× focal in an otherwise
/// shared-focal ring. The fallback must free exactly those frames and
/// recover both focals within 0.5 %.
#[test]
fn gate_mixed_focal_fallback() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(3)).expect("valid options");
    let mut cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let shared_focal = cams[0].focal_px;
    let odd = [2usize, 5usize];
    for &i in &odd {
        let c = &cams[i];
        cams[i] = Camera::new(
            c.axis_angle,
            c.focal_px * 1.15,
            c.k1,
            c.k2,
            c.width,
            c.height,
        );
    }
    // The solver's seed intrinsics claim the *shared* focal everywhere —
    // it must discover the two odd frames from the residuals alone.
    let images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: Camera::new(c.axis_angle, shared_focal, c.k1, c.k2, c.width, c.height),
            prior_rotation: Some(c.rotation),
        })
        .collect();
    let corr = CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 0.5,
        outlier_fraction: 0.1,
        ..Default::default()
    };
    let graph = build_graph(&images, &cams, &corr);
    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(
        solution.dropped.is_empty(),
        "dropped: {:?}",
        solution.dropped
    );

    for (i, (est, truth)) in solution.cameras.iter().zip(&cams).enumerate() {
        let est = est.as_ref().expect("frame solved");
        let err = (est.focal_px - truth.focal_px).abs() / truth.focal_px;
        let freed = (est.focal_px - solution.shared_focal_px).abs() / solution.shared_focal_px;
        println!(
            "frame {i}: focal {:.2}px (true {:.2}px, err {:.3}%), {}",
            est.focal_px,
            truth.focal_px,
            err * 100.0,
            if freed > 0.05 { "FREED" } else { "shared" }
        );
        assert!(err < 0.005, "frame {i} focal error {}%", err * 100.0);
        let should_be_freed = odd.contains(&i);
        assert_eq!(
            freed > 0.05,
            should_be_freed,
            "frame {i}: freed-from-shared deviation {:.2}% vs expectation {should_be_freed}",
            freed * 100.0
        );
    }
}

/// Spec §7 horizon gate: a globally tilted, roll-free ring (no priors)
/// levels to within 0.3° after the up-vector correction.
#[test]
fn gate_tilted_ring_levels() {
    let opts = CameraSetOptions {
        jitter_deg: 0.0,
        ..ring_options(8)
    };
    let gt = build_camera_set(&opts, &mut SplitMix64::new(5)).expect("valid options");
    let tilt =
        Mat3::rotation_z(6.0_f64.to_radians()).mul_mat(&Mat3::rotation_x(3.0_f64.to_radians()));
    let cams: Vec<Camera> = gt
        .iter()
        .map(|g| {
            let c = g.to_camera();
            let r = tilt.mul_mat(&c.rotation);
            Camera::new(
                matrix_to_axis_angle(&r),
                c.focal_px,
                c.k1,
                c.k2,
                c.width,
                c.height,
            )
        })
        .collect();
    let images = seed_images(&cams, false);
    let graph = build_graph(&images, &cams, &realistic_matches());
    let mut solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(solution.dropped.is_empty());

    assert!(
        leveling::apply(&mut solution),
        "leveling must be observable"
    );
    let tilt_deg = leveling::horizon_tilt_deg(&solution);
    println!("tilted ring: post-leveling horizon tilt {tilt_deg:.4}°");
    assert!(tilt_deg < 0.3, "horizon tilt {tilt_deg}° after leveling");
}

/// Decision §9.1 convergence-basin bench: 20 solves from inits
/// perturbed uniformly 5–15° all reach the same minimum (relative cost
/// within 1e-6, relative rotations within 0.01°).
#[test]
fn gate_convergence_basin() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(13)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    // Priors nominate the wrap + skip edges (the graph shape real 360°
    // sets produce) — ring closure is what makes the 5–15° basin stiff.
    // The perturbed warm starts below *override* the prior-aligned init,
    // so the bench still starts far from the answer.
    let images = seed_images(&cams, true);
    let graph = build_graph(&images, &cams, &realistic_matches());
    let baseline = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(baseline.dropped.is_empty());
    let baseline_rel: Vec<Mat3> = relative_set(&baseline);

    let mut rng = SplitMix64::new(0xBA51);
    for run in 0..20 {
        let perturbed: Vec<Option<Mat3>> = cams
            .iter()
            .map(|c| {
                let axis = rng.next_unit_vector();
                let angle = (5.0 + 10.0 * rng.next_f64()).to_radians();
                let delta = axis_angle_to_matrix([axis.x * angle, axis.y * angle, axis.z * angle]);
                Some(c.rotation.mul_mat(&delta))
            })
            .collect();
        let opts = BaOptions {
            initial_rotations: Some(perturbed),
            ..Default::default()
        };
        let solution = solve(&images, &graph, &opts).expect("solve");
        assert!(
            solution.dropped.is_empty(),
            "run {run}: dropped {:?}",
            solution.dropped
        );
        let rel_cost = (solution.final_cost - baseline.final_cost).abs()
            / baseline.final_cost.max(f64::MIN_POSITIVE);
        assert!(rel_cost < 1e-6, "run {run}: relative cost gap {rel_cost}");
        for (i, (a, b)) in relative_set(&solution)
            .iter()
            .zip(&baseline_rel)
            .enumerate()
        {
            let gap = rotation_angle_between(a, b).to_degrees();
            assert!(
                gap < 0.01,
                "run {run} frame {i}: relative-rotation gap {gap}°"
            );
        }
    }
}

/// Acceptance-gate behavior: one frame's matches on a single edge are
/// generated from a 1.5°-rotated impostor camera — pairwise-consistent
/// (the verifier accepts it) but globally irreconcilable. The solve
/// must drop a frame with `HighResidual` rather than blend it in.
#[test]
fn gate_inconsistent_frame_is_dropped() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(17)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let impostor = {
        let c = &cams[3];
        // A *pitch* twist: non-absorbable on a yaw ring. (A yaw twist is
        // exactly ring misclosure, which a free shared focal swallows —
        // measured: a 4° yaw twist solved to all-frames ≈ 0.9 px with the
        // focal drifted −1.3%. Pitch on one edge has no global DOF to
        // hide in.)
        let twist = axis_angle_to_matrix([4.0_f64.to_radians(), 0.0, 0.0]);
        let r = c.rotation.mul_mat(&twist);
        Camera::new(
            matrix_to_axis_angle(&r),
            c.focal_px,
            c.k1,
            c.k2,
            c.width,
            c.height,
        )
    };
    let corr = realistic_matches();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            // Edge (3,4) sees frame 3 through the impostor pose.
            let cam_a = if (a, b) == (3, 4) {
                &impostor
            } else {
                &cams[a]
            };
            generate_pair_correspondences(cam_a, &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    );
    let solution = solve(
        &images,
        &graph,
        &BaOptions {
            retention: RetentionPolicy::Strict,
            ..Default::default()
        },
    )
    .expect("solve");
    for (i, s) in solution.frame_stats.iter().enumerate() {
        if let Some(s) = s {
            println!(
                "frame {i}: mean {:.3}px max {:.3}px median {:.3}px ({} blocks) corr_rms {:.3}px",
                s.mean_px, s.max_px, s.median_px, s.blocks, solution.local_correction_rms[i]
            );
        }
    }
    println!(
        "overall: mean {:.3}px max {:.3}px, focal {:.2}px, rounds {}",
        solution.mean_reproj_px,
        solution.max_reproj_px,
        solution.shared_focal_px,
        solution.solve_rounds
    );
    assert!(
        solution
            .dropped
            .iter()
            .any(|d| matches!(d.reason, DropReason::HighResidual { .. })),
        "expected a HighResidual drop, got {:?}",
        solution.dropped
    );
    // Spec §8 (#1216): a misaligned frame's error is systematic — it has
    // no qualifying multi-edge static core, so the motion discriminator
    // must NOT reclassify it (or anything else here) as motion-affected.
    assert!(
        solution.motion_affected.is_empty(),
        "misalignment must not be classified as motion: {:?}",
        solution.motion_affected
    );
    assert!(
        !solution
            .dropped
            .iter()
            .any(|d| matches!(d.reason, DropReason::MotionDominated { .. })),
        "misalignment must not drop as MotionDominated: {:?}",
        solution.dropped
    );
    assert!(
        solution.mean_reproj_px <= 1.5,
        "survivors must pass the gate"
    );
    println!("inconsistent-frame drops: {:?}", solution.dropped);
}

/// Spec §7 timing: BA over 30 frames in < 1 s. Asserted in release
/// builds only (debug is ~an order of magnitude slower by design);
/// always printed so the number lands in logs and the PR.
#[test]
fn gate_thirty_frame_timing() {
    let gt = build_camera_set(&ring_options(30), &mut SplitMix64::new(19)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let corr = CorrespondenceOptions {
        count: 100,
        noise_sigma_px: REALISTIC_NOISE_PX,
        outlier_fraction: REALISTIC_OUTLIERS,
        ..Default::default()
    };
    let graph = build_graph(&images, &cams, &corr);
    let start = Instant::now();
    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    let elapsed = start.elapsed();
    println!(
        "30-frame BA: {:?} ({} LM iterations, {} rounds, {} dropped)",
        elapsed,
        solution.lm_iterations,
        solution.solve_rounds,
        solution.dropped.len()
    );
    assert!(solution.converged);
    if !cfg!(debug_assertions) {
        assert!(
            elapsed.as_secs_f64() < 1.0,
            "30-frame BA took {elapsed:?} (budget 1 s, spec §7)"
        );
    }
}

/// Stage-D gate: gross outlier correspondences that slip past pairwise
/// verification are pruned — they must not convert aligned frames into
/// drops (measured failure mode on real DJI sets: frames with sub-px
/// means dying on single-match maxes).
#[test]
fn gate_outlier_matches_are_pruned_not_frames() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(23)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let mut graph = build_graph(&images, &cams, &realistic_matches());
    assert!(graph.orphans.is_empty());
    // Corrupt three verified inliers on one edge with gross errors, as a
    // confidently-wrong matcher would.
    let edge = &mut graph.edges[0];
    assert!(edge.inlier_matches.len() > 30);
    for m in edge.inlier_matches.iter_mut().take(3) {
        m.b.0 += 40.0;
        m.b.1 -= 25.0;
    }
    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(
        solution.dropped.is_empty(),
        "outliers must be pruned, not frames dropped: {:?}",
        solution.dropped
    );
    assert!(
        solution.pruned_matches >= 3,
        "expected the 3 planted outliers pruned, got {}",
        solution.pruned_matches
    );
    println!(
        "outlier-prune gate: pruned {} correspondences, mean {:.3}px max {:.3}px",
        solution.pruned_matches, solution.mean_reproj_px, solution.max_reproj_px
    );
    assert!(solution.mean_reproj_px <= 1.5 && solution.max_reproj_px <= 6.0);
}

/// The same wrong-pose edge under the product default
/// (`RetentionPolicy::KeepAlignable`): every connected frame is PLACED
/// — a suspected-bad pose is included and warned about (the §8
/// classification flags it), never silently deleted. The render-level
/// reference metrics are the backstop that surfaces a genuinely bad
/// placement to the harness.
#[test]
fn gate_inconsistent_frame_kept_and_flagged_under_keep() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(47)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let impostor = {
        let c = &cams[3];
        let twist = axis_angle_to_matrix([4.0_f64.to_radians(), 0.0, 0.0]);
        let r = c.rotation.mul_mat(&twist);
        Camera::new(
            matrix_to_axis_angle(&r),
            c.focal_px,
            c.k1,
            c.k2,
            c.width,
            c.height,
        )
    };
    let corr = realistic_matches();
    let clean_graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    );
    let clean = solve(&images, &clean_graph, &BaOptions::default()).expect("clean solve");
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            let cam_a = if (a, b) == (3, 4) {
                &impostor
            } else {
                &cams[a]
            };
            generate_pair_correspondences(cam_a, &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    );
    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    println!(
        "keep-mode impostor: dropped {:?}, motion_affected {:?}",
        solution.dropped, solution.motion_affected
    );
    assert!(
        solution.dropped.is_empty(),
        "keep mode places every connected frame: {:?}",
        solution.dropped
    );
    // Including a wrong-pose edge by policy has a real, data-dependent
    // geometry cost: stage-D prunes most of the poisoned matches but the
    // guard-capped remainder dragged frame 2 by ~2.3° at this seed (vs
    // the clean run). Keep-mode's guarantee is placement-without-
    // deletion; placement QUALITY under poisoned input is the render-
    // level reference metrics' job to surface (and strict mode's job to
    // refuse — `gate_inconsistent_frame_is_dropped` above). Wrong-pose
    // edge handling under keep (full prune or loud flag) is tracked
    // follow-up work; this test pins today's honest contract and
    // documents the measured drag so any silent change is visible.
    let max_gap = relative_set(&solution)
        .iter()
        .zip(relative_set(&clean))
        .map(|(a, b)| rotation_angle_between(a, &b).to_degrees())
        .fold(0.0_f64, f64::max);
    println!("keep-mode impostor: max relative-rotation drag {max_gap:.4}° vs clean");
    assert!(
        max_gap < 5.0,
        "drag {max_gap:.4}° exceeds even the impostor's own 4° magnitude —          the solve diverged rather than degraded"
    );
}
