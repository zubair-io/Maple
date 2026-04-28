//! Joint rotation+focal bundle adjustment across N images.
//!
//! Brown & Lowe 2007 panorama BA: per-camera 4-parameter
//! axis-angle (ω_x, ω_y, ω_z) + focal f. Camera 0 is fixed
//! (rotation = identity, focal = initial prior) for gauge.
//! Optimization: hand-rolled Levenberg-Marquardt with adaptive
//! damping over Rodrigues-parameterised rotations.
//!
//! Reference: AliceVision `aliceVision::sfm::ReconstructionEngine_panorama`
//! at https://github.com/alicevision/AliceVision/blob/v3.3.0/src/aliceVision/sfm/pipeline/panorama/

use nalgebra::{DMatrix, DVector, Matrix3, Vector3};

use crate::error::PanoError;
use crate::types::{Camera, Distortion, Features, Matches};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Joint rotation+focal BA solver.
#[derive(Debug, Clone)]
pub struct JointRotationFocalBA {
    /// Maximum LM iterations. Default 100.
    pub max_iters: usize,
    /// Convergence threshold on parameter step norm. Default 1e-6.
    pub step_tolerance: f64,
}

impl Default for JointRotationFocalBA {
    fn default() -> Self {
        Self {
            max_iters: 100,
            step_tolerance: 1e-6,
        }
    }
}

