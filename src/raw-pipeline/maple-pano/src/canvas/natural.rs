//! Natural (pre-cap) canvas size probe for the degenerate-solution guard.
//! Split from `auto.rs` for the file budget.

use std::f64::consts::{FRAC_PI_2, TAU};

use super::auto::{circular_window, sample_camera};
use super::transverse::{choose_projection, rolled_samples, upright};
use super::{CameraSamples, CanvasOptions};
use crate::camera::Camera;
use crate::math::{Mat3, Vec3};
use crate::project::Projection;

/// Ratio of the natural (unclamped, pre-cap) canvas pixel count to
/// `max_pixels` for the given camera set and cap.
///
/// A ratio >> 1 means the pixel cap would crush resolution to a degree
/// that makes the rotation composite meaningless. A translational /
/// near-parallel set forced through the rotation path can produce ratios
/// in the millions because the BA solution places cameras at nearly
/// identical orientations — the projected extent covers an enormous
/// fraction of the sphere at the per-pixel density of the source frames,
/// but the actual overlap is a sliver of that extent.
///
/// This function is cheap: it samples cameras (same work as `auto_canvas`)
/// but exits after computing the natural extent, before allocating anything.
/// Returns `None` when the samples are invalid (same conditions that would
/// make `auto_canvas` return `PanoError::InvalidOptions`).
pub fn natural_canvas_pixel_ratio(cameras: &[Camera], opts: &CanvasOptions) -> Option<f64> {
    if cameras.is_empty() || opts.max_pixels == 0 {
        return None;
    }
    let samples: Result<Vec<_>, _> = cameras.iter().map(sample_camera).collect();
    let samples = samples.ok()?;

    let density = samples
        .iter()
        .map(|s| s.max_density)
        .fold(0.0_f64, f64::max);
    if !(density.is_finite() && density > 0.0) {
        return None;
    }
    let step = 1.0 / density;

    let (projection, basis) = choose_projection(cameras, &samples, opts.projection);
    let natural_pixels = match projection {
        Projection::Rectilinear => rectilinear_natural_pixels(&samples, step)?,
        Projection::Cylindrical | Projection::Spherical => {
            angular_natural_pixels(projection, &samples, step)?
        }
        Projection::TransverseCylindrical | Projection::TransverseSpherical => {
            let rolled = rolled_samples(cameras, basis).ok()?;
            angular_natural_pixels(upright(projection), &rolled, step)?
        }
    };

    if !natural_pixels.is_finite() || natural_pixels <= 0.0 {
        return None;
    }
    Some(natural_pixels / opts.max_pixels as f64)
}

/// Tangent-plane extent at the content centroid, mirroring
/// `rectilinear_canvas`.
fn rectilinear_natural_pixels(samples: &[CameraSamples], step: f64) -> Option<f64> {
    let c = samples
        .iter()
        .flat_map(|s| s.dirs.iter().copied())
        .fold(Vec3::new(0.0, 0.0, 0.0), |acc, d| acc + d)
        .normalized()?;
    let yaw = c.x.atan2(c.z);
    let pitch = (-c.y).clamp(-1.0, 1.0).asin();
    let rot_inv = Mat3::rotation_y(yaw)
        .mul_mat(&Mat3::rotation_x(pitch))
        .transpose();

    let mut u_min = f64::INFINITY;
    let mut u_max = f64::NEG_INFINITY;
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for s in samples {
        for d in &s.dirs {
            if let Some((u, v)) = Projection::Rectilinear.forward(rot_inv.mul_vec(*d)) {
                u_min = u_min.min(u);
                u_max = u_max.max(u);
                v_min = v_min.min(v);
                v_max = v_max.max(v);
            }
        }
    }
    if !u_min.is_finite() {
        return None;
    }
    let w = ((u_max - u_min) / step).ceil().max(1.0);
    let h = ((v_max - v_min) / step).ceil().max(1.0);
    Some(w * h)
}

/// Longitude + vertical ranges on a standard angular surface, mirroring
/// `angular_canvas`.
fn angular_natural_pixels(
    projection: Projection,
    samples: &[CameraSamples],
    step: f64,
) -> Option<f64> {
    let any_pole_frame = samples.iter().any(|s| s.lon_window.is_none());
    let windows: Vec<(f64, f64)> = samples.iter().filter_map(|s| s.lon_window).collect();
    let lon_window = if any_pole_frame || windows.is_empty() {
        None
    } else {
        circular_window(&windows)
    };

    let v_limit = match projection {
        Projection::Spherical => FRAC_PI_2,
        _ => 85.0_f64.to_radians().tan(),
    };
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for s in samples {
        for d in &s.dirs {
            if let Some((_, v)) = projection.forward(*d) {
                v_min = v_min.min(v);
                v_max = v_max.max(v);
            }
        }
        if s.sees_zenith {
            v_max = v_limit;
        }
        if s.sees_nadir {
            v_min = -v_limit;
        }
    }
    if !(v_min.is_finite() && v_max.is_finite()) {
        return None;
    }

    let u_range = match lon_window {
        None => TAU,
        Some((lo, hi)) => (hi - lo).min(TAU),
    };
    let w = (u_range / step).ceil().max(1.0);
    let h = ((v_max - v_min) / step).ceil().max(1.0);
    Some(w * h)
}
