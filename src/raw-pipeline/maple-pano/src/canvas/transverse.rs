//! Transverse canvases for vertical pitch sweeps (#4518).
//!
//! # Detection
//!
//! The camera optical axes are measured in a gravity-aligned basis whose
//! +X is the horizontal pitch axis that best fits the sweep (the minor
//! axis of the axes' horizontal scatter) and whose +Z faces the sweep's
//! horizontal mean. In that basis the pitch extent is the circular span
//! of `atan2(−y, z)` — the transverse `v`, which stays continuous over
//! the zenith — and the yaw extent is the span of `asin(x)` across the
//! sweep. A set is a pitch sweep when the pitch extent exceeds 55° and
//! 1.3 × the yaw extent; above 120° it gets the transverse sphere.
//!
//! A level yaw ring has no meaningful pitch plane (its horizontal scatter
//! is isotropic, so the fitted basis is arbitrary and `v` collapses onto
//! 0 and π); such sets are rejected because their cross-sweep spread
//! exceeds their elevation spread — the pitch-plane model explains them
//! worse than the vertical-axis model the standard surfaces assume.
//!
//! # Canvas
//!
//! A transverse surface is the standard one after a 90° roll about Z:
//! for `d_r = Rz(π/2) · d`, standard `(λ, φ)` of `d_r` equals transverse
//! `(v, −u)` of `d`. So the canvas is built by running the standard
//! angular-canvas policy on cameras re-posed into that rolled frame, then
//! transposing the window: columns carry `u`, rows carry the periodic
//! `v` (wrap seam between the top and bottom rows).

use std::f64::consts::{FRAC_PI_2, TAU};

use super::auto::{angular_canvas, circular_window, extent_deg_of, sample_camera};
use super::{select_projection, CameraSamples, CanvasOptions, CanvasSpec, ProjectionMode};
use crate::camera::Camera;
use crate::eigen::eigen_symmetric;
use crate::error::PanoError;
use crate::math::{matrix_to_axis_angle, Mat3, Vec3};
use crate::project::Projection;

const MIN_PITCH_EXTENT_DEG: f64 = 55.0;
const SPHERICAL_PITCH_EXTENT_DEG: f64 = 120.0;
const PITCH_DOMINANCE: f64 = 1.3;

/// Projection plus canvas-to-world basis for a camera set. The basis is
/// the identity for the standard surfaces and the fitted pitch basis for
/// the transverse ones.
pub(super) fn choose_projection(
    cameras: &[Camera],
    samples: &[CameraSamples],
    mode: ProjectionMode,
) -> (Projection, Mat3) {
    match mode {
        ProjectionMode::Force(p) if p.is_transverse() => (
            p,
            pitch_basis(&optical_axes(cameras)).unwrap_or(Mat3::identity()),
        ),
        ProjectionMode::Force(p) => (p, Mat3::identity()),
        ProjectionMode::Auto => detect_pitch_sweep(cameras)
            .unwrap_or_else(|| (select_projection(extent_deg_of(samples)), Mat3::identity())),
    }
}

/// Measured extents of a camera set in its fitted pitch basis (radians).
#[derive(Debug, Clone, Copy)]
pub(super) struct SweepExtents {
    pub pitch: f64,
    pub yaw: f64,
    pub elevation: f64,
}

pub(super) fn sweep_extents(cameras: &[Camera]) -> Option<(SweepExtents, Mat3)> {
    let axes = optical_axes(cameras);
    let basis = pitch_basis(&axes)?;
    let to_basis = basis.transpose();
    let local: Vec<Vec3> = axes.iter().map(|a| to_basis.mul_vec(*a)).collect();
    let pitch_points: Vec<(f64, f64)> = local
        .iter()
        .map(|a| {
            let v = (-a.y).atan2(a.z);
            (v, v)
        })
        .collect();
    let pitch = circular_window(&pitch_points).map_or(TAU, |(lo, hi)| hi - lo);
    let yaw = span(local.iter().map(|a| a.x.clamp(-1.0, 1.0).asin()));
    let elevation = span(axes.iter().map(|a| (-a.y).clamp(-1.0, 1.0).asin()));
    Some((
        SweepExtents {
            pitch,
            yaw,
            elevation,
        },
        basis,
    ))
}

