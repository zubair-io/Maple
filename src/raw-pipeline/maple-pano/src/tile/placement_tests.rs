//! Unit tests for [`crate::tile::placement`].
//! Kept in a separate file for the file-size budget.

use super::placement_solve::gauss_eliminate;
use super::*;
use crate::similarity::Similarity2d;

fn translation_constraint(a: usize, b: usize, tx: f64, ty: f64, w: f64) -> TileConstraint {
    TileConstraint {
        a,
        b,
        sim_ab: Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx,
            ty,
        },
        weight: w,
    }
}

#[test]
fn three_frame_strip_places_correctly() {
    // 3 frames in a horizontal strip. sim_01 and sim_12 have tx=100,
    // meaning frame_1 is 100px to the right of frame_0 in the sense that
    // sim_01.apply(frame_0_px) ≈ frame_1_px (frame_1 pixel = frame_0 pixel + 100).
    //
    // Pose semantics: pose_i maps frame_i → canvas via
    //   canvas = pose.sim.apply(src) + offset.
    // With pose_b = pose_a ∘ sim_ab.inverse():
    //   pose_1.tx = -(sim_01.tx) = -100 (frame_1's left edge at canvas = offset + 0)
    //   pose_2.tx = -200
    //
    // Consistency check: for a match at frame_0.px=50 → frame_1.px=150:
    //   canvas_a = pose_0.apply(50) + offset = 50 + offset
    //   canvas_b = pose_1.apply(150) + offset = (150 - 100) + offset = 50 + offset ✓
    let dims = vec![(200u32, 200u32); 3];
    let constraints = vec![
        translation_constraint(0, 1, 100.0, 0.0, 50.0),
        translation_constraint(1, 2, 100.0, 0.0, 50.0),
    ];
    let (poses, canvas, orphans) = solve_tile_poses(3, &constraints, 0, &dims).unwrap();
    assert!(orphans.is_empty(), "fully connected strip has no orphans");

    // frame 0 at identity.
    assert!(
        (poses[0].sim.tx).abs() < 1.0,
        "frame-0 tx={}",
        poses[0].sim.tx
    );
    assert!(
        (poses[0].sim.ty).abs() < 1.0,
        "frame-0 ty={}",
        poses[0].sim.ty
    );

    // frame 1: pose.tx = -100 (sim_01.tx=100 → inverse=-100).
    assert!(
        (poses[1].sim.tx + 100.0).abs() < 2.0,
        "frame-1 tx={}",
        poses[1].sim.tx
    );
    assert!(
        (poses[1].sim.ty).abs() < 2.0,
        "frame-1 ty={}",
        poses[1].sim.ty
    );

    // frame 2: pose.tx = -200.
    assert!(
        (poses[2].sim.tx + 200.0).abs() < 2.0,
        "frame-2 tx={}",
        poses[2].sim.tx
    );
    assert!(
        (poses[2].sim.ty).abs() < 2.0,
        "frame-2 ty={}",
        poses[2].sim.ty
    );

    // Canvas must be wide enough for 3 frames side by side.
    // With offset = MARGIN - min_x = 8 - (-200) = 208, width ≈ 200 + 200 + 200 + 16.
    assert!(canvas.width >= 400, "canvas width {}", canvas.width);
    assert!(canvas.height >= 200, "canvas height {}", canvas.height);
}

#[test]
fn single_frame_returns_identity() {
    let dims = vec![(640u32, 480u32)];
    let (poses, _canvas, orphans) = solve_tile_poses(1, &[], 0, &dims).unwrap();
    assert!(orphans.is_empty());
    assert_eq!(poses.len(), 1);
    assert!((poses[0].sim.tx).abs() < 1e-10);
    assert!((poses[0].sim.ty).abs() < 1e-10);
    assert!((poses[0].sim.scale - 1.0).abs() < 1e-10);
    assert!((poses[0].sim.theta).abs() < 1e-10);
}

#[test]
fn disconnected_graph_reports_orphans_without_misindex() {
    // Two isolated components: frames 0-1 connected, frame 2 isolated.
    // Anchor = 0. Expect: 2 poses (frames 0 and 1), orphans = [2].
    // Crucially frame 2's constraint must NOT appear in poses (no misindex).
    let dims = vec![(200u32, 200u32); 3];
    let constraints = vec![translation_constraint(0, 1, 100.0, 0.0, 50.0)];
    let (poses, _canvas, orphans) = solve_tile_poses(3, &constraints, 0, &dims).unwrap();

    assert_eq!(orphans, vec![2], "frame 2 must be reported as orphan");
    assert_eq!(poses.len(), 2, "only 2 reachable frames should have poses");
    let frame_idxs: Vec<usize> = poses.iter().map(|p| p.frame_idx).collect();
    assert!(
        frame_idxs.contains(&0) && frame_idxs.contains(&1),
        "poses should cover frames 0 and 1, got {frame_idxs:?}"
    );
    assert!(
        !frame_idxs.contains(&2),
        "orphan frame 2 must not appear in poses"
    );

    // Frame 0 placed at identity, frame 1 offset by -100.
    let p0 = poses.iter().find(|p| p.frame_idx == 0).unwrap();
    let p1 = poses.iter().find(|p| p.frame_idx == 1).unwrap();
    assert!((p0.sim.tx).abs() < 1.0, "frame-0 tx={}", p0.sim.tx);
    assert!((p1.sim.tx + 100.0).abs() < 2.0, "frame-1 tx={}", p1.sim.tx);
}

#[test]
fn connected_graph_has_empty_orphans() {
    let dims = vec![(200u32, 200u32); 3];
    let constraints = vec![
        translation_constraint(0, 1, 100.0, 0.0, 10.0),
        translation_constraint(1, 2, 100.0, 0.0, 10.0),
    ];
    let (poses, _canvas, orphans) = solve_tile_poses(3, &constraints, 0, &dims).unwrap();
    assert!(orphans.is_empty(), "connected graph must have no orphans");
    assert_eq!(poses.len(), 3);
}

#[test]
fn anchor_out_of_range_returns_error_not_panic() {
    // anchor=5 for frame_count=3 must return Err, not index-OOB panic.
    let dims = vec![(200u32, 200u32); 3];
    let constraints = vec![translation_constraint(0, 1, 50.0, 0.0, 10.0)];
    let result = solve_tile_poses(3, &constraints, 5, &dims);
    assert!(
        matches!(
            result,
            Err(TilePlacementError::IndexOutOfBounds { have: 3, bad: 5 })
        ),
        "expected IndexOutOfBounds(have=3, bad=5), got {result:?}"
    );
    // anchor == frame_count is also out of range.
    let result2 = solve_tile_poses(3, &[], 3, &dims);
    assert!(
        matches!(
            result2,
            Err(TilePlacementError::IndexOutOfBounds { have: 3, bad: 3 })
        ),
        "expected IndexOutOfBounds(have=3, bad=3), got {result2:?}"
    );
}

#[test]
fn gauss_eliminate_identity_system() {
    let n = 3;
    let mut a = vec![1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0f64];
    let mut b = vec![5.0, 10.0, 15.0];
    let x = gauss_eliminate(&mut a, &mut b, n);
    assert!((x[0] - 5.0).abs() < 1e-10);
    assert!((x[1] - 5.0).abs() < 1e-10);
    assert!((x[2] - 5.0).abs() < 1e-10);
}
