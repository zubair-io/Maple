use super::transverse::sweep_extents;
use super::*;
use crate::camera::Camera;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::math::matrix_to_axis_angle;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};
use crate::warp::{frame_canvas_bbox, warp_to_canvas};

fn camera_set(
    pattern: Pattern,
    count: u32,
    fov_deg: f64,
    overlap: f64,
    pitch_deg: f64,
) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern,
        fov_deg,
        overlap,
        pitch_deg,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 192,
        height: 144,
    };
    build_camera_set(&opts, &mut SplitMix64::new(7))
        .expect("valid options")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

/// A single column of `count` frames sweeping pitch around `base_pitch_deg`.
fn pitch_column(count: u32, fov_deg: f64, overlap: f64, base_pitch_deg: f64) -> Vec<Camera> {
    camera_set(
        Pattern::Grid { rows: count },
        count,
        fov_deg,
        overlap,
        base_pitch_deg,
    )
}

fn yawed(cams: &[Camera], yaw_deg: f64) -> Vec<Camera> {
    let r = Mat3::rotation_y(yaw_deg.to_radians());
    cams.iter()
        .map(|c| {
            let rotation = r.mul_mat(&c.rotation);
            Camera {
                rotation,
                axis_angle: matrix_to_axis_angle(&rotation),
                ..c.clone()
            }
        })
        .collect()
}

fn level_uv(c: &CanvasSpec, dir: Vec3) -> (f64, f64) {
    let (px, py) = c.dir_to_pixel(dir).unwrap();
    let (u, v) = c.pixel_to_uv(px, py);
    (u, (v + PI).rem_euclid(TAU) - PI)
}

fn auto(cams: &[Camera]) -> CanvasSpec {
    auto_canvas(cams, &CanvasOptions::default()).expect("canvas")
}

#[test]
fn pitch_sweeps_select_transverse_projections() {
    let three = pitch_column(3, 60.0, 0.35, 0.0);
    let (e, _) = sweep_extents(&three).unwrap();
    println!(
        "3-frame column: pitch {:.1}° yaw {:.1}°",
        e.pitch.to_degrees(),
        e.yaw.to_degrees()
    );
    assert_eq!(auto(&three).projection, Projection::TransverseCylindrical);

    let five = pitch_column(5, 60.0, 0.35, 40.0);
    assert_eq!(auto(&five).projection, Projection::TransverseSpherical);

    let full = pitch_column(8, 90.0, 0.39, 0.0);
    let c = auto(&full);
    assert_eq!(c.projection, Projection::TransverseSpherical);
    assert!(c.is_full_wrap(), "a closed pitch ring wraps in v");
    assert!((c.dv.abs() * c.height as f64 - TAU).abs() < 1e-9);
    assert!(c.width < c.height, "the sweep runs down the rows");
}

#[test]
fn yaw_sets_keep_their_projection() {
    let ring = |count, fov, full, overlap, pitch| {
        camera_set(Pattern::Ring { full }, count, fov, overlap, pitch)
    };
    assert_eq!(
        auto(&ring(1, 40.0, false, 0.0, 0.0)).projection,
        Projection::Rectilinear
    );
    assert_eq!(
        auto(&ring(3, 45.0, false, 0.35, 0.0)).projection,
        Projection::Cylindrical
    );
    assert_eq!(
        auto(&ring(6, 70.0, true, 0.35, 0.0)).projection,
        Projection::Spherical
    );
    assert_eq!(
        auto(&ring(10, 60.0, true, 0.0, 0.0)).projection,
        Projection::Spherical
    );
    assert_eq!(
        auto(&ring(8, 60.0, true, 0.0, 40.0)).projection,
        Projection::Spherical
    );
    assert_eq!(
        auto(&ring(4, 55.0, false, 0.3, 0.0)).projection,
        Projection::Spherical
    );
    let grid = camera_set(Pattern::Grid { rows: 2 }, 8, 50.0, 0.3, 0.0);
    assert_eq!(auto(&grid).projection, Projection::Spherical);
    // A narrow two-frame vertical pair stays below the 55° pitch floor.
    let pair = pitch_column(2, 60.0, 0.35, 0.0);
    assert_eq!(auto(&pair).projection, Projection::Cylindrical);
}

