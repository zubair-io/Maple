
use super::*;
use crate::camera::focal_px_for_hfov;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

fn ring(count: u32, fov_deg: f64, full: bool, overlap: f64) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Ring { full },
        fov_deg,
        overlap,
        pitch_deg: 0.0,
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

#[test]
fn full_sphere_matches_equirect_source_mapping() {
    let c = CanvasSpec::full_sphere(64).unwrap();
    assert_eq!((c.width, c.height), (128, 64));
    assert!(c.is_full_wrap());
    // λ = 0, φ = 0 → pixel (W/2, H/2).
    let (px, py) = c.dir_to_pixel(Vec3::new(0.0, 0.0, 1.0)).unwrap();
    assert!((px - 64.0).abs() < 1e-9 && (py - 32.0).abs() < 1e-9);
    // East (λ = π/2) → 3/4 W.
    let (px, _) = c.dir_to_pixel(Vec3::new(1.0, 0.0, 0.0)).unwrap();
    assert!((px - 96.0).abs() < 1e-9);
    // Round trip on a grid of texel centers.
    for iy in (0..64).step_by(7) {
        for ix in (0..128).step_by(11) {
            let (px, py) = (ix as f64 + 0.5, iy as f64 + 0.5);
            let d = c.pixel_to_dir(px, py).expect("in-domain");
            let (qx, qy) = c.dir_to_pixel(d).expect("representable");
            assert!(
                (qx - px).abs() < 1e-9 && (qy - py).abs() < 1e-9,
                "({px}, {py}) → ({qx}, {qy})"
            );
        }
    }
    // Top row center latitude approaches the zenith: φ = π/2 · (1 − 1/H).
    let d = c.pixel_to_dir(0.5, 0.5).unwrap();
    let (_, phi) = Projection::Spherical.forward(d).unwrap();
    assert!((phi - FRAC_PI_2 * (1.0 - 1.0 / 64.0)).abs() < 1e-9);
}

/// A rectilinear canvas aligned with a distortion-free camera maps
/// pixels identically to the camera — the convention cross-check
/// between canvas and camera mappings.
#[test]
fn identity_rect_canvas_matches_camera_mapping() {
    let cam = Camera::new([0.15, -0.6, 0.05], 300.0, 0.0, 0.0, 200, 150);
    let f = cam.focal_px;
    let c = CanvasSpec::with_window(
        Projection::Rectilinear,
        cam.width,
        cam.height,
        -(cam.width as f64 * 0.5) / f,
        -(cam.height as f64 * 0.5) / f,
        1.0 / f,
        1.0 / f,
        cam.rotation,
        false,
    )
    .unwrap();
    for (px, py) in [(0.5, 0.5), (100.5, 75.5), (199.5, 0.5), (37.0, 148.0)] {
        let dc = c.pixel_to_dir(px, py).unwrap();
        let dcam = cam.pixel_to_world_dir(px, py).unwrap();
        assert!((dc - dcam).norm() < 1e-12, "dir mismatch at ({px}, {py})");
        let (qx, qy) = c.dir_to_pixel(dcam).unwrap();
        assert!((qx - px).abs() < 1e-9 && (qy - py).abs() < 1e-9);
    }
}

#[test]
fn projection_thresholds_per_spec() {
    assert_eq!(select_projection(45.0), Projection::Rectilinear);
    assert_eq!(select_projection(60.0), Projection::Cylindrical);
    assert_eq!(select_projection(130.0), Projection::Cylindrical);
    assert_eq!(select_projection(131.0), Projection::Spherical);
}

#[test]
fn auto_selects_by_extent() {
    // Single 40° camera → diagonal extent ~49° → rectilinear.
    // (50° hfov on 4:3 already has a > 60° diagonal.)
    let single = ring(1, 40.0, false, 0.0);
    let c = auto_canvas(&single, &CanvasOptions::default()).unwrap();
    assert_eq!(c.projection, Projection::Rectilinear);

    // Three 45° cameras spanning ~103° → cylindrical.
    let mid = ring(3, 45.0, false, 0.35);
    let c = auto_canvas(&mid, &CanvasOptions::default()).unwrap();
    assert_eq!(c.projection, Projection::Cylindrical);
    assert!(!c.is_full_wrap());

    // Full 360° ring → spherical, full wrap, du·W = 2π.
    let full = ring(10, 60.0, true, 0.0);
    let c = auto_canvas(&full, &CanvasOptions::default()).unwrap();
    assert_eq!(c.projection, Projection::Spherical);
    assert!(c.is_full_wrap());
    assert!((c.du * c.width as f64 - TAU).abs() < 1e-9);

    // Override wins.
    let c = auto_canvas(
        &mid,
        &CanvasOptions {
            projection: ProjectionMode::Force(Projection::Spherical),
            ..CanvasOptions::default()
        },
    )
    .unwrap();
    assert_eq!(c.projection, Projection::Spherical);
}

