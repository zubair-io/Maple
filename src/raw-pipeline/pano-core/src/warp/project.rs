//! Shared projection-space coordinate helpers for canvas-aware warp stages.
//!
//! These helpers mirror the coordinate conventions used by `warp::canvas`:
//! cylindrical and spherical canvases use the stored angular extents, while
//! rectilinear canvases use a centred pinhole camera model.

use crate::types::Projection;
use crate::warp::canvas::{Canvas, CanvasParams};

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