impl JointRotationFocalBA {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Initial rotation+focal prior per camera (None = identity init).
#[derive(Debug, Clone, Copy)]
pub struct CameraPrior {
    pub rotation: Matrix3<f64>,
    pub focal: f32,
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Run joint BA over N images sharing a rotation graph defined by
/// pairwise matches.
///
/// `features[i]` are the keypoints/descriptors for image i.
/// `pairs` are the inlier correspondences between images
/// i and j (after RANSAC).
/// `image_size` is the (w, h) of all images (assumes single-camera pano).
///
/// Returns N cameras with refined rotations and focals.
pub fn solve_joint(
    features: &[Features],
    pairs: &[(usize, usize, Matches)],
    image_size: (u32, u32),
) -> Result<Vec<Camera>, PanoError> {
    solve_joint_with_priors(features, pairs, image_size, None, &Default::default())
}

/// Like `solve_joint` but accepts per-camera rotation+focal priors.
///
/// `priors[i] = Some(CameraPrior)` initializes camera i's rotation +
/// focal from external metadata (e.g. DJI gimbal angles); None falls
/// back to identity rotation + focal = max(w, h).
///
/// Returns N cameras with refined rotations and focals.
pub fn solve_joint_with_priors(
    features: &[Features],
    pairs: &[(usize, usize, Matches)],
    image_size: (u32, u32),
    priors: Option<&[Option<CameraPrior>]>,
    config: &JointRotationFocalBA,
) -> Result<Vec<Camera>, PanoError> {
    let n_cams = features.len();
    if n_cams == 0 {
        return Ok(Vec::new());
    }
    if n_cams == 1 {
        let focal0 = priors
            .and_then(|p| p.first())
            .and_then(|p| p.as_ref())
            .map(|p| p.focal as f64)
            .unwrap_or_else(|| image_size.0.max(image_size.1) as f64);
        return Ok(vec![Camera {
            focal: focal0 as f32,
            rotation: Matrix3::identity(),
            distortion: Distortion::default(),
        }]);
    }

    let (img_w, img_h) = image_size;
    let cx = img_w as f64 / 2.0;
    let cy = img_h as f64 / 2.0;
    let default_focal = img_w.max(img_h) as f64;

    // -----------------------------------------------------------------------
    // Step 1: Build initial parameter vector.
    //
    // Layout: [ω_1x, ω_1y, ω_1z, f_1,  ω_2x, ω_2y, ω_2z, f_2,  ...]
    //         (camera 0 is fixed — not in the parameter vector)
    // -----------------------------------------------------------------------
    let n_free = n_cams - 1; // cameras 1..n_cams-1
    let mut params = vec![0.0f64; n_free * 4];

    for i in 1..n_cams {
        let slot = (i - 1) * 4;
        let (omega, focal) = if let Some(p) = priors.and_then(|pv| pv.get(i)).and_then(|p| p.as_ref())
        {
            (rodrigues_log(&p.rotation), p.focal as f64)
        } else {
            (Vector3::zeros(), default_focal)
        };
        params[slot] = omega.x;
        params[slot + 1] = omega.y;
        params[slot + 2] = omega.z;
        params[slot + 3] = focal;
    }

    // Focal for camera 0 (fixed, not optimised).
    let focal0 = priors
        .and_then(|p| p.first())
        .and_then(|p| p.as_ref())
        .map(|p| p.focal as f64)
        .unwrap_or(default_focal);

    // -----------------------------------------------------------------------
    // Build the list of (cam_i, cam_j, kp_a[], kp_b[]) from pairs.
    // -----------------------------------------------------------------------
    let pair_data: Vec<(usize, usize, Vec<[f64; 2]>, Vec<[f64; 2]>)> = pairs
        .iter()
        .filter_map(|(ci, cj, matches)| {
            if matches.inliers.is_empty() {
                return None;
            }
            let kps_i = &features[*ci].keypoints;
            let kps_j = &features[*cj].keypoints;
            let pts_a: Vec<[f64; 2]> = matches
                .inliers
                .iter()
                .filter_map(|m| {
                    let kp = kps_i.get(m.a as usize)?;
                    Some([kp.x as f64, kp.y as f64])
                })
                .collect();
            let pts_b: Vec<[f64; 2]> = matches
                .inliers
                .iter()
                .filter_map(|m| {
                    let kp = kps_j.get(m.b as usize)?;
                    Some([kp.x as f64, kp.y as f64])
                })
                .collect();
            if pts_a.len() < 4 || pts_b.len() != pts_a.len() {
                return None;
            }
            Some((*ci, *cj, pts_a, pts_b))
        })
        .collect();

    if pair_data.is_empty() {
        // No usable correspondences — return identity+default cameras.
        return Ok((0..n_cams)
            .map(|i| Camera {
                focal: if i == 0 {
                    focal0 as f32
                } else {
                    default_focal as f32
                },
                rotation: Matrix3::identity(),
                distortion: Distortion::default(),
            })
            .collect());
    }

    // -----------------------------------------------------------------------
    // Step 2-4: LM optimisation.
    // -----------------------------------------------------------------------
    let problem = JointBAProblem {
        pair_data,
        n_cams,
        focal0,
        cx,
        cy,
    };

    let refined = problem.solve_lm(params, config);

    // -----------------------------------------------------------------------
    // Step 5: Reconstruct cameras.
    // -----------------------------------------------------------------------
    let mut cameras: Vec<Camera> = Vec::with_capacity(n_cams);

    // Camera 0: fixed.
    cameras.push(Camera {
        focal: focal0 as f32,
        rotation: Matrix3::identity(),
        distortion: Distortion::default(),
    });

    for i in 1..n_cams {
        let slot = (i - 1) * 4;
        let omega = Vector3::new(refined[slot], refined[slot + 1], refined[slot + 2]);
        let focal_i = refined[slot + 3];
        let r = rodrigues_exp(omega);
        cameras.push(Camera {
            focal: focal_i as f32,
            rotation: r.cast::<f32>(),
            distortion: Distortion::default(),
        });
    }

    Ok(cameras)
}

// ---------------------------------------------------------------------------
// Internal solver
// ---------------------------------------------------------------------------

struct JointBAProblem {
    /// (cam_i, cam_j, pts_in_i, pts_in_j)
    pair_data: Vec<(usize, usize, Vec<[f64; 2]>, Vec<[f64; 2]>)>,
    n_cams: usize,
    focal0: f64,
    cx: f64,
    cy: f64,
}

impl JointBAProblem {
    /// Extract (rotation, focal) for camera `idx` from the parameter vector.
    ///
    /// Camera 0 is fixed: rotation = I, focal = self.focal0.
    fn cam_params(&self, idx: usize, params: &[f64]) -> (Matrix3<f64>, f64) {
        if idx == 0 {
            return (Matrix3::identity(), self.focal0);
        }
        let slot = (idx - 1) * 4;
        let omega = Vector3::new(params[slot], params[slot + 1], params[slot + 2]);
        let focal = params[slot + 3];
        (rodrigues_exp(omega), focal)
    }

