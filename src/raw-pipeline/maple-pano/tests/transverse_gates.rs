//! Transverse projection gates (#4518): synthetic pitch-ring sets
//! rendered by the `pano-gt-render` machinery auto-select a transverse
//! canvas and composite within the spec §7 warp RMSE (< 0.5 % of full
//! scale), including a closed ring whose wrap seam runs between the top
//! and bottom canvas rows.

use maple_pano::camera::Camera;
use maple_pano::canvas::{CanvasOptions, CanvasSpec, ProjectionMode};
use maple_pano::composite::{composite, composite_tiled_frames, CompositeOptions};
use maple_pano::gain::FramePhotometry;
use maple_pano::ingest::{PlanarImage, ValidityMask};
use maple_pano::math::{matrix_to_axis_angle, Mat3};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::seam::SeamStrategy;
use maple_pano::source::EquirectSource;
use maple_pano::Projection;

fn pitch_ring(count: u32, fov_deg: f64, overlap: f64, pitch_deg: f64, seed: u64) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Grid { rows: count },
        fov_deg,
        overlap,
        pitch_deg,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 480,
        height: 360,
    };
    build_camera_set(&opts, &mut SplitMix64::new(seed))
        .expect("valid options")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

/// The same set turned to face `yaw_deg` (so the pitch axis is no longer
/// world X and the fitted basis has to follow it).
fn yawed(cams: Vec<Camera>, yaw_deg: f64) -> Vec<Camera> {
    let turn = Mat3::rotation_y(yaw_deg.to_radians());
    cams.into_iter()
        .map(|c| {
            let rotation = turn.mul_mat(&c.rotation);
            Camera {
                rotation,
                axis_angle: matrix_to_axis_angle(&rotation),
                ..c
            }
        })
        .collect()
}

fn gt_frames(source: &EquirectSource, cams: &[Camera]) -> Vec<PlanarImage> {
    cams.iter()
        .map(|cam| {
            let data = render_frame(source, cam, 2).expect("render");
            let plane = |c: usize| -> Vec<f32> {
                data.chunks_exact(3)
                    .map(|px| px[c] as f32 / 65535.0)
                    .collect()
            };
            PlanarImage::from_planes(
                cam.width,
                cam.height,
                plane(0),
                plane(1),
                plane(2),
                ValidityMask::new_filled(cam.width, cam.height, true),
            )
        })
        .collect()
}

/// RMSE of the composite against a direct resample of the source at
/// canvas resolution over its valid pixels: (rmse, compared fraction).
fn rmse_vs_source(out: &PlanarImage, canvas: &CanvasSpec, source: &EquirectSource) -> (f64, f64) {
    let (w, h) = (out.width(), out.height());
    let (sum_sq, count) = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| out.validity.get(x, y))
        .filter_map(|(x, y)| {
            let dir = canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)?;
            let reference = source.sample_dir(dir)?;
            let i = (y as usize) * (w as usize) + x as usize;
            Some(
                [&out.r, &out.g, &out.b]
                    .iter()
                    .enumerate()
                    .map(|(c, plane)| (plane[i] as f64 - reference[c]).powi(2))
                    .sum::<f64>(),
            )
        })
        .fold((0.0, 0usize), |(s, n), e| (s + e, n + 3));
    (
        (sum_sq / count.max(1) as f64).sqrt(),
        count as f64 / ((w as usize) * (h as usize) * 3) as f64,
    )
}

fn gate(
    source: &EquirectSource,
    cams: &[Camera],
    frames: &[PlanarImage],
    expected: Projection,
) -> (PlanarImage, CanvasSpec, f64) {
    let (out, report) =
        composite(frames, cams, &CompositeOptions::default(), &[]).expect("composite");
    let (rmse, covered) = rmse_vs_source(&out, &report.canvas, source);
    println!(
        "{expected:?} gate: rmse {:.5} ({:.3}% of full scale), {:.1}% compared, canvas {}x{}",
        rmse,
        rmse * 100.0,
        covered * 100.0,
        report.canvas.width,
        report.canvas.height
    );
    assert_eq!(report.projection, expected);
    assert!(covered > 0.5, "the sweep must cover most of the canvas");
    assert!(rmse < 0.005, "spec §7: RMSE {rmse} ≥ 0.5% of full scale");
    (out, report.canvas, rmse)
}

fn scene(seed: u64) -> EquirectSource {
    EquirectSource::synthetic(2048, 1024, seed).expect("source")
}

fn gate_scene(cams: &[Camera], seed: u64, expected: Projection) {
    let source = scene(seed);
    gate(&source, cams, &gt_frames(&source, cams), expected);
}

#[test]
fn gate_pitch_column_selects_transverse_cylindrical() {
    gate_scene(
        &pitch_ring(3, 60.0, 0.35, 10.0, 1),
        42,
        Projection::TransverseCylindrical,
    );
}

/// The sweep climbs past the zenith (top frame at ~102° pitch), where the
/// standard cylinder hits its `tan φ → ∞` pole.
#[test]
fn gate_over_zenith_sweep_selects_transverse_spherical() {
    gate_scene(
        &pitch_ring(5, 60.0, 0.35, 40.0, 2),
        7,
        Projection::TransverseSpherical,
    );
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
    let cams = yawed(pitch_ring(10, 65.0, 0.295, 0.0, 3), 90.0);
    let source = scene(11);
    let frames = gt_frames(&source, &cams);
    let (out, canvas, rmse) = gate(&source, &cams, &frames, Projection::TransverseSpherical);
    assert!(canvas.is_full_wrap(), "closed ring must wrap");

    let forced = CompositeOptions {
        canvas: CanvasOptions {
            projection: ProjectionMode::Force(Projection::Spherical),
            ..CanvasOptions::default()
        },
        ..CompositeOptions::default()
    };
    let (standard, report) = composite(&frames, &cams, &forced, &[]).expect("composite");
    let (standard_rmse, _) = rmse_vs_source(&standard, &report.canvas, &source);
    println!("standard sphere on the same ring: rmse {standard_rmse:.5}");
    assert!(
        rmse < standard_rmse,
        "transverse must beat the upright sphere"
    );

    let (w, h) = (out.width(), out.height());
    let bottom = (h as usize - 1) * w as usize;
    let sample = |px: f64, py: f64| {
        source
            .sample_dir(canvas.pixel_to_dir(px, py).unwrap())
            .unwrap()[0]
    };
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
    let (tiled_rmse, _) = rmse_vs_source(&tiled, &canvas, &source);
    println!("tiled closed ring: rmse {tiled_rmse:.5}");
    assert_eq!(tiled.validity.count_valid(), out.validity.count_valid());
    assert!(tiled_rmse < 0.005, "tiled RMSE {tiled_rmse}");
}
