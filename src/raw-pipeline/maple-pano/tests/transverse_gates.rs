//! Transverse projection gates (#4518): synthetic pitch-ring sets
//! rendered by the `pano-gt-render` machinery auto-select a transverse
//! canvas and composite within the spec §7 warp RMSE (< 0.5 % of full
//! scale), including a closed ring whose wrap seam runs between the top
//! and bottom canvas rows, and (#5958) the rows around the zenith of
//! sweeps that cross it.

mod gt_scene;

use gt_scene::{pitch_ring, turned, Scene};
use maple_pano::camera::Camera;
use maple_pano::canvas::{CanvasOptions, ProjectionMode};
use maple_pano::composite::{composite, composite_tiled_frames, CompositeOptions};
use maple_pano::gain::FramePhotometry;
use maple_pano::math::Mat3;
use maple_pano::seam::SeamStrategy;
use maple_pano::Projection;

/// The same set turned to face `yaw_deg` (so the pitch axis is no longer
/// world X and the fitted basis has to follow it).
fn yawed(cams: Vec<Camera>, yaw_deg: f64) -> Vec<Camera> {
    turned(cams, Mat3::rotation_y(yaw_deg.to_radians()))
}

fn gate_scene(cams: &[Camera], seed: u64, expected: Projection) {
    let scene = Scene::new(seed);
    scene.gate(cams, &scene.frames(cams), expected);
}

#[test]
fn gate_pitch_column_selects_transverse_cylindrical() {
    gate_scene(
        &pitch_ring(3, 60.0, 0.35, 10.0, 480, 1),
        42,
        Projection::TransverseCylindrical,
    );
}

/// The sweep climbs past the zenith (top frame at ~102° pitch), where the
/// standard cylinder hits its `tan φ → ∞` pole.
#[test]
fn gate_over_zenith_sweep_selects_transverse_spherical() {
    gate_scene(
        &pitch_ring(5, 60.0, 0.35, 40.0, 480, 2),
        7,
        Projection::TransverseSpherical,
    );
}

/// The rows around the zenith (#5958) hold to the same §7 bar as the
/// whole canvas — no pole, no seam artefact there — for the sweep above
/// and for one centred on the zenith. The source's own poles are turned
/// onto the sweep's pitch axis so the band measures the compositor, not
/// the equirect source's degenerate pole rows.
#[test]
fn gate_zenith_rows_of_over_zenith_sweeps() {
    for (pitch_deg, heading_deg, seed) in [(40.0, 0.0, 7), (90.0, 150.0, 9)] {
        let cams = yawed(pitch_ring(5, 60.0, 0.35, pitch_deg, 480, 2), heading_deg);
        let scene = Scene::poles_on_pitch_axis(seed, heading_deg);
        let frames = scene.frames(&cams);
        let (out, canvas, _) = scene.gate(&cams, &frames, Projection::TransverseSpherical);
        scene.gate_zenith_band(&out, &canvas);
    }
}

/// Closed pitch ring (ten 65° frames through zenith and nadir, facing
/// yaw 90° so the row seam looks along the horizon rather than down the
/// source's own ±180° meridian, which would make the seam check measure
/// the source's step instead of the compositor's): the
/// canvas wraps in v and composites within the §7 budget, well under the
/// standard sphere forced onto the same set; the top and bottom rows
/// agree across the seam up to the source's own step there; and the
/// tiled compositor matches the reference coverage and accuracy.
#[test]
fn gate_closed_pitch_ring_wraps_in_rows() {
    let cams = yawed(pitch_ring(10, 65.0, 0.295, 0.0, 480, 3), 90.0);
    let scene = Scene::new(11);
    let frames = scene.frames(&cams);
    let (out, canvas, rmse) = scene.gate(&cams, &frames, Projection::TransverseSpherical);
    assert!(canvas.is_full_wrap(), "closed ring must wrap");

    let forced = CompositeOptions {
        canvas: CanvasOptions {
            projection: ProjectionMode::Force(Projection::Spherical),
            ..CanvasOptions::default()
        },
        ..CompositeOptions::default()
    };
    let (standard, report) = composite(&frames, &cams, &forced, &[]).expect("composite");
    let (standard_rmse, _) = scene.rmse(&standard, &report.canvas);
    println!("standard sphere on the same ring: rmse {standard_rmse:.5}");
    assert!(
        rmse < standard_rmse,
        "transverse must beat the upright sphere"
    );

    let (w, h) = (out.width(), out.height());
    let bottom = (h as usize - 1) * w as usize;
    let sample = |px: f64, py: f64| scene.sample(canvas.pixel_to_dir(px, py).unwrap()).unwrap()[0];
    let residuals: Vec<f64> = (0..w)
        .filter(|&x| out.validity.get(x, 0) && out.validity.get(x, h - 1))
        .map(|x| {
            let composite_step = (out.r[x as usize] - out.r[bottom + x as usize]) as f64;
            let cx = x as f64 + 0.5;
            let source_step = sample(cx, 0.5) - sample(cx, h as f64 - 0.5);
            (composite_step - source_step).abs()
        })
        .collect();
    let mean = residuals.iter().sum::<f64>() / residuals.len().max(1) as f64;
    let worst = residuals.iter().copied().fold(0.0_f64, f64::max);
    println!(
        "row-seam closure: mean residual {mean:.5}, worst {worst:.5} over {} columns",
        residuals.len()
    );
    assert!(
        residuals.len() > (w as usize) / 2,
        "seam rows must be covered"
    );
    // The blend pyramid treats every canvas edge as a border (the yaw
    // ring's seam columns carry the same ~0.01 edge error), so the seam is
    // held to the yaw-ring closure bar rather than interior accuracy.
    assert!(
        mean < 0.03 && worst < 0.08,
        "row-seam discontinuity {mean} / {worst}"
    );

    let (tiled, _) = composite_tiled_frames(
        &frames,
        &cams,
        &vec![FramePhotometry::IDENTITY; cams.len()],
        &[],
        None,
        &canvas,
        64,
        SeamStrategy::Voronoi,
        &[],
    )
    .expect("tiled composite");
    let (tiled_rmse, _) = scene.rmse(&tiled, &canvas);
    println!("tiled closed ring: rmse {tiled_rmse:.5}");
    assert_eq!(tiled.validity.count_valid(), out.validity.count_valid());
    assert!(tiled_rmse < 0.005, "tiled RMSE {tiled_rmse}");
}
