//! Spec §8 motion-tolerance acceptance gates (#1216) — the
//! static-core discriminator on synthetic ground truth: a
//! motion-affected frame is kept (and classified) on its tight static
//! core with the solve unharmed, while a motion-DOMINATED frame (>70%
//! wild) drops with the distinct reason. The misalignment
//! counter-gate (the pitch impostor must still drop, unclassified)
//! lives with the original §5.3 gates in `ba_gates.rs`.

mod common;

use common::{build_graph, realistic_matches, relative_set, ring_options, seed_images};
use maple_pano::ba::{solve, BaOptions, DropReason};
use maple_pano::camera::Camera;
use maple_pano::graph::MatchGraph;
use maple_pano::prng::SplitMix64;
use maple_pano::render::build_camera_set;
use maple_pano::twoview::rotation_angle_between;

/// Moving-water magnitudes/directions: 8–20 px, spread around the
/// circle so the wild set is not expressible by any global rotation,
/// focal, or distortion mode (a single rigid offset is — a yaw, roll,
/// or per-frame-focal change can absorb it, which is misalignment, not
/// motion).
const WATER_OFFSETS: [(f64, f64); 6] = [
    (14.0, 8.0),
    (-11.0, -12.0),
    (9.0, -16.0),
    (-18.0, 6.0),
    (0.0, 13.0),
    (-8.0, -8.0),
];
/// Matches per coherently-moving water patch.
const WATER_BLOB: usize = 20;

/// Moving-water corruption: shift `fraction` of the target-side
/// coordinates of every edge of `target`, in coherent blobs of
/// [`WATER_BLOB`] points sharing an offset — water patches (waves,
/// swell, wakes) translate coherently within a patch and differently
/// across patches and overlaps. Returns the number of shifted
/// correspondences.
fn corrupt_target_edges_with_motion(graph: &mut MatchGraph, target: usize, fraction: f64) -> usize {
    let mut shifted = 0;
    for e in graph
        .edges
        .iter_mut()
        .filter(|e| e.a == target || e.b == target)
    {
        let n = (e.inlier_matches.len() as f64 * fraction).round() as usize;
        for m in e.inlier_matches.iter_mut().take(n) {
            let (dx, dy) = WATER_OFFSETS[(shifted / WATER_BLOB) % WATER_OFFSETS.len()];
            if e.a == target {
                m.a.0 += dx;
                m.a.1 += dy;
            } else {
                m.b.0 += dx;
                m.b.1 += dy;
            }
            shifted += 1;
        }
    }
    shifted
}

/// Spec §8 gate (#1216): a frame whose overlaps contain moving water —
/// 40% of its correspondences coherently shifted 8–20 px, per-edge
/// offsets — is KEPT on its static core, classified motion-affected
/// with at least the planted matches pruned, and the solved rotations
/// are unaffected vs. the clean run (gauge-free metric).
#[test]
fn gate_motion_frame_kept_on_static_core() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(29)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let clean_graph = build_graph(&images, &cams, &realistic_matches());
    let clean = solve(&images, &clean_graph, &BaOptions::default()).expect("solve");
    assert!(clean.dropped.is_empty(), "clean ring must keep all frames");

    let target = 3usize;
    let mut graph = build_graph(&images, &cams, &realistic_matches());
    let shifted = corrupt_target_edges_with_motion(&mut graph, target, 0.4);
    assert!(shifted > 0, "corruption must plant motion matches");

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    println!(
        "motion gate: dropped {:?}, motion_affected {:?} (pruned {:?}), {shifted} planted",
        solution.dropped, solution.motion_affected, solution.motion_pruned_matches
    );
    assert!(
        solution.dropped.is_empty(),
        "the motion frame must be kept, not dropped: {:?}",
        solution.dropped
    );
    let idx = solution
        .motion_affected
        .iter()
        .position(|&f| f == target)
        .unwrap_or_else(|| {
            panic!(
                "frame {target} must be classified motion_affected, got {:?}",
                solution.motion_affected
            )
        });
    assert!(
        solution.motion_pruned_matches[idx] >= shifted,
        "expected >= {shifted} motion matches pruned for frame {target}, got {}",
        solution.motion_pruned_matches[idx]
    );
    // Rotation accuracy unaffected by the motion handling: gauge-free
    // relative rotations within 0.05° of the clean run's.
    for (i, (a, b)) in relative_set(&solution)
        .iter()
        .zip(relative_set(&clean))
        .enumerate()
    {
        let gap = rotation_angle_between(a, &b).to_degrees();
        assert!(
            gap <= 0.05,
            "frame {i}: relative-rotation delta {gap}° vs the clean run"
        );
    }
    // Survivors (all 8) pass the spec gates on their cleaned stats.
    assert!(solution.mean_reproj_px <= 1.5 && solution.max_reproj_px <= 6.0);
}

/// Spec §8 gate (#1216): a frame that is mostly motion — 75% of its
/// correspondences shifted, multi-directional blobs so the static
/// remnant stays the only registered subset — has a tight multi-edge
/// core ((a)+(b) hold) but too little static truth to pose reliably
/// ((c) fails). It must drop with the distinct MotionDominated reason
/// carrying the core evidence, not be kept on the sliver and not drop
/// as a bare HighResidual.
#[test]
fn gate_motion_dominated_frame_drops_with_distinct_reason() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(31)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    let images = seed_images(&cams, true);
    let target = 3usize;
    let mut graph = build_graph(&images, &cams, &realistic_matches());
    let shifted = corrupt_target_edges_with_motion(&mut graph, target, 0.75);
    assert!(shifted > 0);

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    println!(
        "motion-dominated gate: dropped {:?}, motion_affected {:?}",
        solution.dropped, solution.motion_affected
    );
    let drop = solution
        .dropped
        .iter()
        .find(|d| d.index == target)
        .unwrap_or_else(|| panic!("frame {target} must drop, got {:?}", solution.dropped));
    match &drop.reason {
        DropReason::MotionDominated {
            core_mean_px,
            core_matches,
            motion_fraction,
        } => {
            assert!(
                *core_matches >= 30,
                "the distinct reason carries the core evidence: {core_matches} matches"
            );
            assert!(*core_mean_px <= 1.5, "core mean {core_mean_px} px");
            assert!(
                *motion_fraction > 0.7,
                "motion fraction {motion_fraction} must exceed the ceiling"
            );
        }
        other => panic!("expected MotionDominated, got {other:?}"),
    }
    assert!(
        !solution.motion_affected.contains(&target),
        "a dropped frame is never motion_affected: {:?}",
        solution.motion_affected
    );
    assert_eq!(
        solution.dropped.len(),
        1,
        "only the dominated frame drops: {:?}",
        solution.dropped
    );
    assert!(solution.mean_reproj_px <= 1.5 && solution.max_reproj_px <= 6.0);
}
