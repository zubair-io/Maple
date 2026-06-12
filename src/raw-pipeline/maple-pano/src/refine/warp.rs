//! Local perspective compensation for the ZNCC template (#1210).
//!
//! Ring-pattern neighbors sit a large fraction of the FOV apart (the
//! pano_01 sweep: ~33° yaw at ~71° HFOV), and matches only exist in the
//! overlap strip — 25–35° off-axis, where the A→B local mapping is far
//! from a translation: the horizontal magnification ratio
//! `cos²θ_A / cos²θ_B` reaches ~0.7, i.e. a 13 px template's content
//! appears ~9 px wide in the other frame. Correlating an unwarped
//! template against that compression biases and broadens the ZNCC peak —
//! a systematic, strip-wide error that caps refinement accuracy exactly
//! where the matches live.
//!
//! The fix is first-order geometric compensation, standard in
//! coarse-to-fine alignment (KLT/patch-alignment practice): from the
//! pair's *verified* relative rotation and the cameras' intrinsics,
//! compute the local 2×2 Jacobian `J = ∂b/∂a` of the A→B pixel mapping
//! at the correspondence, and sample the template at
//! `a + J⁻¹·(u, v)` so template and search patches share frame B's
//! local geometry. The rotation is the robust verifier's estimate — a
//! few-milliradian error there perturbs `J` at second order, far below
//! the compensation it buys.
//!
//! Failure honesty: an unprojectable point (behind either camera) or a
//! degenerate/extreme Jacobian yields `None`, and the caller falls back
//! to the uncompensated (identity) template — never a fabricated warp.

use crate::camera::Camera;
use crate::distortion::distort;
use crate::math::{Mat3, Vec3};

/// The pair geometry the warp compensation runs on. Both cameras carry
/// FULL-RESOLUTION intrinsics; poses are **ignored** (the relative
/// rotation is passed explicitly, in the [`crate::twoview`] convention).
#[derive(Debug, Clone, Copy)]
pub struct RefineGeometry<'a> {
    /// Frame A intrinsics at full resolution (pose ignored).
    pub cam_a: &'a Camera,
    /// Frame B intrinsics at full resolution (pose ignored).
    pub cam_b: &'a Camera,
    /// Verified relative rotation: `d_b ≈ rotation · d_a` for
    /// camera-frame bearings ([`crate::graph::VerifiedEdge::rotation`]).
    pub rotation: &'a Mat3,
}

/// Central-difference step for the Jacobian, full-res pixels. The
/// mapping is smooth at this scale; 2 px keeps truncation and rounding
/// error both far below the compensation's own first-order remit.
const JACOBIAN_STEP_PX: f64 = 2.0;

/// Reject Jacobians whose determinant falls outside this band —
/// physically plausible pano overlap warps live well inside it; outside
/// it the first-order model is no longer trustworthy.
const DET_MIN: f64 = 0.1;
const DET_MAX: f64 = 10.0;

/// Inverse local Jacobian `J⁻¹` (row-major `[m00, m01, m10, m11]`) of
/// the A→B pixel mapping at `a` (full-res pixels): the matrix that takes
/// a B-frame displacement to the A-frame displacement sampling the same
/// scene content. `None` when the point does not map (behind a camera,
/// distortion not invertible) or the Jacobian is degenerate — the caller
/// proceeds uncompensated.
pub(super) fn local_warp_inverse(g: &RefineGeometry<'_>, a: (f64, f64)) -> Option<[f64; 4]> {
    let h = JACOBIAN_STEP_PX;
    let xp = map_a_to_b(g, (a.0 + h, a.1))?;
    let xm = map_a_to_b(g, (a.0 - h, a.1))?;
    let yp = map_a_to_b(g, (a.0, a.1 + h))?;
    let ym = map_a_to_b(g, (a.0, a.1 - h))?;
    let inv2h = 1.0 / (2.0 * h);
    // J rows: d(bx, by)/d(ax) in column 0, d(bx, by)/d(ay) in column 1.
    let j00 = (xp.0 - xm.0) * inv2h;
    let j10 = (xp.1 - xm.1) * inv2h;
    let j01 = (yp.0 - ym.0) * inv2h;
    let j11 = (yp.1 - ym.1) * inv2h;
    let det = j00 * j11 - j01 * j10;
    if !det.is_finite() || det.abs() < DET_MIN || det.abs() > DET_MAX {
        return None;
    }
    Some([j11 / det, -j01 / det, -j10 / det, j00 / det])
}

