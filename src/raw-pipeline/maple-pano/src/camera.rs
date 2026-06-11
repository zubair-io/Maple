//! Pinhole camera model with axis-angle pose and k1/k2 radial distortion.
//!
//! # Conventions (binding)
//!
//! - **Camera frame:** +X right, +Y down, **+Z = optical axis** (looking
//!   direction). Right-handed, matching the world frame (see crate docs).
//! - **Pose:** the stored rotation is **camera-to-world**:
//!   `d_world = R · d_cam`. It is constructed from a Rodrigues axis-angle
//!   vector (`R = exp([ω]×)`, [`crate::math::axis_angle_to_matrix`]) — the
//!   same `ω` that `ground_truth.json` records. Pure rotation: all cameras
//!   share the world origin (the rotation-model pano assumption).
//! - **Pixels:** continuous coordinates; pixel `(ix, iy)` covers
//!   `[ix, ix+1) × [iy, iy+1)` with its center at `(ix + 0.5, iy + 0.5)`.
//!   `(0, 0)` is the top-left corner of the image. The principal point is
//!   fixed at the image center `(width/2, height/2)`.
//! - **Intrinsics:** single focal length in pixels (square pixels), radial
//!   distortion per [`crate::distortion`] applied in ideal normalized
//!   coordinates.
//!
//! Forward projection (world → pixel):
//! `d_cam = Rᵀ·d_world` → require `z > 0` → ideal `(x, y) = (d.x/d.z,
//! d.y/d.z)` → distort → `px = f·x_d + cx, py = f·y_d + cy`.
//! Back-projection (pixel → world) is the exact inverse chain, using the
//! Newton inverse of the distortion polynomial.

use crate::distortion::{distort, undistort};
use crate::math::{axis_angle_to_matrix, Mat3, Vec3};

/// A posed pinhole camera with radial distortion.
#[derive(Debug, Clone)]
pub struct Camera {
    /// Camera-to-world rotation (`d_world = rotation · d_cam`).
    pub rotation: Mat3,
    /// The Rodrigues vector `rotation` was built from (radians).
    pub axis_angle: [f64; 3],
    /// Focal length in pixels.
    pub focal_px: f64,
    /// Radial distortion coefficients (see [`crate::distortion`]).
    pub k1: f64,
    pub k2: f64,
    /// Image size in pixels.
    pub width: u32,
    pub height: u32,
}

impl Camera {
    /// Build a camera from an axis-angle pose and intrinsics.
    pub fn new(
        axis_angle: [f64; 3],
        focal_px: f64,
        k1: f64,
        k2: f64,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            rotation: axis_angle_to_matrix(axis_angle),
            axis_angle,
            focal_px,
            k1,
            k2,
            width,
            height,
        }
    }

    /// Principal point — fixed at the image center in continuous pixel
    /// coordinates.
    pub fn principal_point(&self) -> (f64, f64) {
        (self.width as f64 * 0.5, self.height as f64 * 0.5)
    }

    /// Horizontal field of view (degrees) implied by `focal_px` and
    /// `width`, ignoring distortion.
    pub fn hfov_deg(&self) -> f64 {
        2.0 * ((self.width as f64 * 0.5) / self.focal_px)
            .atan()
            .to_degrees()
    }

    /// Back-project a continuous pixel coordinate to a unit direction in
    /// the **camera frame** (+X right, +Y down, +Z optical axis), ignoring
    /// the pose entirely.
    ///
    /// This is the bearing used by two-view geometry
    /// ([`crate::twoview`]), where the pose is the unknown being solved
    /// for — only the intrinsics (`focal_px`, `k1`, `k2`, principal
    /// point) participate. Same domain/`None` semantics as
    /// [`Self::pixel_to_world_dir`].
    pub fn pixel_to_camera_dir(&self, px: f64, py: f64) -> Option<Vec3> {
        let (cx, cy) = self.principal_point();
        let xd = (px - cx) / self.focal_px;
        let yd = (py - cy) / self.focal_px;
        let (x, y) = undistort(xd, yd, self.k1, self.k2)?;
        Vec3::new(x, y, 1.0).normalized()
    }

    /// Back-project a continuous pixel coordinate to a unit world
    /// direction.
    ///
    /// The pixel may lie outside the image bounds (rays extrapolate fine);
    /// returns `None` only when the distortion polynomial is not invertible
    /// at that radius (see [`crate::distortion::undistort`]).
    pub fn pixel_to_world_dir(&self, px: f64, py: f64) -> Option<Vec3> {
        let d_cam = self.pixel_to_camera_dir(px, py)?;
        Some(self.rotation.mul_vec(d_cam))
    }

    /// Project a world direction to a continuous pixel coordinate.
    ///
    /// Returns `None` for directions at or behind the camera plane
    /// (`z_cam ≤ 0`). The returned pixel may lie outside the image bounds —
    /// callers decide what "inside the frame" means (e.g. with a margin).
    pub fn world_dir_to_pixel(&self, d_world: Vec3) -> Option<(f64, f64)> {
        let d_cam = self.rotation.transpose().mul_vec(d_world);
        if d_cam.z <= 1e-12 {
            return None;
        }
        let x = d_cam.x / d_cam.z;
        let y = d_cam.y / d_cam.z;
        let (xd, yd) = distort(x, y, self.k1, self.k2);
        let (cx, cy) = self.principal_point();
        Some((self.focal_px * xd + cx, self.focal_px * yd + cy))
    }

    /// `true` if a continuous pixel coordinate lies within the image,
    /// at least `margin` pixels away from every edge.
    pub fn pixel_in_bounds(&self, px: f64, py: f64, margin: f64) -> bool {
        px >= margin
            && py >= margin
            && px <= self.width as f64 - margin
            && py <= self.height as f64 - margin
    }
}

