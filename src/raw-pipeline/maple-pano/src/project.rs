//! Projection surfaces: forward (direction → surface coords) and inverse
//! (surface coords → direction) maps for the three pano output projections.
//!
//! # Conventions (binding — see also the crate-level docs)
//!
//! **World frame** is right-handed with **+X east, +Y down (nadir),
//! +Z forward** (the direction of longitude 0 / latitude 0). "Up" (zenith)
//! is **−Y**.
//!
//! Surface coordinates `(u, v)` per projection:
//!
//! | Projection    | `u`                              | `v`                                |
//! | ------------- | -------------------------------- | ---------------------------------- |
//! | `Rectilinear` | `x/z` (plane at z = 1)           | `y/z` — **increases downward**     |
//! | `Cylindrical` | `θ = atan2(x, z)` (radians)      | `−y/√(x²+z²)` — **increases up**   |
//! | `Spherical`   | `λ = atan2(x, z)` (radians)      | `φ = asin(−y)` — **increases up**  |
//!
//! - `u` for the angular projections is the **longitude/azimuth**: 0 at +Z,
//!   increasing toward +X (eastward), range `(−π, π]` out of `forward`.
//! - The two angular projections share a positive-up vertical axis
//!   (`v = 0` on the horizon); rectilinear keeps the image-plane convention
//!   (`v` down) because it *is* an ideal pinhole image plane.
//! - `Spherical` doubles as the **equirectangular** mapping: an equirect
//!   image of width W, height H covers `λ ∈ [−π, π)`, `φ ∈ [−π/2, π/2]`
//!   with pixel mapping `u_px = (λ/2π + 0.5)·W`, `v_px = (0.5 − φ/π)·H`
//!   (top row = zenith). That pixel mapping lives in
//!   [`crate::source::EquirectSource`]; this module stays in angles.

use crate::math::Vec3;

/// Output projection surface for a stitched panorama.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    /// Ideal pinhole plane at `z = 1`. Only the `z > 0` hemisphere maps.
    Rectilinear,
    /// Unit-radius cylinder around the world Y axis.
    Cylindrical,
    /// Unit sphere, longitude/latitude (equirectangular) parameterization.
    Spherical,
}

impl Projection {
    /// Forward map: world direction → projection-surface coordinates.
    ///
    /// `dir` need not be unit length (only its direction is used). Returns
    /// `None` for directions the surface cannot represent:
    ///
    /// - `Rectilinear`: directions with `z ≤ 0` (behind the plane) —
    ///   including straight up/down.
    /// - `Cylindrical`: the poles (`x = z = 0`), where azimuth is undefined.
    /// - `Spherical`: total only for non-zero input.
    /// - All: zero-length input.
    pub fn forward(self, dir: Vec3) -> Option<(f64, f64)> {
        let d = dir.normalized()?;
        match self {
            Projection::Rectilinear => {
                if d.z <= 1e-12 {
                    return None;
                }
                Some((d.x / d.z, d.y / d.z))
            }
            Projection::Cylindrical => {
                let rho = (d.x * d.x + d.z * d.z).sqrt();
                if rho < 1e-12 {
                    return None;
                }
                Some((d.x.atan2(d.z), -d.y / rho))
            }
            Projection::Spherical => {
                let lambda = d.x.atan2(d.z);
                let phi = (-d.y).clamp(-1.0, 1.0).asin();
                Some((lambda, phi))
            }
        }
    }

    /// Inverse map: projection-surface coordinates → unit world direction.
    ///
    /// Total for `Rectilinear` and `Cylindrical` (any finite `(u, v)`); for
    /// `Spherical`, `v` (latitude) must lie in `[−π/2, π/2]` — outside that
    /// range returns `None`. `u` beyond `(−π, π]` wraps naturally for the
    /// angular projections.
    pub fn inverse(self, u: f64, v: f64) -> Option<Vec3> {
        if !u.is_finite() || !v.is_finite() {
            return None;
        }
        match self {
            Projection::Rectilinear => Vec3::new(u, v, 1.0).normalized(),
            Projection::Cylindrical => {
                let (s, c) = u.sin_cos();
                Vec3::new(s, -v, c).normalized()
            }
            Projection::Spherical => {
                if !(-std::f64::consts::FRAC_PI_2..=std::f64::consts::FRAC_PI_2).contains(&v) {
                    return None;
                }
                let (sl, cl) = u.sin_cos();
                let (sp, cp) = v.sin_cos();
                Some(Vec3::new(cp * sl, -sp, cp * cl))
            }
        }
    }
}

