//! Shared projection-space coordinate helpers for canvas-aware warp stages.
//!
//! These helpers mirror the coordinate conventions used by `warp::canvas`:
//! cylindrical and spherical canvases use the stored angular extents, while
//! rectilinear canvases use a centred pinhole camera model.

use nalgebra::Vector3;

use crate::types::{Camera, Projection};
use crate::warp::canvas::{Canvas, CanvasParams};
use crate::warp::distortion::inverse_distort_xy;

/// A point on the selected output projection surface.
///
/// Coordinate interpretation depends on `projection`:
///
/// - `Rectilinear`: `u` and `v` are normalised pinhole-plane coordinates.
/// - `Cylindrical`: `u` is azimuth theta in radians, `v` is normalised height.
/// - `Spherical`: `u` is longitude lambda in radians, `v` is latitude phi.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProjectionPoint {
    pub projection: Projection,
    pub u: f32,
    pub v: f32,
}

impl ProjectionPoint {
    pub fn rectilinear(x: f32, y: f32) -> Self {
        Self {
            projection: Projection::Rectilinear,
            u: x,
            v: y,
        }
    }

    pub fn cylindrical(theta: f32, h: f32) -> Self {
        Self {
            projection: Projection::Cylindrical,
            u: theta,
            v: h,
        }
    }

    pub fn spherical(lambda: f32, phi: f32) -> Self {
        Self {
            projection: Projection::Spherical,
            u: lambda,
            v: phi,
        }
    }

    #[inline]
    pub fn is_finite(self) -> bool {
        self.u.is_finite() && self.v.is_finite()
    }
}

/// Convert a canvas pixel coordinate into projection-space coordinates.
///
/// The mapping intentionally uses `x / width` and `y / height` for angular
/// canvases because that is the convention used by the existing canvas warper.
pub fn canvas_pixel_to_projection(canvas: &Canvas, x: f32, y: f32) -> Option<ProjectionPoint> {
    if !x.is_finite() || !y.is_finite() || canvas.width == 0 || canvas.height == 0 {
        return None;
    }

    match &canvas.params {
        CanvasParams::Rectilinear { focal, cx, cy } => {
            let (focal, cx, cy) = (*focal, *cx, *cy);
            if focal <= 0.0 || !focal.is_finite() || !cx.is_finite() || !cy.is_finite() {
                return None;
            }
            Some(ProjectionPoint::rectilinear(
                (x - cx) / focal,
                (y - cy) / focal,
            ))
        }
        CanvasParams::Cylindrical {
            theta_min,
            theta_max,
            h_min,
            h_max,
        } => {
            let (theta_min, theta_max, h_min, h_max) = (*theta_min, *theta_max, *h_min, *h_max);
            let theta_span = theta_max - theta_min;
            let h_span = h_max - h_min;
            if !theta_span.is_finite() || !h_span.is_finite() {
                return None;
            }
            let theta = theta_min + (x / canvas.width as f32) * theta_span;
            let h = h_min + (y / canvas.height as f32) * h_span;
            Some(ProjectionPoint::cylindrical(theta, h))
        }
        CanvasParams::Spherical {
            lambda_min,
            lambda_max,
            phi_min,
            phi_max,
        } => {
            let (lambda_min, lambda_max, phi_min, phi_max) =
                (*lambda_min, *lambda_max, *phi_min, *phi_max);
            let lambda_span = lambda_max - lambda_min;
            let phi_span = phi_max - phi_min;
            if !lambda_span.is_finite() || !phi_span.is_finite() {
                return None;
            }
            let lambda = lambda_min + (x / canvas.width as f32) * lambda_span;
            let phi = phi_min + (y / canvas.height as f32) * phi_span;
            Some(ProjectionPoint::spherical(lambda, phi))
        }
    }
}