fn detect_pitch_sweep(cameras: &[Camera]) -> Option<(Projection, Mat3)> {
    let (e, basis) = sweep_extents(cameras)?;
    let is_pitch_sweep = e.yaw < e.elevation
        && e.pitch > PITCH_DOMINANCE * e.yaw
        && e.pitch > MIN_PITCH_EXTENT_DEG.to_radians();
    let projection = if e.pitch > SPHERICAL_PITCH_EXTENT_DEG.to_radians() {
        Projection::TransverseSpherical
    } else {
        Projection::TransverseCylindrical
    };
    is_pitch_sweep.then_some((projection, basis))
}

fn span(values: impl Iterator<Item = f64>) -> f64 {
    let (lo, hi) = values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| {
        (lo.min(x), hi.max(x))
    });
    if lo.is_finite() {
        hi - lo
    } else {
        0.0
    }
}

fn optical_axes(cameras: &[Camera]) -> Vec<Vec3> {
    cameras
        .iter()
        .map(|c| c.rotation.mul_vec(Vec3::new(0.0, 0.0, 1.0)))
        .collect()
}

/// `Ry(ψ)` whose +X is the horizontal pitch axis of the sweep and whose
/// +Z faces the axes' horizontal mean. `None` when the axes have no
/// horizontal component to fit (every camera at a pole).
fn pitch_basis(axes: &[Vec3]) -> Option<Mat3> {
    let (sxx, sxz, szz) = axes.iter().fold((0.0, 0.0, 0.0), |(xx, xz, zz), a| {
        (xx + a.x * a.x, xz + a.x * a.z, zz + a.z * a.z)
    });
    let (values, vectors) = eigen_symmetric(&[[sxx, sxz], [sxz, szz]]);
    if values[0] <= 1e-12 * axes.len() as f64 {
        return None;
    }
    let [hx, hz] = vectors[0];
    let facing: f64 = axes.iter().map(|a| a.x * hx + a.z * hz).sum();
    let (hx, hz) = if facing < 0.0 { (-hx, -hz) } else { (hx, hz) };
    Some(Mat3::rotation_y(hx.atan2(hz)))
}

/// The standard surface a transverse projection is a rolled copy of.
pub(super) fn upright(projection: Projection) -> Projection {
    match projection {
        Projection::TransverseCylindrical => Projection::Cylindrical,
        Projection::TransverseSpherical => Projection::Spherical,
        other => other,
    }
}

/// Camera samples re-posed into the rolled frame `Rz(π/2) · basisᵀ`,
/// where the transverse surface becomes the upright one.
pub(super) fn rolled_samples(
    cameras: &[Camera],
    basis: Mat3,
) -> Result<Vec<CameraSamples>, PanoError> {
    let roll = Mat3::rotation_z(FRAC_PI_2).mul_mat(&basis.transpose());
    cameras
        .iter()
        .map(|cam| {
            let rotation = roll.mul_mat(&cam.rotation);
            sample_camera(&Camera {
                rotation,
                axis_angle: matrix_to_axis_angle(&rotation),
                ..cam.clone()
            })
        })
        .collect()
}

pub(super) fn transverse_canvas(
    projection: Projection,
    basis: Mat3,
    cameras: &[Camera],
    step: f64,
    opts: &CanvasOptions,
) -> Result<CanvasSpec, PanoError> {
    let samples = rolled_samples(cameras, basis)?;
    let rolled = angular_canvas(upright(projection), &samples, step, opts)?;
    Ok(CanvasSpec {
        projection,
        width: rolled.height,
        height: rolled.width,
        u0: -rolled.v0,
        v0: rolled.u0 + rolled.width as f64 * rolled.du,
        du: -rolled.dv,
        dv: -rolled.du,
        rotation: basis,
        rotation_inv: basis.transpose(),
        full_wrap: rolled.full_wrap,
    })
}
