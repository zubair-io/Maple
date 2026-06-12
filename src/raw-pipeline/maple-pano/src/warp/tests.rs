//! Unit tests for [`super`] — split from `warp/mod.rs` for the
//! file-size budget.

use super::*;
use crate::canvas::CanvasSpec;
use crate::math::Mat3;
use crate::project::Projection;

fn planar_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> PlanarImage {
    let n = (w as usize) * (h as usize);
    let (mut r, mut g, mut b) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    for y in 0..h {
        for x in 0..w {
            let p = f(x, y);
            r.push(p[0]);
            g.push(p[1]);
            b.push(p[2]);
        }
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

/// Rectilinear canvas exactly aligned with a distortion-free
/// camera: the warp is the identity mapping (up to f64 rounding in
/// the projection round trip).
fn aligned_canvas(cam: &Camera) -> CanvasSpec {
    let f = cam.focal_px;
    CanvasSpec::with_window(
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
    .unwrap()
}

/// Identity warp reproduces the source to ~f64 rounding noise
/// (≤ 1e-9 — projecting through the canvas/camera chain leaves the
/// sample a few ulp off the exact texel center, so true bit
/// equality is not attainable; any half-pixel convention bug would
/// show up as errors at the 1e-2 scale on this content).
#[test]
fn identity_warp_reproduces_source_near_exactly() {
    let cam = Camera::new([0.2, -0.7, 0.1], 240.0, 0.0, 0.0, 96, 72);
    let src = planar_from_fn(96, 72, |x, y| {
        [
            (x as f32 * 0.013).sin().abs(),
            (y as f32 * 0.031).cos().abs(),
            ((x + y) as f32 * 0.007).fract(),
        ]
    });
    let out = warp_to_canvas(&src, &cam, &aligned_canvas(&cam), [1.0; 3], None);
    for i in 0..src.pixel_count() {
        assert!((out.r[i] - src.r[i]).abs() < 1e-9, "R at {i}");
        assert!((out.g[i] - src.g[i]).abs() < 1e-9, "G at {i}");
        assert!((out.b[i] - src.b[i]).abs() < 1e-9, "B at {i}");
    }
    assert!(out.validity.all_valid());
}

#[test]
fn gain_is_folded_into_the_warp() {
    let cam = Camera::new([0.0; 3], 100.0, 0.0, 0.0, 32, 24);
    let src = planar_from_fn(32, 24, |_, _| [0.25, 0.5, 0.125]);
    let out = warp_to_canvas(&src, &cam, &aligned_canvas(&cam), [2.0, 0.5, 4.0], None);
    for i in 0..out.pixel_count() {
        assert_eq!(out.r[i], 0.5);
        assert_eq!(out.g[i], 0.25);
        assert_eq!(out.b[i], 0.5);
    }
}

/// Catmull-Rom reproduces linear ramps exactly (within f32) at
/// fractional sample positions — pins the half-pixel convention.
#[test]
fn bicubic_reproduces_linear_ramp_at_fractional_offsets() {
    let src = planar_from_fn(32, 8, |x, _| [x as f32, 0.0, 0.0]);
    for &(sx, sy) in &[(5.75, 3.5), (8.5, 2.25), (12.301, 4.71), (2.5, 1.5)] {
        let s = sample_bicubic(&src, sx, sy).expect("interior sample");
        // Texel x stores value x; centers at x + 0.5 → value(sx) = sx − 0.5.
        assert!(
            (s[0] as f64 - (sx - 0.5)).abs() < 1e-5,
            "ramp at ({sx}, {sy}): got {}",
            s[0]
        );
    }
}

/// A constant source with an invalid hole stays exactly constant at
/// every valid output pixel — the validity-weighted renormalization
/// cannot leak the hole's (zeroed) content. The hole itself stays
/// invalid.
#[test]
fn invalid_hole_does_not_smear_into_neighbors() {
    let w = 48;
    let h = 36;
    let mut src = planar_from_fn(w, h, |_, _| [0.625, 0.625, 0.625]);
    for y in 14..20 {
        for x in 20..26 {
            src.validity.set(x, y, false);
            let i = (y * w + x) as usize;
            src.r[i] = 0.0; // poison the hole so any leak is visible
            src.g[i] = 0.0;
            src.b[i] = 0.0;
        }
    }
    // Quarter-pixel-offset canvas forces real 4×4 interpolation.
    let cam = Camera::new([0.0; 3], 150.0, 0.0, 0.0, w, h);
    let f = cam.focal_px;
    let canvas = CanvasSpec::with_window(
        Projection::Rectilinear,
        w,
        h,
        -(w as f64 * 0.5 - 0.25) / f,
        -(h as f64 * 0.5 - 0.25) / f,
        1.0 / f,
        1.0 / f,
        cam.rotation,
        false,
    )
    .unwrap();
    let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3], None);
    let mut checked_valid = 0;
    let mut hole_interior_invalid = 0;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if out.validity.get(x, y) {
                assert!(
                    (out.r[i] - 0.625).abs() < 1e-6,
                    "smear at ({x}, {y}): {}",
                    out.r[i]
                );
                checked_valid += 1;
            } else if (21..25).contains(&x) && (15..19).contains(&y) {
                hole_interior_invalid += 1;
            }
        }
    }
    assert!(checked_valid > (w * h / 2) as usize, "warp mostly valid");
    assert!(hole_interior_invalid > 0, "hole interior must stay invalid");
}