/// Convert a projection-space point back into canvas pixel coordinates.
pub fn projection_to_canvas_pixel(canvas: &Canvas, point: ProjectionPoint) -> Option<(f32, f32)> {
    if !point.is_finite() || canvas.width == 0 || canvas.height == 0 {
        return None;
    }

    match &canvas.params {
        CanvasParams::Rectilinear { focal, cx, cy } => {
            let (focal, cx, cy) = (*focal, *cx, *cy);
            if point.projection != Projection::Rectilinear
                || focal <= 0.0
                || !focal.is_finite()
                || !cx.is_finite()
                || !cy.is_finite()
            {
                return None;
            }
            Some((point.u * focal + cx, point.v * focal + cy))
        }
        CanvasParams::Cylindrical {
            theta_min,
            theta_max,
            h_min,
            h_max,
        } => {
            let (theta_min, theta_max, h_min, h_max) = (*theta_min, *theta_max, *h_min, *h_max);
            if point.projection != Projection::Cylindrical {
                return None;
            }
            let theta_span = theta_max - theta_min;
            let h_span = h_max - h_min;
            if theta_span.abs() <= f32::EPSILON
                || h_span.abs() <= f32::EPSILON
                || !theta_span.is_finite()
                || !h_span.is_finite()
            {
                return None;
            }
            let x = ((point.u - theta_min) / theta_span) * canvas.width as f32;
            let y = ((point.v - h_min) / h_span) * canvas.height as f32;
            Some((x, y))
        }
        CanvasParams::Spherical {
            lambda_min,
            lambda_max,
            phi_min,
            phi_max,
        } => {
            let (lambda_min, lambda_max, phi_min, phi_max) =
                (*lambda_min, *lambda_max, *phi_min, *phi_max);
            if point.projection != Projection::Spherical {
                return None;
            }
            let lambda_span = lambda_max - lambda_min;
            let phi_span = phi_max - phi_min;
            if lambda_span.abs() <= f32::EPSILON
                || phi_span.abs() <= f32::EPSILON
                || !lambda_span.is_finite()
                || !phi_span.is_finite()
            {
                return None;
            }
            let x = ((point.u - lambda_min) / lambda_span) * canvas.width as f32;
            let y = ((point.v - phi_min) / phi_span) * canvas.height as f32;
            Some((x, y))
        }
    }
}

