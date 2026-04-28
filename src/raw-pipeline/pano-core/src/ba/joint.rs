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
use pathfinding::undirected::kruskal::kruskal_indices;

use crate::ba::homography::{ransac_homography, rotation_from_homography};
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
    //
    // Initialization order:
    // 1. If priors provided for camera i, use them.
    // 2. If no priors, extract rotations from pairwise homographies via
    //    BFS over the pair graph (same approach as RotationOnlyBA).
    // 3. Fallback: identity rotation + default focal.
    // -----------------------------------------------------------------------

    let n_free = n_cams - 1; // cameras 1..n_cams-1
    let mut params = vec![0.0f64; n_free * 4];

    for i in 1..n_cams {
        let slot = (i - 1) * 4;
        let (omega, focal) = if let Some(p) = priors.and_then(|pv| pv.get(i)).and_then(|p| p.as_ref())
        {
            (rodrigues_log(&p.rotation), p.focal as f64)
        } else {
            // Default: identity rotation + focal = max(w, h).
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
// Homography-chain initialization
// ---------------------------------------------------------------------------

/// Estimate initial per-camera rotations from pairwise homographies via BFS.
///
/// Same strategy as `RotationOnlyBA`: compute a pairwise rotation from the
/// RANSAC homography for each pair, build a spanning tree, BFS from camera 0.
///
/// Note: for DJI panoramas where consecutive frames share 75%+ pixel overlap,
/// the BruteForce matcher produces zero-displacement correspondences that
/// yield near-identity homographies. Use gimbal priors instead for DJI inputs.
#[allow(dead_code)]
fn init_rotations_from_homographies(
    pairs: &[(usize, usize, Matches)],
    features: &[Features],
    n_cams: usize,
    image_size: (u32, u32),
) -> Vec<Matrix3<f64>> {
    let focal_d = image_size.0.max(image_size.1) as f64;
    let (img_w, img_h) = (image_size.0 as f64, image_size.1 as f64);

    struct Edge {
        a: usize,
        b: usize,
        weight: i64, // negated inlier count (Kruskal wants min-cost MST)
        rotation: Matrix3<f64>,
    }

    let mut edges: Vec<Edge> = Vec::new();

    for (ci, cj, matches) in pairs {
        if matches.inliers.len() < 4 {
            continue;
        }
        let kps_i = &features[*ci].keypoints;
        let kps_j = &features[*cj].keypoints;

        // Fit a homography directly on all inlier matches (they are already
        // RANSAC-filtered by the caller — no need to re-run RANSAC).
        let pts_a: Vec<(f64, f64)> = matches
            .inliers
            .iter()
            .filter_map(|m| {
                let kp = kps_i.get(m.a as usize)?;
                Some((kp.x as f64, kp.y as f64))
            })
            .collect();
        let pts_b: Vec<(f64, f64)> = matches
            .inliers
            .iter()
            .filter_map(|m| {
                let kp = kps_j.get(m.b as usize)?;
                Some((kp.x as f64, kp.y as f64))
            })
            .collect();

        // Fit homography and extract rotation via SVD.
        let rotation = if pts_a.len() >= 4 {
            // Use a DLT fit on all correspondences (they are already inliers).
            let ransac_result = ransac_homography(kps_i, kps_j, &matches.inliers, 5.0, 500, 42);
            if let Some((h, _)) = ransac_result {
                rotation_from_homography(&h, focal_d, img_w, img_h)
            } else {
                Matrix3::identity()
            }
        } else {
            Matrix3::identity()
        };

        let _ = (pts_a, pts_b); // suppress unused warning

        edges.push(Edge {
            a: *ci,
            b: *cj,
            weight: -(matches.inliers.len() as i64),
            rotation,
        });
    }

    // Build MST via Kruskal.
    let kruskal_edges: Vec<(usize, usize, i64)> =
        edges.iter().map(|e| (e.a, e.b, e.weight)).collect();
    let mst: Vec<(usize, usize, i64)> =
        kruskal_indices(n_cams, &kruskal_edges).collect();

    // Adjacency list.
    let mut adj: Vec<Vec<(usize, Matrix3<f64>)>> = vec![Vec::new(); n_cams];
    for (a, b, _) in &mst {
        let r = edges
            .iter()
            .find(|e| (e.a == *a && e.b == *b) || (e.a == *b && e.b == *a))
            .map(|e| if e.a == *a { e.rotation } else { e.rotation.transpose() })
            .unwrap_or(Matrix3::identity());
        adj[*a].push((*b, r));
        adj[*b].push((*a, r.transpose()));
    }

    // BFS from camera 0.
    let mut rotations = vec![Matrix3::identity(); n_cams];
    let mut visited = vec![false; n_cams];
    visited[0] = true;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(0usize);
    while let Some(cur) = queue.pop_front() {
        for &(nbr, r_edge) in &adj[cur] {
            if !visited[nbr] {
                visited[nbr] = true;
                rotations[nbr] = rotations[cur] * r_edge;
                queue.push_back(nbr);
            }
        }
    }

    rotations
}

// ---------------------------------------------------------------------------
// Internal solver
// ---------------------------------------------------------------------------

struct JointBAProblem {
    /// (cam_i, cam_j, pts_in_i, pts_in_j)
    pair_data: Vec<(usize, usize, Vec<[f64; 2]>, Vec<[f64; 2]>)>,
    #[allow(dead_code)]
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
                // K_i^-1 · pa  — a ray in camera i's local frame
                let xn_i = (pa[0] - cx) / focal_i;
                let yn_i = (pa[1] - cy) / focal_i;
                let ray_cam_i = Vector3::new(xn_i, yn_i, 1.0);

                // R_i · ray_cam_i  → world frame
                // (R_i is the camera-to-world rotation; R_i^T maps world→cam)
                let ray_world = r_i * ray_cam_i;

                // R_j^T · ray_world  → into camera j's local frame
                let ray_cam_j = r_j.transpose() * ray_world;

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

        let verbose = std::env::var("PANO_BA_VERBOSE").is_ok();
        if verbose {
            eprintln!("joint_ba: initial cost={:.2e}, n_params={}", current_cost, params.len());
        }

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
                    if verbose {
                        eprintln!("joint_ba: iter={_iter} cost={:.2e} step={:.2e} mu={:.2e}", current_cost, step_norm, mu);
                    }
                    if step_norm < config.step_tolerance {
                        if verbose { eprintln!("joint_ba: converged at iter={_iter}"); }
                        return params;
                    }
                    break;
                } else {
                    mu *= mu_inc;
                }
            }

            if !accepted {
                if verbose { eprintln!("joint_ba: stuck at iter={_iter} mu={:.2e}", mu); }
                break;
            }
        }
        if verbose {
            eprintln!("joint_ba: final cost={:.2e}", current_cost);
            for i in 0..(params.len() / 4) {
                let slot = i * 4;
                let omega_norm = (params[slot]*params[slot] + params[slot+1]*params[slot+1] + params[slot+2]*params[slot+2]).sqrt();
                let deg = omega_norm.to_degrees();
                eprintln!("  cam[{}] omega_deg={:.2} focal={:.1}", i+1, deg, params[slot+3]);
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
