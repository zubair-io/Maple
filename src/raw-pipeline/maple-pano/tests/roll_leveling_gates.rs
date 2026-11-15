//! Roll-only leveling end to end (#5958). A five-frame pitch sweep
//! centred on the zenith is solved by bundle adjustment from
//! matcher-realistic synthetic correspondences (σ = 0.5 px, 30 %
//! outliers), gauged to attitude priors that lean the sweep 6° about its
//! forward axis — a gimbal reporting a rolled horizon. Leveling must take
//! the roll-only branch and remove the lean to within 0.1° without
//! adding pose error of its own (yaw and pitch stay as solved), and the
//! levelled cameras must composite the frames rendered from the true
//! cameras within spec §7, the zenith rows included.

#[allow(dead_code)] // shared BA helpers; this gate needs only three
mod common;
mod gt_scene;

use common::{build_graph, realistic_matches, seed_images};
use gt_scene::{pitch_ring, turned, Scene};
use maple_pano::ba::{solve, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::canvas::{auto_canvas, CanvasOptions};
use maple_pano::leveling::{self, Leveling};
use maple_pano::math::Mat3;
use maple_pano::twoview::rotation_angle_between;
use maple_pano::Projection;

#[test]
fn gate_leaned_zenith_sweep_levels_its_roll_through_ba() {
    let heading = 30f64.to_radians();
    let truth = turned(
        pitch_ring(5, 60.0, 0.35, 90.0, 960, 4),
        Mat3::rotation_y(heading),
    );
    let lean = Mat3::rotation_y(heading)
        .mul_mat(&Mat3::rotation_z(6f64.to_radians()))
        .mul_mat(&Mat3::rotation_y(-heading));
    let leaned = turned(truth.clone(), lean);

    let images = seed_images(&leaned, true);
    let graph = build_graph(&images, &leaned, &realistic_matches());
    let mut solution = solve(&images, &graph, &BaOptions::default()).expect("solve");
    assert!(
        solution.dropped.is_empty(),
        "dropped {:?}",
        solution.dropped
    );
    let worst_error = |solution: &maple_pano::ba::BaSolution, reference: &[Camera]| {
        solution
            .cameras
            .iter()
            .zip(reference)
            .map(|(est, gt)| {
                let est = est.as_ref().expect("frame solved");
                rotation_angle_between(&est.rotation, &gt.rotation).to_degrees()
            })
            .fold(0.0_f64, f64::max)
    };
    let ba_error = worst_error(&solution, &leaned);

    let (kind, g) = leveling::leveling_rotation(&solution).expect("roll observable");
    assert_eq!(kind, Leveling::Roll);
    let lean_error = rotation_angle_between(&g.mul_mat(&lean), &Mat3::identity()).to_degrees();
    assert_eq!(leveling::apply(&mut solution), Some(Leveling::Roll));
    let pose_error = worst_error(&solution, &truth);
    println!(
        "leaned zenith sweep: residual lean {lean_error:.4}°, worst pose error {pose_error:.4}° \
         (BA alone {ba_error:.4}°), horizon tilt rms {:.4}°",
        leveling::horizon_tilt_rms_deg(&solution)
    );
    assert!(lean_error < 0.1, "residual lean {lean_error}°");
    assert!(
        pose_error < ba_error + 0.01,
        "leveling added pose error: {pose_error}° vs BA {ba_error}°"
    );
    let solved: Vec<Camera> = solution
        .cameras
        .iter()
        .map(|c| c.clone().expect("frame solved"))
        .collect();

    let canvas_of = |cams: &[Camera]| auto_canvas(cams, &CanvasOptions::default()).expect("canvas");
    let (want, got, unlevelled) = (canvas_of(&truth), canvas_of(&solved), canvas_of(&leaned));
    println!(
        "canvas: truth {}x{}, levelled {}x{}, leaned {}x{}",
        want.width, want.height, got.width, got.height, unlevelled.width, unlevelled.height
    );
    assert_eq!(got.projection, Projection::TransverseSpherical);
    assert!(
        unlevelled.width as f64 > want.width as f64 * 1.03,
        "the lean must widen an unlevelled canvas for this gate to see it"
    );
    let width_error = (got.width as f64 / want.width as f64 - 1.0).abs();
    assert!(
        width_error < 0.01,
        "levelled canvas width off by {width_error}"
    );

    let scene = Scene::poles_on_pitch_axis(13, heading.to_degrees());
    let frames = scene.frames(&truth);
    let (out, canvas, _) = scene.gate(&solved, &frames, Projection::TransverseSpherical);
    scene.gate_zenith_band(&out, &canvas);
}