/// Narrow camera on a full-sphere canvas: validity covers exactly
/// the camera footprint (checked against the camera's own mapping).
#[test]
fn footprint_validity_matches_camera_mapping() {
    let cam = Camera::new([0.1, 0.9, 0.0], 80.0, -0.03, 0.01, 64, 48);
    let src = planar_from_fn(64, 48, |_, _| [0.5; 3]);
    let canvas = CanvasSpec::full_sphere(96).unwrap();
    let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3], None);
    let mut mismatches = 0;
    for y in 0..canvas.height {
        for x in 0..canvas.width {
            let dir = canvas
                .pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
                .expect("sphere total");
            let inside = cam
                .world_dir_to_pixel(dir)
                .is_some_and(|(px, py)| px >= 0.0 && px <= 64.0 && py >= 0.0 && py <= 48.0);
            if inside != out.validity.get(x, y) {
                mismatches += 1;
            }
        }
    }
    // The mapping is exact; allow zero mismatches.
    assert_eq!(mismatches, 0, "footprint mismatch count");
    assert!(out.validity.count_valid() > 0);
}

/// A frame straddling the ±180° meridian on a full-wrap canvas
/// writes to both canvas edges and nothing near the center.
#[test]
fn wrap_straddling_frame_covers_both_canvas_edges() {
    let cam = Camera::new([0.0, std::f64::consts::PI, 0.0], 80.0, 0.0, 0.0, 64, 48);
    let src = planar_from_fn(64, 48, |_, _| [1.0; 3]);
    let canvas = CanvasSpec::full_sphere(64).unwrap();
    let bbox = frame_canvas_bbox(&cam, &canvas, 4.0).expect("on canvas");
    assert_eq!(bbox.x_spans.len(), 2, "bbox must split across the wrap");
    let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3], None);
    let h2 = canvas.height / 2;
    assert!(out.validity.get(0, h2), "left edge covered");
    assert!(out.validity.get(canvas.width - 1, h2), "right edge covered");
    assert!(
        !out.validity.get(canvas.width / 2, h2),
        "canvas center (yaw 0) must be empty for a yaw-180 frame"
    );
}

/// Frame entirely behind a rectilinear canvas → empty output, and
/// `frame_canvas_bbox` reports it as off-canvas.
#[test]
fn frame_behind_rect_canvas_is_fully_invalid() {
    let cam = Camera::new([0.0, std::f64::consts::PI, 0.0], 100.0, 0.0, 0.0, 32, 24);
    let forward = Camera::new([0.0; 3], 100.0, 0.0, 0.0, 32, 24);
    let canvas = aligned_canvas(&forward);
    assert_eq!(frame_canvas_bbox(&cam, &canvas, 4.0), None);
    let src = planar_from_fn(32, 24, |_, _| [1.0; 3]);
    let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3], None);
    assert_eq!(out.validity.count_valid(), 0);
}

/// Determinism: two runs produce byte-identical planes and masks.
#[test]
fn warp_is_deterministic() {
    let cam = Camera::new([0.05, 0.4, -0.02], 90.0, -0.05, 0.012, 80, 60);
    let src = planar_from_fn(80, 60, |x, y| {
        [
            ((x * 7 + y * 3) % 13) as f32 / 13.0,
            ((x * 5 + y * 11) % 7) as f32 / 7.0,
            ((x + y) % 3) as f32 / 3.0,
        ]
    });
    let canvas = CanvasSpec::full_sphere(80).unwrap();
    let a = warp_to_canvas(&src, &cam, &canvas, [1.1, 0.9, 1.0], None);
    let b = warp_to_canvas(&src, &cam, &canvas, [1.1, 0.9, 1.0], None);
    assert_eq!(a.r, b.r);
    assert_eq!(a.g, b.g);
    assert_eq!(a.b, b.b);
    assert_eq!(a.validity, b.validity);
}

/// Pole-containing frame gets the full x span (it covers every
/// longitude on a spherical canvas).
#[test]
fn pole_frame_gets_full_x_span() {
    // Pitch the camera straight up (+90° about +X looks at −Y).
    let cam = Camera::new(
        [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        60.0,
        0.0,
        0.0,
        64,
        48,
    );
    let canvas = CanvasSpec::full_sphere(64).unwrap();
    let bbox = frame_canvas_bbox(&cam, &canvas, 0.0).expect("on canvas");
    assert_eq!(bbox.x_spans, vec![(0, canvas.width)]);
    assert_eq!(bbox.y0, 0, "zenith frame reaches the top row");
}

#[test]
fn rotation_accessor_used_by_tests_matches_identity() {
    // Guard: aligned_canvas relies on Mat3::identity for the
    // unrotated case staying exact.
    let i = Mat3::identity();
    assert_eq!(
        i.mul_vec(Vec3::new(0.3, -0.2, 0.9)),
        Vec3::new(0.3, -0.2, 0.9)
    );
}
