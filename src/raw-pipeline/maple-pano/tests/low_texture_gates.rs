//! Spec §8 low-texture failure mode / ticket #1191: "Low-texture
//! frames (sky-only): < 30 verified matches to any neighbor → fall
//! back to gimbal-prior placement for that frame, flagged in report."
//! Split from `ba_gates.rs` for the file-size budget.

mod common;

use common::{realistic_matches, ring_options};
use maple_pano::ba::{solve, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage};
use maple_pano::math::Mat3;
use maple_pano::prng::SplitMix64;
use maple_pano::render::build_camera_set;
use maple_pano::testkit::generate_pair_correspondences;
use maple_pano::twoview::rotation_angle_between;

/// One frame in an otherwise well-matched ring gets zero
/// correspondences to either neighbor (the synthetic stand-in for
/// sky-only content) but carries a usable gimbal prior. It must be
/// placed from that prior — present in the composite (`cameras[target]`
/// is `Some`), flagged (`placed_by_prior`), and never appear in
/// `dropped`.
///
/// The solve is forced into a **known, deliberately non-identity**
/// gauge relative to the (unmodified, ground-truth) priors: every
/// active frame's `initial_rotations` warm start is seeded 25° off from
/// its true rotation, and BA's own gauge-freezing (the first active
/// frame's rotation never updates once initialized — see `ba/mod.rs`'s
/// module docs) keeps the whole solved rig in that 25°-rotated frame,
/// since only *relative* geometry is reprojection-constrained. This
/// matters for the gate's power: with priors close to identity-aligned
/// (e.g. a ring solved from a plain spanning-tree init with no forcing),
/// the gauge rotation `align_gauge_to_priors` fits between the solved
/// cameras and their own priors comes out ≈ identity — at which point
/// `G` and `Gᵀ` are indistinguishable to a fraction of a degree, and a
/// transposed-rotation bug in the orphan-placement math would pass
/// silently (this was tried and confirmed: an inline direction flip on
/// `ba/mod.rs`'s `world_rotation` still passed an earlier, unforced
/// version of this gate to within 0.03°). Forcing a real ~25° disagreement
/// makes `G` genuinely non-trivial, so a wrong-direction placement lands
/// tens of degrees off instead of a fraction of one.
#[test]
fn gate_low_texture_orphan_placed_by_prior() {
    let gt = build_camera_set(&ring_options(8), &mut SplitMix64::new(3)).expect("valid options");
    let cams: Vec<Camera> = gt.iter().map(|g| g.to_camera()).collect();
    // Priors are exact ground truth — unmodified, "perfect" priors.
    let images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: Some(c.rotation),
        })
        .collect();
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

    // Force every frame's warm start 25° off true (harmless for the
    // orphan itself — it never enters the active set, so its slot in
    // this override is simply unused).
    let forced_gauge = Mat3::rotation_y(25.0_f64.to_radians());
    let forced_init: Vec<Option<Mat3>> = cams
        .iter()
        .map(|c| Some(forced_gauge.mul_mat(&c.rotation)))
        .collect();
    let opts = BaOptions {
        initial_rotations: Some(forced_init),
        ..Default::default()
    };
    let solution = solve(&images, &graph, &opts).expect("solve");

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

    // Sanity: confirm the forcing actually held — an actively-solved
    // frame should sit near the forced 25° gauge, not back at ground
    // truth (BA never re-consults priors after `align_gauge_to_priors`
    // runs at init, and `initial_rotations` overrides win over that).
    let reference = 0usize;
    let reference_cam = solution.cameras[reference]
        .as_ref()
        .expect("frame 0 is actively solved, not the low-texture target");
    let reference_forced_deg = rotation_angle_between(
        &reference_cam.rotation,
        &forced_gauge.mul_mat(&cams[reference].rotation),
    )
    .to_degrees();
    println!("solved frame 0 vs the forced 25° gauge: {reference_forced_deg:.4}°");
    assert!(
        reference_forced_deg < 1.0,
        "the forced gauge should hold through the solve, confirming this gate actually \
         exercises a non-trivial G rather than accidentally testing near-identity: \
         {reference_forced_deg:.4}°"
    );

    // The real assertion: the placed orphan must land in the SAME
    // forced 25° gauge every solved frame is in, not at its raw
    // (unrotated) prior and not rotated the wrong way.
    let placed = solution.cameras[target]
        .as_ref()
        .expect("a placed_by_prior frame must have a camera — present in the composite");
    let placed_err_deg = rotation_angle_between(
        &placed.rotation,
        &forced_gauge.mul_mat(&cams[target].rotation),
    )
    .to_degrees();
    println!("placed frame vs the forced 25° gauge: {placed_err_deg:.4}°");
    assert!(
        placed_err_deg < 0.5,
        "the placed frame must land in the solved rig's forced 25° gauge, not its raw prior \
         or a wrong-direction rotation of it: {placed_err_deg:.4}°"
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