    /// Compute the full residual vector.
    ///
    /// Per correspondence (ci, cj, pa, pb):
    ///   ray_i  = R_i^T · K_i^-1 · [pa.x, pa.y, 1]   (back-project into world)
    ///   ray_j' = R_j   · ray_i                        (world → cam j frame)
    ///   pb_hat = K_j · ray_j' / ray_j'.z              (project)
    ///   residual = pb_hat - pb                         (2-vector)
    fn residuals(&self, params: &[f64]) -> Vec<f64> {
        let cx = self.cx;
        let cy = self.cy;

        let mut res = Vec::new();
        for (ci, cj, pts_a, pts_b) in &self.pair_data {
            let (r_i, focal_i) = self.cam_params(*ci, params);
            let (r_j, focal_j) = self.cam_params(*cj, params);

            for (pa, pb) in pts_a.iter().zip(pts_b.iter()) {
                // K_i^-1 · pa
                let xn_i = (pa[0] - cx) / focal_i;
                let yn_i = (pa[1] - cy) / focal_i;
                let ray_cam_i = Vector3::new(xn_i, yn_i, 1.0);

                // R_i^T · ray_cam_i  (world frame)
                let ray_world = r_i.transpose() * ray_cam_i;

                // R_j · ray_world  (into cam j)
                let ray_cam_j = r_j * ray_world;

                if ray_cam_j.z.abs() < 1e-12 {
                    // Degenerate — push a large residual so it gets penalised.
                    res.push(1e6);
                    res.push(1e6);
                    continue;
                }

                // Project: K_j · (ray_cam_j / ray_cam_j.z)
                let u_hat = focal_j * ray_cam_j.x / ray_cam_j.z + cx;
                let v_hat = focal_j * ray_cam_j.y / ray_cam_j.z + cy;

                res.push(u_hat - pb[0]);
                res.push(v_hat - pb[1]);
            }
        }
        res
    }

    /// Numerical Jacobian via central finite differences.
    ///
    /// eps_omega = 1e-6 (rotation perturbation in axis-angle).
    /// eps_focal = 1e-4 (focal-length perturbation).
    fn jacobian(&self, params: &[f64]) -> DMatrix<f64> {
        let n_params = params.len();
        let res0 = self.residuals(params);
        let n_res = res0.len();

        let mut jac = DMatrix::zeros(n_res, n_params);
        let mut p = params.to_vec();

        for j in 0..n_params {
            // Choose epsilon based on whether this slot is rotation (mod 4 < 3)
            // or focal (mod 4 == 3).
            let eps = if j % 4 == 3 { 1e-4 } else { 1e-6 };

            let orig = p[j];
            p[j] = orig + eps;
            let rp = self.residuals(&p);
            p[j] = orig - eps;
            let rm = self.residuals(&p);
            p[j] = orig;

            for i in 0..n_res {
                jac[(i, j)] = (rp[i] - rm[i]) / (2.0 * eps);
            }
        }
        jac
    }