/// Canvas density preserves the maximum input angular density:
/// the canvas never samples coarser than the densest input pixel.
#[test]
fn resolution_preserves_max_input_density() {
    let cams = ring(4, 55.0, false, 0.3);
    let c = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
    // The densest input pixels live at the frame corners (pinhole
    // density f·sec²θ ≥ f); the canvas must be at least that dense.
    let f = cams[0].focal_px;
    assert!(
        c.pixels_per_radian() >= f,
        "canvas density {} < center density {f}",
        c.pixels_per_radian()
    );
    // And it shouldn't over-allocate beyond corner density + margin.
    let corner =
        (f * f + (cams[0].width as f64 * 0.5).powi(2) + (cams[0].height as f64 * 0.5).powi(2)) / f;
    assert!(
        c.pixels_per_radian() <= corner * 1.05,
        "canvas density {} > corner density {corner}",
        c.pixels_per_radian()
    );
}

#[test]
fn max_pixels_cap_shrinks_canvas_preserving_aspect() {
    let cams = ring(6, 60.0, true, 0.0);
    let unbounded = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
    let capped = auto_canvas(
        &cams,
        &CanvasOptions {
            max_pixels: 10_000,
            ..CanvasOptions::default()
        },
    )
    .unwrap();
    assert!(capped.pixel_count() <= 10_000);
    let a0 = unbounded.width as f64 / unbounded.height as f64;
    let a1 = capped.width as f64 / capped.height as f64;
    assert!((a0 - a1).abs() / a0 < 0.05, "aspect drifted: {a0} vs {a1}");
}

/// A partial ring whose frames straddle the ±180° meridian must
/// still get a contiguous (non-wrapped) window containing every
/// frame direction.
#[test]
fn window_centers_on_content_across_antimeridian() {
    // Three cameras looking around 180°: yaws 160°, 180°, 200°.
    let mk = |yaw_deg: f64| {
        Camera::new(
            [0.0, yaw_deg.to_radians(), 0.0],
            focal_px_for_hfov(50.0, 192),
            0.0,
            0.0,
            192,
            144,
        )
    };
    let cams = vec![mk(160.0), mk(180.0), mk(-160.0)];
    let c = auto_canvas(&cams, &CanvasOptions::default()).unwrap();
    assert!(!c.is_full_wrap());
    // Every frame center must land strictly inside the canvas.
    for cam in &cams {
        let d = cam
            .pixel_to_world_dir(96.0, 72.0)
            .expect("center invertible");
        let (px, py) = c.dir_to_pixel(d).expect("representable");
        assert!(
            px > 0.0 && px < c.width as f64 && py > 0.0 && py < c.height as f64,
            "frame center off-canvas at ({px}, {py}) of {}x{}",
            c.width,
            c.height
        );
    }
}

#[test]
fn empty_or_invalid_options_error() {
    assert!(matches!(
        auto_canvas(&[], &CanvasOptions::default()),
        Err(PanoError::InvalidOptions(_))
    ));
    let cams = ring(1, 40.0, false, 0.0);
    assert!(matches!(
        auto_canvas(
            &cams,
            &CanvasOptions {
                max_pixels: 0,
                ..CanvasOptions::default()
            }
        ),
        Err(PanoError::InvalidOptions(_))
    ));
    assert!(CanvasSpec::full_sphere(0).is_err());
}

/// Forcing rectilinear on a hemisphere-wide set must fail loudly,
/// not produce a folded canvas.
#[test]
fn rectilinear_force_rejects_wide_sets() {
    let cams = ring(8, 60.0, true, 0.0);
    let r = auto_canvas(
        &cams,
        &CanvasOptions {
            projection: ProjectionMode::Force(Projection::Rectilinear),
            ..CanvasOptions::default()
        },
    );
    assert!(matches!(r, Err(PanoError::InvalidOptions(_))));
}
