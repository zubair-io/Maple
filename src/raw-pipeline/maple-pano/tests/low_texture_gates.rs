//! Spec §8 low-texture failure mode / ticket #1191: "Low-texture
//! frames (sky-only): < 30 verified matches to any neighbor → fall
//! back to gimbal-prior placement for that frame, flagged in report."
//! Split from `ba_gates.rs` for the file-size budget.

mod common;

use common::{realistic_matches, ring_options, seed_images};
use maple_pano::ba::{solve, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider};
use maple_pano::prng::SplitMix64;
use maple_pano::render::build_camera_set;
use maple_pano::testkit::generate_pair_correspondences;
use maple_pano::twoview::rotation_angle_between;

/// One frame in an otherwise well-matched ring gets zero
/// correspondences to either neighbor (the synthetic stand-in for
/// sky-only content) but carries a perfect gimbal prior. It must be
/// placed from that prior — present in the composite (`cameras[target]`
/// is `Some`), flagged (`placed_by_prior`), and never appear in
/// `dropped`.
#[test]
fn gate_low_texture_orphan_placed_by_prior() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(3)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    // Every frame carries its exact ground-truth rotation as its prior —
    // the "perfect prior" the gate asks for.
    let images = seed_images(&cams, true);
    let target = 3usize;
    let corr = realistic_matches();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            if a == target || b == target {
                // No verifiable matches to any neighbor — the low-texture
                // stand-in. A full 8-ring stays connected through the
                // other 7 frames once one node is cut out.
                return Vec::new();
            }
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &maple_pano::robust::RobustOptions::default(),
    );
    assert!(
        graph.orphans.contains(&target),
        "target frame must have zero verified edges pre-solve: orphans {:?}",
        graph.orphans
    );

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");

    assert!(
        !solution.dropped.iter().any(|d| d.index == target),
        "a low-texture frame with a usable prior must not be silently dropped: {:?}",
        solution.dropped
    );
    assert_eq!(
        solution.placed_by_prior,
        vec![target],
        "exactly the low-texture frame should be flagged placed-by-prior, no other"
    );
    let placed = solution.cameras[target]
        .as_ref()
        .expect("a placed_by_prior frame must have a camera — present in the composite");
    let err_deg = rotation_angle_between(&placed.rotation, &cams[target].rotation).to_degrees();
    println!("low-texture placement: rotation err vs ground truth {err_deg:.4}°");
    assert!(
        err_deg < 0.5,
        "a perfect prior should place within a fraction of a degree once gauge-aligned: {err_deg}°"
    );
    // No correspondence data exists for this frame: it must not carry a
    // fabricated residual summary or a local-alignment fit — an
    // unverified placement should read as exactly that in the solution.
    assert!(
        solution.frame_stats[target].is_none(),
        "a placed frame has no residuals to summarize"
    );
    assert!(
        solution.local_corrections[target].is_none(),
        "a placed frame has no correspondence data to fit a mesh correction against"
    );
}