    /// LM with adaptive damping. Returns refined parameter vector.
    fn solve_lm(&self, mut params: Vec<f64>, config: &JointRotationFocalBA) -> Vec<f64> {
        let mut mu: f64 = 1e-3;
        let mu_inc = 10.0;
        let mu_dec = 10.0;
        let mut current_cost = sum_sq(&self.residuals(&params));

        for _iter in 0..config.max_iters {
            let r_vec = self.residuals(&params);
            let j = self.jacobian(&params);
            let jt = j.transpose();
            let jtj = &jt * &j;
            let neg_r = DVector::from_vec(r_vec.iter().map(|&v| -v).collect::<Vec<_>>());
            let jtr = &jt * &neg_r;

            let n = params.len();
            let mut accepted = false;

            for _retry in 0..6 {
                let lhs = &jtj + DMatrix::identity(n, n) * mu;
                let Some(delta) = lhs.lu().solve(&jtr) else {
                    mu *= mu_inc;
                    continue;
                };

                let trial: Vec<f64> = params
                    .iter()
                    .zip(delta.iter())
                    .map(|(p, &d)| p + d)
                    .collect();
                let trial_cost = sum_sq(&self.residuals(&trial));

                if trial_cost < current_cost {
                    let step_norm: f64 = delta.iter().map(|v| v * v).sum::<f64>().sqrt();
                    params = trial;
                    current_cost = trial_cost;
                    mu = (mu / mu_dec).max(1e-12);
                    accepted = true;
                    if step_norm < config.step_tolerance {
                        return params;
                    }
                    break;
                } else {
                    mu *= mu_inc;
                }
            }

            if !accepted {
                break;
            }
        }
        params
    }
}

#[inline]
fn sum_sq(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum()
}

// ---------------------------------------------------------------------------
// Rodrigues helpers (public — used by tests)
// ---------------------------------------------------------------------------

/// Rodrigues exponential map: axis-angle ω (3-vec) → rotation matrix R.
///
/// |ω| = rotation angle in radians; ω/|ω| = rotation axis.
pub fn rodrigues_exp(omega: Vector3<f64>) -> Matrix3<f64> {
    let theta = omega.norm();
    if theta < 1e-9 {
        // First-order approximation for tiny rotations.
        return Matrix3::identity() + skew(omega);
    }
    let k = omega / theta;
    let k_skew = skew(k);
    let i = Matrix3::<f64>::identity();
    i + theta.sin() * k_skew + (1.0 - theta.cos()) * (k_skew * k_skew)
}

/// Inverse Rodrigues: rotation matrix → axis-angle.
pub fn rodrigues_log(r: &Matrix3<f64>) -> Vector3<f64> {
    let trace = r.trace();
    let cos_theta = ((trace - 1.0) / 2.0).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();
    if theta < 1e-9 {
        return Vector3::zeros();
    }
    let factor = theta / (2.0 * theta.sin());
    Vector3::new(
        factor * (r[(2, 1)] - r[(1, 2)]),
        factor * (r[(0, 2)] - r[(2, 0)]),
        factor * (r[(1, 0)] - r[(0, 1)]),
    )
}

fn skew(v: Vector3<f64>) -> Matrix3<f64> {
    Matrix3::new(0.0, -v.z, v.y, v.z, 0.0, -v.x, -v.y, v.x, 0.0)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rodrigues_zero_is_identity() {
        let r = rodrigues_exp(Vector3::zeros());
        assert!((r - Matrix3::identity()).abs().max() < 1e-9);
    }

    #[test]
    fn rodrigues_roundtrip() {
        for axis in [
            Vector3::new(0.3, 0.0, 0.0),
            Vector3::new(0.0, 0.7, 0.0),
            Vector3::new(0.0, 0.0, 1.2),
            Vector3::new(0.4, 0.5, 0.6),
        ] {
            let r = rodrigues_exp(axis);
            let back = rodrigues_log(&r);
            assert!(
                (back - axis).norm() < 1e-6,
                "axis={axis:?} back={back:?}"
            );
        }
    }

    #[test]
    fn rodrigues_yaw_90() {
        let omega = Vector3::new(0.0, std::f64::consts::FRAC_PI_2, 0.0);
        let r = rodrigues_exp(omega);
        // R * (1, 0, 0) should give (0, 0, -1) for yaw about Y axis.
        let v = r * Vector3::new(1.0, 0.0, 0.0);
        assert!(v.x.abs() < 1e-9, "v.x = {}", v.x);
        assert!(v.y.abs() < 1e-9, "v.y = {}", v.y);
        assert!((v.z + 1.0).abs() < 1e-9, "v.z = {} (expect -1)", v.z);
    }
}