/// The pitch basis follows the sweep's heading: a column at yaw 70°
/// still gets an upright transverse canvas whose v = 0 row holds the
/// level frame's center, and every frame center round-trips.
#[test]
fn transverse_canvas_follows_the_sweep_heading() {
    let cams = yawed(&pitch_column(3, 60.0, 0.35, 0.0), 70.0);
    let c = auto(&cams);
    assert_eq!(c.projection, Projection::TransverseCylindrical);
    let level = Mat3::rotation_y(70f64.to_radians()).mul_vec(Vec3::new(0.0, 0.0, 1.0));
    let (u, v) = level_uv(&c, level);
    assert!(u.abs() < 1e-9 && v.abs() < 1e-9, "level axis at ({u}, {v})");
    let (_, py) = c.dir_to_pixel(level).unwrap();
    let up = c
        .dir_to_pixel(cams[0].pixel_to_world_dir(96.0, 72.0).unwrap())
        .unwrap();
    assert!(up.1 < py, "the upper frame sits above the level frame");
    for cam in &cams {
        for (x, y) in [(0.0, 0.0), (96.0, 72.0), (192.0, 144.0)] {
            let d = cam.pixel_to_world_dir(x, y).unwrap();
            let (px, py) = c.dir_to_pixel(d).unwrap();
            assert!(px >= 0.0 && px <= c.width as f64 && py >= 0.0 && py <= c.height as f64);
            let back = c.pixel_to_dir(px, py).unwrap();
            assert!((back - d).norm() < 1e-10);
        }
    }
}

#[test]
fn forced_transverse_uses_the_fitted_basis() {
    let cams = yawed(&pitch_column(3, 60.0, 0.35, 0.0), -35.0);
    let c = auto_canvas(
        &cams,
        &CanvasOptions {
            projection: ProjectionMode::Force(Projection::TransverseSpherical),
            ..CanvasOptions::default()
        },
    )
    .unwrap();
    assert_eq!(c.projection, Projection::TransverseSpherical);
    let level = Mat3::rotation_y((-35f64).to_radians()).mul_vec(Vec3::new(0.0, 0.0, 1.0));
    let (u, v) = level_uv(&c, level);
    assert!(u.abs() < 1e-9 && v.abs() < 1e-9);
}

#[test]
fn natural_ratio_covers_transverse_sets() {
    let cams = pitch_column(5, 60.0, 0.35, 40.0);
    let opts = CanvasOptions::default();
    let ratio = natural_canvas_pixel_ratio(&cams, &opts).expect("ratio");
    let canvas = auto_canvas(&cams, &opts).unwrap();
    let actual = canvas.pixel_count() as f64 / opts.max_pixels as f64;
    assert!(
        ratio > 0.0 && ratio <= actual * 1.01,
        "natural {ratio} vs canvas {actual}"
    );
    assert!(ratio < DEGENERATE_CANVAS_RATIO);
}

/// On a closed pitch ring the warp footprint is exactly the camera's own
/// mapping — including the frame that straddles the top/bottom row seam,
/// whose bbox falls back to the full canvas height.
#[test]
fn transverse_wrap_footprint_matches_camera_mapping() {
    let cams = pitch_column(8, 90.0, 0.39, 0.0);
    let canvas = auto(&cams).downscaled(60_000);
    assert!(canvas.is_full_wrap());
    let straddles = cams
        .iter()
        .filter(|cam| {
            frame_canvas_bbox(cam, &canvas, 2.0).is_some_and(|b| b.y0 == 0 && b.y1 == canvas.height)
        })
        .count();
    assert!(straddles >= 1, "some frame must straddle the row seam");
    for cam in &cams {
        let src = PlanarImage::from_planes(
            cam.width,
            cam.height,
            vec![0.5; 192 * 144],
            vec![0.5; 192 * 144],
            vec![0.5; 192 * 144],
            ValidityMask::new_filled(cam.width, cam.height, true),
        );
        let out = warp_to_canvas(&src, cam, &canvas, [1.0; 3], None);
        let mismatches = (0..canvas.height)
            .flat_map(|y| (0..canvas.width).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let inside = canvas
                    .pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
                    .and_then(|d| cam.world_dir_to_pixel(d))
                    .is_some_and(|(px, py)| cam.pixel_in_bounds(px, py, 0.0));
                inside != out.validity.get(x, y)
            })
            .count();
        assert_eq!(mismatches, 0, "footprint mismatch");
        assert!(out.validity.count_valid() > 0);
    }
}