/// Forward-project an image-pixel coordinate into the canvas through
/// a camera's pose. Composes:
///
///   1. Image pixel `(px, py)` → ideal camera-space ray via
///      `K^{-1}` and inverse-Brown-Conrady distortion.
///   2. World point `world = R · ray + t` (planar-at-unit-depth
///      back-projection — same convention as `compute_canvas` and
///      the `warp_image_to_canvas` inverse path).
///   3. World → `ProjectionPoint` via the canvas's projection.
///   4. `ProjectionPoint` → canvas pixel via
///      `projection_to_canvas_pixel`.
///
/// Returns `None` for points behind the camera (`world.z ≤ ε` for
/// rectilinear) or points with degenerate world coordinates
/// (cylinder axis singularity, sphere centre).
///
/// Used by Stage C (global mesh solve) to convert AKAZE+RANSAC
/// inlier image-pixel coordinates into canvas coordinates so the
/// per-image mesh solver can attribute residuals to mesh
/// vertices.
pub fn image_pixel_to_canvas(
    camera: &Camera,
    image_width: u32,
    image_height: u32,
    canvas: &Canvas,
    px: f32,
    py: f32,
) -> Option<(f32, f32)> {
    if !px.is_finite() || !py.is_finite() {
        return None;
    }

    // Step 1: pixel → camera-space ray (ideal pinhole, distortion
    // inverted). Mirrors `canvas::ideal_ray_from_sensor_pixel`.
    let (cx, cy) = camera.principal_point_or_center(image_width, image_height);
    if camera.focal <= 0.0 || !camera.focal.is_finite() {
        return None;
    }
    let xn_d = (px as f64 - cx as f64) / camera.focal as f64;
    let yn_d = (py as f64 - cy as f64) / camera.focal as f64;
    let (xn, yn) = inverse_distort_xy(xn_d, yn_d, camera.distortion.k1, camera.distortion.k2);
    let ray_cam = Vector3::new(xn, yn, 1.0_f64);

    // Step 2: camera ray → world point. R is f32, ray is f64;
    // promote.
    let r = camera.rotation.cast::<f64>();
    let t = camera.translation.cast::<f64>();
    let world = r * ray_cam + t;

    // Step 3: world → projection point.
    let proj_point: ProjectionPoint = match &canvas.params {
        CanvasParams::Rectilinear { .. } => {
            if world.z.abs() < 1e-9 {
                return None;
            }
            ProjectionPoint::rectilinear((world.x / world.z) as f32, (world.y / world.z) as f32)
        }
        CanvasParams::Cylindrical { .. } => {
            let denom = (world.x * world.x + world.z * world.z).sqrt();
            if denom < 1e-9 {
                return None;
            }
            let theta = world.x.atan2(world.z) as f32;
            let h = (world.y / denom) as f32;
            ProjectionPoint::cylindrical(theta, h)
        }
        CanvasParams::Spherical { .. } => {
            let radius = (world.x * world.x + world.y * world.y + world.z * world.z).sqrt();
            if radius < 1e-9 {
                return None;
            }
            let lambda = world.x.atan2(world.z) as f32;
            let phi = (world.y / radius).clamp(-1.0, 1.0).asin() as f32;
            ProjectionPoint::spherical(lambda, phi)
        }
    };

    // Step 4: projection → canvas pixel.
    projection_to_canvas_pixel(canvas, proj_point)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CameraIntrinsics, Distortion};
    use nalgebra::Matrix3;

    fn make_camera(focal: f32, w: u32, h: u32) -> Camera {
        Camera {
            focal,
            principal_point: None,
            rotation: Matrix3::<f32>::identity(),
            translation: nalgebra::Vector3::zeros(),
            distortion: Distortion::default(),
        }
    }

    fn make_rectilinear_canvas(w: u32, h: u32, focal: f32) -> Canvas {
        Canvas {
            width: w,
            height: h,
            projection: Projection::Rectilinear,
            params: CanvasParams::Rectilinear {
                focal,
                cx: w as f32 * 0.5,
                cy: h as f32 * 0.5,
            },
        }
    }

    /// Round-trip: canvas pixel → projection → canvas pixel
    /// recovers the original. (Sanity check on the existing
    /// helpers; the new forward-project test below depends on
    /// these being correct.)
    #[test]
    fn rectilinear_canvas_pixel_round_trip() {
        let canvas = make_rectilinear_canvas(800, 600, 500.0);
        let pp = canvas_pixel_to_projection(&canvas, 423.0, 311.0).expect("project");
        let (x, y) = projection_to_canvas_pixel(&canvas, pp).expect("unproject");
        assert!((x - 423.0).abs() < 1e-3, "got {}", x);
        assert!((y - 311.0).abs() < 1e-3, "got {}", y);
    }

    /// Identity camera + rectilinear canvas with the same focal as
    /// the camera: the centre of the input image (cx, cy) maps to
    /// the centre of the canvas.
    #[test]
    fn image_pixel_to_canvas_identity_centre() {
        let cam = make_camera(500.0, 800, 600);
        let canvas = make_rectilinear_canvas(800, 600, 500.0);
        // Image principal point (400, 300) → camera ray (0, 0, 1) →
        // world (0, 0, 1) → rectilinear (0, 0) → canvas centre (400, 300).
        let (cx, cy) = image_pixel_to_canvas(&cam, 800, 600, &canvas, 400.0, 300.0)
            .expect("forward projection");
        assert!((cx - 400.0).abs() < 1e-3, "cx = {}", cx);
        assert!((cy - 300.0).abs() < 1e-3, "cy = {}", cy);
    }

    /// Off-axis image pixel maps to a corresponding canvas pixel.
    /// Image pixel `(450, 300)` is 50 px right of the principal
    /// point, focal 500 → normalised x = 0.1. Identity rotation
    /// → world `(0.1, 0, 1)`. Rectilinear canvas focal 500, cx
    /// 400 → canvas pixel `(0.1 × 500 + 400, 300)` = `(450, 300)`.
    #[test]
    fn image_pixel_to_canvas_off_axis_identity_camera() {
        let cam = make_camera(500.0, 800, 600);
        let canvas = make_rectilinear_canvas(800, 600, 500.0);
        let (cx, cy) = image_pixel_to_canvas(&cam, 800, 600, &canvas, 450.0, 300.0)
            .expect("forward projection");
        assert!((cx - 450.0).abs() < 1e-2, "cx = {}", cx);
        assert!((cy - 300.0).abs() < 1e-2, "cy = {}", cy);
    }

    /// Non-finite pixel coords return None.
    #[test]
    fn image_pixel_to_canvas_rejects_nan() {
        let cam = make_camera(500.0, 800, 600);
        let canvas = make_rectilinear_canvas(800, 600, 500.0);
        assert!(image_pixel_to_canvas(&cam, 800, 600, &canvas, f32::NAN, 300.0).is_none());
    }

    // Suppress dead-code warning on unused field.
    #[allow(dead_code)]
    fn _check_intrinsics_type_exists() {
        let _: CameraIntrinsics;
    }
}