/// A-frame pixel → B-frame pixel through intrinsics + the relative
/// rotation (poses ignored on both sides).
fn map_a_to_b(g: &RefineGeometry<'_>, p: (f64, f64)) -> Option<(f64, f64)> {
    let d_a = g.cam_a.pixel_to_camera_dir(p.0, p.1)?;
    project_camera_frame(g.cam_b, g.rotation.mul_vec(d_a))
}

/// Project a camera-frame direction through intrinsics only (the
/// pose-free counterpart of [`Camera::world_dir_to_pixel`]).
fn project_camera_frame(cam: &Camera, d: Vec3) -> Option<(f64, f64)> {
    if d.z <= 1e-12 {
        return None;
    }
    let (xd, yd) = distort(d.x / d.z, d.y / d.z, cam.k1, cam.k2);
    let (cx, cy) = cam.principal_point();
    Some((cam.focal_px * xd + cx, cam.focal_px * yd + cy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::focal_px_for_hfov;

    fn cam(w: u32, h: u32, hfov_deg: f64) -> Camera {
        Camera::new([0.0; 3], focal_px_for_hfov(hfov_deg, w), 0.0, 0.0, w, h)
    }

    #[test]
    fn identity_pair_yields_identity_inverse_jacobian() {
        let c = cam(4000, 3000, 71.0);
        let g = RefineGeometry {
            cam_a: &c,
            cam_b: &c,
            rotation: &Mat3::identity(),
        };
        for p in [(2000.0, 1500.0), (3500.0, 500.0), (300.0, 2800.0)] {
            let m = local_warp_inverse(&g, p).expect("identity maps everywhere in-frame");
            for (got, want) in m.iter().zip([1.0, 0.0, 0.0, 1.0]) {
                assert!((got - want).abs() < 1e-6, "J⁻¹ {m:?} at {p:?}");
            }
        }
    }

    #[test]
    fn yawed_pair_matches_the_analytic_magnification() {
        // B yawed +33° from A (the pano_01 ring step). For a pixel on
        // A's horizontal centerline at angle θ off A's axis, the
        // analytic horizontal stretch of the A→B mapping is
        // cos²θ_A / cos²θ_B with θ_B = θ_A − yaw; vertical stretch is
        // cos θ_A / cos θ_B. J⁻¹ must reproduce both (no distortion).
        let yaw: f64 = 33.0_f64.to_radians();
        let c = cam(5280, 3956, 71.0);
        // d_b = R_bᵀ·R_a·d_a with A at identity: rotation = R_y(−yaw)
        // (B looks east of A; content sits west in B's frame).
        let rot = Mat3::rotation_y(-yaw);
        let g = RefineGeometry {
            cam_a: &c,
            cam_b: &c,
            rotation: &rot,
        };
        let (cx, cy) = c.principal_point();
        // Overlap-strip pixel: 28° east of A's axis.
        let theta_a = 28.0_f64.to_radians();
        let px = cx + c.focal_px * theta_a.tan();
        let m = local_warp_inverse(&g, (px, cy)).expect("strip pixel maps");
        let theta_b = theta_a - yaw;
        let dbx_dax = theta_a.cos().powi(2) / theta_b.cos().powi(2);
        let dby_day = theta_a.cos() / theta_b.cos();
        // m is J⁻¹: diagonal entries are the reciprocals.
        assert!(
            (m[0] - 1.0 / dbx_dax).abs() < 1e-3,
            "horizontal: got {} want {}",
            m[0],
            1.0 / dbx_dax
        );
        assert!(
            (m[3] - 1.0 / dby_day).abs() < 1e-3,
            "vertical: got {} want {}",
            m[3],
            1.0 / dby_day
        );
        // On the centerline the mapping has no shear.
        assert!(m[1].abs() < 1e-3 && m[2].abs() < 1e-3, "shear-free: {m:?}");
        // And the compression is material — the whole reason this module
        // exists: cos²28°/cos²(−5°) ≈ 0.786, i.e. a 13 px template's
        // content spans ~10 px in B at this strip position (and shrinks
        // further toward the frame edge).
        assert!(dbx_dax < 0.79, "expected ≥ 21% compression, got {dbx_dax}");
    }

    #[test]
    fn behind_camera_and_degenerate_warps_yield_none() {
        let c = cam(4000, 3000, 71.0);
        // 150° relative yaw: the strip pixel lands behind camera B.
        let rot = Mat3::rotation_y(150.0_f64.to_radians());
        let g = RefineGeometry {
            cam_a: &c,
            cam_b: &c,
            rotation: &rot,
        };
        assert_eq!(local_warp_inverse(&g, (2000.0, 1500.0)), None);
    }
}