/// Longitude/latitude of a world direction — the `Spherical` forward map
/// with a tuple-free signature, used directly by the equirect sampler.
///
/// Returns `(λ, φ)`: longitude `atan2(x, z) ∈ (−π, π]`, latitude
/// `asin(−y) ∈ [−π/2, π/2]` (positive up). `dir` need not be unit length.
#[inline]
pub fn dir_to_lonlat(dir: Vec3) -> Option<(f64, f64)> {
    Projection::Spherical.forward(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{FRAC_PI_2, PI};

    const ALL: [Projection; 3] = [
        Projection::Rectilinear,
        Projection::Cylindrical,
        Projection::Spherical,
    ];

    /// Unit direction from spherical angles (the test's own independent
    /// construction, mirroring the documented convention).
    fn dir(lon_deg: f64, lat_deg: f64) -> Vec3 {
        let l = lon_deg.to_radians();
        let p = lat_deg.to_radians();
        Vec3::new(p.cos() * l.sin(), -p.sin(), p.cos() * l.cos())
    }

    /// dir → (u, v) → dir round-trips within 1e-5 (component-wise on unit
    /// vectors) across a grid of directions, for all three projections.
    /// The grid keeps each direction inside the projection's domain:
    /// rectilinear needs z > 0; cylindrical/spherical avoid the exact poles.
    #[test]
    fn forward_inverse_round_trip_grid_of_directions() {
        for proj in ALL {
            let mut checked = 0;
            for lon_step in -11..=11 {
                for lat_step in -5..=5 {
                    let lon = lon_step as f64 * 15.0; // −165° … 165°
                    let lat = lat_step as f64 * 15.0; // −75° … 75°
                    if proj == Projection::Rectilinear && (lon.abs() > 65.0 || lat.abs() > 65.0) {
                        continue; // stay safely inside the z > 0 hemisphere
                    }
                    let d = dir(lon, lat);
                    let (u, v) = proj.forward(d).expect("in-domain direction");
                    let back = proj.inverse(u, v).expect("inverse in range");
                    let err = (d - back).norm();
                    assert!(
                        err < 1e-5,
                        "{proj:?} round trip at lon {lon} lat {lat}: err {err}"
                    );
                    checked += 1;
                }
            }
            assert!(
                checked > 50,
                "{proj:?}: grid unexpectedly small ({checked})"
            );
        }
    }

    /// (u, v) → dir → (u, v) round-trips within 1e-5 across a grid of
    /// surface coordinates, for all three projections.
    #[test]
    fn inverse_forward_round_trip_grid_of_coords() {
        for proj in ALL {
            for i in -8..=8 {
                for j in -6..=6 {
                    let (u, v) = match proj {
                        // Plane coords; |u| up to ~2.4 ≈ 67° off-axis.
                        Projection::Rectilinear => (i as f64 * 0.3, j as f64 * 0.3),
                        // θ ∈ (−π, π), h ∈ [−1.8, 1.8].
                        Projection::Cylindrical => (i as f64 * (PI / 8.5), j as f64 * 0.3),
                        // λ ∈ (−π, π), φ ∈ (−π/2, π/2) excluding poles.
                        Projection::Spherical => {
                            (i as f64 * (PI / 8.5), j as f64 * (FRAC_PI_2 / 6.5))
                        }
                    };
                    let d = proj.inverse(u, v).expect("inverse total on grid");
                    let (u2, v2) = proj.forward(d).expect("forward of inverse");
                    assert!(
                        (u - u2).abs() < 1e-5 && (v - v2).abs() < 1e-5,
                        "{proj:?} coord round trip at ({u}, {v}): got ({u2}, {v2})"
                    );
                }
            }
        }
    }

    /// Known values pin the sign conventions: +Z is (0,0); +X (east) is
    /// u = +π/2 for the angular projections; up (−Y) is positive v.
    #[test]
    fn known_directions_pin_conventions() {
        let east = Vec3::new(1.0, 0.0, 0.0);
        let up = Vec3::new(0.0, -1.0, 0.0);
        let forward = Vec3::new(0.0, 0.0, 1.0);

        for proj in ALL {
            let (u, v) = proj.forward(forward).unwrap();
            assert!(u.abs() < 1e-12 && v.abs() < 1e-12, "{proj:?} forward(+Z)");
        }
        for proj in [Projection::Cylindrical, Projection::Spherical] {
            let (u, _) = proj.forward(east).unwrap();
            assert!(
                (u - FRAC_PI_2).abs() < 1e-12,
                "{proj:?} forward(+X) azimuth"
            );
        }
        // Up: spherical hits the pole at φ = +π/2; cylindrical rejects it.
        let (_, phi) = Projection::Spherical.forward(up).unwrap();
        assert!((phi - FRAC_PI_2).abs() < 1e-12);
        assert_eq!(Projection::Cylindrical.forward(up), None);
        // Slightly-off-pole "mostly up" must give positive v on both.
        let near_up = dir(0.0, 80.0);
        let (_, v_cyl) = Projection::Cylindrical.forward(near_up).unwrap();
        let (_, v_sph) = Projection::Spherical.forward(near_up).unwrap();
        assert!(v_cyl > 0.0 && v_sph > 0.0, "positive v must mean up");
        // Rectilinear v is image-convention: up (−Y component) → negative v.
        let (_, v_rect) = Projection::Rectilinear.forward(near_up).unwrap();
        assert!(v_rect < 0.0, "rectilinear v increases downward");
    }

    #[test]
    fn out_of_domain_inputs_return_none() {
        // Behind the rectilinear plane.
        assert_eq!(
            Projection::Rectilinear.forward(Vec3::new(0.0, 0.0, -1.0)),
            None
        );
        // Zero vector everywhere.
        for proj in ALL {
            assert_eq!(proj.forward(Vec3::new(0.0, 0.0, 0.0)), None);
        }
        // Spherical latitude out of range.
        assert_eq!(Projection::Spherical.inverse(0.0, 2.0), None);
        // Non-finite coords.
        assert_eq!(Projection::Cylindrical.inverse(f64::NAN, 0.0), None);
    }
}