/// Focal length in pixels for a horizontal field of view (degrees) on an
/// image `width` pixels wide: `f = (width/2) / tan(hfov/2)`.
pub fn focal_px_for_hfov(hfov_deg: f64, width: u32) -> f64 {
    (width as f64 * 0.5) / (hfov_deg.to_radians() * 0.5).tan()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::FRAC_PI_2;

    #[test]
    fn identity_camera_center_pixel_looks_along_plus_z() {
        let cam = Camera::new([0.0; 3], 500.0, 0.0, 0.0, 800, 600);
        let d = cam.pixel_to_world_dir(400.0, 300.0).unwrap();
        assert!((d - Vec3::new(0.0, 0.0, 1.0)).norm() < 1e-12);
        let (px, py) = cam.world_dir_to_pixel(Vec3::new(0.0, 0.0, 1.0)).unwrap();
        assert!((px - 400.0).abs() < 1e-9 && (py - 300.0).abs() < 1e-9);
    }

    #[test]
    fn yawed_camera_looks_east() {
        // +90° about +Y: optical axis lands on +X (east).
        let cam = Camera::new([0.0, FRAC_PI_2, 0.0], 500.0, 0.0, 0.0, 800, 600);
        let d = cam.pixel_to_world_dir(400.0, 300.0).unwrap();
        assert!((d - Vec3::new(1.0, 0.0, 0.0)).norm() < 1e-12);
    }

    /// Covers the full K / R / distortion chain in both directions.
    #[test]
    fn pixel_dir_round_trip_with_and_without_distortion() {
        let cases = [
            ([0.0, 0.0, 0.0], 0.0, 0.0),
            ([0.2, -0.6, 0.1], 0.0, 0.0),
            ([0.0, 1.1, 0.0], -0.06, 0.025),
            ([-0.4, 2.0, 0.3], -0.12, 0.04),
        ];
        for (omega, k1, k2) in cases {
            let cam = Camera::new(omega, 700.0, k1, k2, 1024, 768);
            for ix in (32..1024).step_by(96) {
                for iy in (32..768).step_by(96) {
                    let (px, py) = (ix as f64 + 0.5, iy as f64 + 0.5);
                    let d = cam.pixel_to_world_dir(px, py).expect("invertible in-frame");
                    let (qx, qy) = cam.world_dir_to_pixel(d).expect("in front");
                    assert!(
                        (qx - px).abs() < 1e-6 && (qy - py).abs() < 1e-6,
                        "round trip failed at ({px},{py}) ω={omega:?} k=({k1},{k2}): \
                         got ({qx},{qy})"
                    );
                }
            }
        }
    }

    /// The camera-frame bearing is pose-independent, and the pose maps it
    /// to the world direction.
    #[test]
    fn camera_dir_ignores_pose_and_world_dir_applies_it() {
        let posed = Camera::new([0.3, -1.1, 0.2], 700.0, -0.06, 0.025, 1024, 768);
        let unposed = Camera::new([0.0; 3], 700.0, -0.06, 0.025, 1024, 768);
        for (px, py) in [(512.0, 384.0), (100.5, 50.5), (900.0, 700.0)] {
            let bearing = posed.pixel_to_camera_dir(px, py).unwrap();
            let same = unposed.pixel_to_camera_dir(px, py).unwrap();
            assert!((bearing - same).norm() < 1e-15, "bearing depends on pose");
            let world = posed.pixel_to_world_dir(px, py).unwrap();
            assert!(
                (posed.rotation.mul_vec(bearing) - world).norm() < 1e-15,
                "world dir must be rotation · camera dir"
            );
        }
    }

    #[test]
    fn directions_behind_camera_do_not_project() {
        let cam = Camera::new([0.0; 3], 500.0, 0.0, 0.0, 800, 600);
        assert!(cam.world_dir_to_pixel(Vec3::new(0.0, 0.0, -1.0)).is_none());
        assert!(cam.world_dir_to_pixel(Vec3::new(1.0, 0.0, 0.0)).is_none());
    }

    #[test]
    fn focal_for_90_degree_fov_is_half_width() {
        let f = focal_px_for_hfov(90.0, 1000);
        assert!((f - 500.0).abs() < 1e-9);
        let cam = Camera::new([0.0; 3], f, 0.0, 0.0, 1000, 750);
        assert!((cam.hfov_deg() - 90.0).abs() < 1e-9);
    }

    #[test]
    fn barrel_distortion_pulls_corners_inward() {
        let ideal = Camera::new([0.0; 3], 500.0, 0.0, 0.0, 800, 600);
        let barrel = Camera::new([0.0; 3], 500.0, -0.1, 0.0, 800, 600);
        // A ray off the axis lands closer to the principal point with
        // barrel distortion than without.
        let d = ideal.pixel_to_world_dir(700.0, 500.0).unwrap();
        let (ix, iy) = ideal.world_dir_to_pixel(d).unwrap();
        let (bx, by) = barrel.world_dir_to_pixel(d).unwrap();
        let r_ideal = ((ix - 400.0).powi(2) + (iy - 300.0).powi(2)).sqrt();
        let r_barrel = ((bx - 400.0).powi(2) + (by - 300.0).powi(2)).sqrt();
        assert!(
            r_barrel < r_ideal,
            "barrel must compress: {r_barrel} vs {r_ideal}"
        );
    }
}
