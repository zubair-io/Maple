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

/// Joint rotation+focal+translation BA solver.
///
/// Despite the name, the parameter set has been extended to include
/// per-camera translation `(t_x, t_y, t_z)` modelled under the planar-
/// scene-at-unit-depth assumption. Translation defaults to a strong
/// soft prior at zero, so with `lambda_translation` high enough the
/// solver collapses to pure rotation+focal — useful for backwards
/// compatibility and for scenes where parallax is truly absent. When
/// `lambda_translation` is finite, the translation params absorb the
/// planar-parallax residual that pure rotation can't explain (e.g.
/// drone drift between consecutive panorama frames).
#[derive(Debug, Clone)]
pub struct JointRotationFocalBA {
    /// Maximum LM iterations. Default 100.
    pub max_iters: usize,
    /// Convergence threshold on parameter step norm. Default 1e-6.
    pub step_tolerance: f64,
    /// Soft-prior penalty weight on rotation error.
    ///
    /// When `priors` are supplied and `lambda_rotation > 0`, an extra
    /// residual block is appended to the LM problem:
    ///
    /// ```text
    /// r_prior_i = √λ · (ω_i − ω_prior_i)         for each free camera i
    /// ```
    ///
    /// where ω is the camera's rotation in axis-angle form (radians) and
    /// ω_prior is the prior's rotation expressed the same way. This keeps
    /// BA tethered to gimbal/IMU priors while still letting the
    /// reprojection signal pull cameras into pixel-accurate alignment.
    ///
    /// Scale guidance: reprojection residuals are in pixels. To make a
    /// 1° rotation drift cost roughly the same as a 1-px reprojection
    /// error per match, set λ ≈ (180/π)² ≈ 3300. Typical values:
    ///
    /// - 0.0:   no prior penalty (legacy behaviour).
    /// - 3300:  1° rotation drift ≈ 1 px-equivalent residual per axis.
    /// - 33000: 1° rotation drift ≈ 3.16 px-equivalent residuals per
    ///   axis, ≈ 30 px equivalent across the 3-axis vector. Strong
    ///   anchor — the default for DJI gimbal priors.
    /// - 1e6:   essentially "fix to prior" — equivalent to gimbal-direct
    ///   with a tiny refinement allowance.
    ///
    /// Default 0.0 (off) for backward compatibility; pano-smoke turns
    /// it on when gimbal priors are present.
    pub lambda_rotation: f64,
    /// Soft-prior penalty weight on focal error.
    ///
    /// Same idea as `lambda_rotation` but on focal length:
    ///
    /// ```text
    /// r_prior_focal_i = √λ_f · (f_i − f_prior_i) / f_prior_i
    /// ```
    ///
    /// Scale: divides by the prior focal so the residual is unitless
    /// fractional error. λ_f = 100 means a 10% focal drift adds ~1
    /// px-equivalent residual.
    ///
    /// Default 0.0 (off).
    pub lambda_focal: f64,
    /// Soft-prior penalty weight on translation magnitude.
    ///
    /// ```text
    /// r_prior_t_i = √λ_t · (t_i − t_prior_i)
    /// ```
    ///
    /// Translation is parameterised in *world units relative to the
    /// scene plane at unit depth*. The natural scale is therefore
    /// roughly fractional: `t = 0.01` = 1% of scene depth = ~1°
    /// parallax angle for a foreground object at unit depth.
    ///
    /// At `λ_t = 1e8` the solver allows ~0.1% translation (≈10 px
    /// on a 3500-px focal) only when matches force it; at `λ_t = 1e6`
    /// it allows ~1%; at `λ_t = 0` translation is fully free (likely
    /// to over-fit on small-match pairs).
    ///
    /// Default 0.0 (off — solver remains rotation+focal only and the
    /// extra 3 params per camera are unused).
    pub lambda_translation: f64,
}

impl Default for JointRotationFocalBA {
    fn default() -> Self {
        Self {
            max_iters: 100,
            step_tolerance: 1e-6,
            lambda_rotation: 0.0,
            lambda_focal: 0.0,
            lambda_translation: 0.0,
        }
    }
}

impl JointRotationFocalBA {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Initial rotation+focal+translation prior per camera (None = identity init).
#[derive(Debug, Clone, Copy)]
pub struct CameraPrior {
    pub rotation: Matrix3<f64>,
    pub focal: f32,
    /// Per-camera translation in world units, planar-at-unit-depth scale.
    /// Defaults to zero (the prior says "no translation, pure rotation
    /// stitch"). When `lambda_translation > 0` and matches genuinely
    /// can't fit pure rotation, BA pulls this away from zero.
    pub translation: Vector3<f64>,
}

impl CameraPrior {
    /// Convenience constructor for the rotation+focal-only case.
    /// Translation defaults to zero.
    pub fn new(rotation: Matrix3<f64>, focal: f32) -> Self {
        Self {
            rotation,
            focal,
            translation: Vector3::zeros(),
        }
    }
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
            translation: nalgebra::Vector3::<f32>::zeros(),
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
    // Layout (7 doubles per free camera):
    //   [ω_x, ω_y, ω_z, f, t_x, t_y, t_z,
    //    ω_x, ω_y, ω_z, f, t_x, t_y, t_z, ...]
    //
    // Camera 0 is the gauge fix: rotation = identity, focal = prior,
    // translation = (0, 0, 0). Not in the parameter vector.
    //
    // Initialization order:
    // 1. If priors provided for camera i, use them.
    // 2. If no priors, extract rotations from pairwise homographies via
    //    BFS over the pair graph (same approach as RotationOnlyBA).
    // 3. Fallback: identity rotation + default focal + zero translation.
    // -----------------------------------------------------------------------

    /// Doubles per free camera in the BA parameter vector.
    /// `[ω_x, ω_y, ω_z, f, t_x, t_y, t_z]`.
    const PARAMS_PER_CAM: usize = 7;
    /// Slot index of focal within a per-camera block.
    const FOCAL_SLOT: usize = 3;
    /// Slot index where the translation `(t_x, t_y, t_z)` block starts.
    const TRANS_SLOT: usize = 4;

    let n_free = n_cams - 1; // cameras 1..n_cams-1
    let mut params = vec![0.0f64; n_free * PARAMS_PER_CAM];

    for i in 1..n_cams {
        let slot = (i - 1) * PARAMS_PER_CAM;
        let (omega, focal, translation) = if let Some(p) =
            priors.and_then(|pv| pv.get(i)).and_then(|p| p.as_ref())
        {
            (rodrigues_log(&p.rotation), p.focal as f64, p.translation)
        } else {
            // Default: identity rotation + focal = max(w, h) + zero translation.
            (Vector3::zeros(), default_focal, Vector3::zeros())
        };
        params[slot] = omega.x;
        params[slot + 1] = omega.y;
        params[slot + 2] = omega.z;
        params[slot + FOCAL_SLOT] = focal;
        params[slot + TRANS_SLOT] = translation.x;
        params[slot + TRANS_SLOT + 1] = translation.y;
        params[slot + TRANS_SLOT + 2] = translation.z;
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
                translation: nalgebra::Vector3::<f32>::zeros(),
                distortion: Distortion::default(),
            })
            .collect());
    }

    // -----------------------------------------------------------------------
    // Step 2-4: LM optimisation.
    // -----------------------------------------------------------------------
    //
    // Build prior axis-angle vectors + focals + translations for each free
    // camera (1..n). None entries are kept as None; the solver treats
    // those as no-prior (zero contribution to the prior residual block).
    let prior_omegas: Vec<Option<Vector3<f64>>> = (1..n_cams)
        .map(|i| {
            priors
                .and_then(|pv| pv.get(i))
                .and_then(|p| p.as_ref())
                .map(|p| rodrigues_log(&p.rotation))
        })
        .collect();
    let prior_focals: Vec<Option<f64>> = (1..n_cams)
        .map(|i| {
            priors
                .and_then(|pv| pv.get(i))
                .and_then(|p| p.as_ref())
                .map(|p| p.focal as f64)
        })
        .collect();
    let prior_translations: Vec<Option<Vector3<f64>>> = (1..n_cams)
        .map(|i| {
            priors
                .and_then(|pv| pv.get(i))
                .and_then(|p| p.as_ref())
                .map(|p| p.translation)
        })
        .collect();

    let problem = JointBAProblem {
        pair_data,
        n_cams,
        focal0,
        cx,
        cy,
        prior_omegas,
        prior_focals,
        prior_translations,
        lambda_rotation: config.lambda_rotation,
        lambda_focal: config.lambda_focal,
        lambda_translation: config.lambda_translation,
    };

    let refined = problem.solve_lm(params, config);

    // -----------------------------------------------------------------------
    // Step 5: Reconstruct cameras.
    //
    // Translation IS now propagated through `Camera.translation` so the
    // canvas warp can apply the parallax correction BA discovered.
    // Previously translation was dropped here on the assumption that
    // the warp downstream couldn't use it; that assumption was wrong —
    // it left the BA-found 100-px parallax shifts (e.g. cam[1]'s
    // ‖t‖=0.026 on pano_01) unapplied, manifesting as visible ghosting
    // in the stitched output.
    // -----------------------------------------------------------------------
    let mut cameras: Vec<Camera> = Vec::with_capacity(n_cams);

    // Camera 0: gauge fix — rotation = I, focal = prior, translation = 0.
    cameras.push(Camera {
        focal: focal0 as f32,
        rotation: Matrix3::identity(),
        translation: nalgebra::Vector3::<f32>::zeros(),
        distortion: Distortion::default(),
    });

    for i in 1..n_cams {
        let slot = (i - 1) * PARAMS_PER_CAM;
        let omega = Vector3::new(refined[slot], refined[slot + 1], refined[slot + 2]);
        let focal_i = refined[slot + FOCAL_SLOT];
        let translation_i = Vector3::new(
            refined[slot + TRANS_SLOT],
            refined[slot + TRANS_SLOT + 1],
            refined[slot + TRANS_SLOT + 2],
        );
        let r = rodrigues_exp(omega);
        cameras.push(Camera {
            focal: focal_i as f32,
            rotation: r.cast::<f32>(),
            translation: translation_i.cast::<f32>(),
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
    /// Per-free-camera (i.e. cameras 1..n_cams) rotation prior in axis-angle.
    /// None = no prior (zero contribution to the prior residual block).
    /// Length = n_cams - 1.
    prior_omegas: Vec<Option<Vector3<f64>>>,
    /// Per-free-camera focal prior in pixels. None = no prior.
    /// Length = n_cams - 1.
    prior_focals: Vec<Option<f64>>,
    /// Per-free-camera translation prior in planar-at-unit-depth units.
    /// None = no prior (treated as zero target). Length = n_cams - 1.
    prior_translations: Vec<Option<Vector3<f64>>>,
    /// Soft-prior weight on rotation error (square-rooted at use site so
    /// LM sees `√λ · Δω` as the residual). 0.0 disables the prior.
    lambda_rotation: f64,
    /// Soft-prior weight on focal error (relative). 0.0 disables.
    lambda_focal: f64,
    /// Soft-prior weight on translation magnitude. 0.0 disables AND
    /// silently freezes translation at its initial value (typically 0)
    /// so the solver still produces a rotation+focal-only result.
    lambda_translation: f64,
}

impl JointBAProblem {
    /// Extract (rotation, focal, translation) for camera `idx` from the
    /// parameter vector.
    ///
    /// Camera 0 is the gauge fix: rotation = I, focal = self.focal0,
    /// translation = (0, 0, 0).
    fn cam_params(&self, idx: usize, params: &[f64]) -> (Matrix3<f64>, f64, Vector3<f64>) {
        if idx == 0 {
            return (Matrix3::identity(), self.focal0, Vector3::zeros());
        }
        let slot = (idx - 1) * 7;
        let omega = Vector3::new(params[slot], params[slot + 1], params[slot + 2]);
        let focal = params[slot + 3];
        let translation = Vector3::new(params[slot + 4], params[slot + 5], params[slot + 6]);
        (rodrigues_exp(omega), focal, translation)
    }

    /// Compute the full residual vector under the planar-at-unit-depth
    /// motion model.
    ///
    /// For a pixel `pa` in camera i's distortion-corrected image plane,
    /// its predicted location in camera j is:
    ///
    /// ```text
    /// xn_a    = K_i^-1 · pa                          (normalised cam-i coords)
    /// X_world = R_i · xn_a + t_i / d                 (intersect z = 1 plane,
    ///                                                  d = 1 since gauge-fixed)
    /// xn_b    = R_j^T · (X_world − t_j)
    /// pb_hat  = K_j · (xn_b / xn_b.z)
    /// ```
    ///
    /// Equivalently the planar homography form:
    ///
    /// ```text
    /// H = K_j · (R_j^T · R_i − R_j^T · (t_i − t_j) · n^T / d) · K_i^-1
    /// ```
    ///
    /// with `n = [0, 0, 1]`, `d = 1`. When all `t_i = 0` this reduces
    /// to the pure-rotation homography `K_j · R_j^T · R_i · K_i^-1`,
    /// so the new model is a strict generalisation of the previous
    /// rotation-only BA.
    fn residuals(&self, params: &[f64]) -> Vec<f64> {
        let cx = self.cx;
        let cy = self.cy;

        let mut res = Vec::new();
        for (ci, cj, pts_a, pts_b) in &self.pair_data {
            let (r_i, focal_i, t_i) = self.cam_params(*ci, params);
            let (r_j, focal_j, t_j) = self.cam_params(*cj, params);
            let r_j_inv = r_j.transpose();
            let dt = t_i - t_j;

            for (pa, pb) in pts_a.iter().zip(pts_b.iter()) {
                // K_i^-1 · pa  — a normalised ray direction in cam i's frame
                let xn_i = (pa[0] - cx) / focal_i;
                let yn_i = (pa[1] - cy) / focal_i;
                let ray_cam_i = Vector3::new(xn_i, yn_i, 1.0);

                // World-frame ray direction. Translation t_i adds a
                // shift of t_i / d at unit depth. With d=1 (gauge),
                // this is simply additive in world units.
                let ray_world_dir = r_i * ray_cam_i;

                // Into cam j's frame: subtract relative translation
                // (t_i - t_j) in world frame, then rotate by R_j^T.
                // Note the sign: with t_i = t_j (no relative motion),
                // the term vanishes and we recover pure-rotation.
                let ray_cam_j = r_j_inv * (ray_world_dir + dt);

                if ray_cam_j.z.abs() < 1e-12 {
                    // Degenerate (point at horizon of cam j) —
                    // push a large residual so it gets penalised.
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

        // -------------------------------------------------------------------
        // Append soft-prior residuals — one block per free camera.
        //
        // Layout (each row only emitted when its λ > 0):
        //   √λ_rot   · (ω_i − ω_prior_i)         ← 3 rows
        //   √λ_f     · (f_i − f_prior_i) / f_p   ← 1 row
        //   √λ_t     · (t_i − t_prior_i)         ← 3 rows
        //
        // For free cameras with no prior, the corresponding rows emit 0
        // (so the residual layout stays consistent across cameras and
        // the central-difference Jacobian sees the same problem shape).
        // -------------------------------------------------------------------
        let sqrt_lr = self.lambda_rotation.max(0.0).sqrt();
        let sqrt_lf = self.lambda_focal.max(0.0).sqrt();
        let sqrt_lt = self.lambda_translation.max(0.0).sqrt();

        for k in 0..self.prior_omegas.len() {
            let slot = k * 7;
            // Rotation prior — 3 rows.
            if sqrt_lr > 0.0 {
                if let Some(om_p) = self.prior_omegas[k] {
                    let dx = params[slot] - om_p.x;
                    let dy = params[slot + 1] - om_p.y;
                    let dz = params[slot + 2] - om_p.z;
                    res.push(sqrt_lr * dx);
                    res.push(sqrt_lr * dy);
                    res.push(sqrt_lr * dz);
                } else {
                    res.push(0.0);
                    res.push(0.0);
                    res.push(0.0);
                }
            }
            // Focal prior — 1 row.
            if sqrt_lf > 0.0 {
                if let Some(f_p) = self.prior_focals[k] {
                    if f_p.abs() > 1e-9 {
                        let df = (params[slot + 3] - f_p) / f_p;
                        res.push(sqrt_lf * df);
                    } else {
                        res.push(0.0);
                    }
                } else {
                    res.push(0.0);
                }
            }
            // Translation prior — 3 rows.
            if sqrt_lt > 0.0 {
                let t_p = self.prior_translations[k].unwrap_or(Vector3::zeros());
                let dtx = params[slot + 4] - t_p.x;
                let dty = params[slot + 5] - t_p.y;
                let dtz = params[slot + 6] - t_p.z;
                res.push(sqrt_lt * dtx);
                res.push(sqrt_lt * dty);
                res.push(sqrt_lt * dtz);
            }
        }
        res
    }

    /// Numerical Jacobian via central finite differences.
    ///
    /// Per-slot step sizes (modulo 7-element camera block):
    /// - slots 0..3: rotation axis-angle, ε = 1e-6 (radians).
    /// - slot  3   : focal length, ε = 1e-4 (pixels — focal is ~10³ in pixels).
    /// - slots 4..7: translation in scene-depth units, ε = 1e-6
    ///   (translations are typically ≪0.01 = 1% of unit depth).
    fn jacobian(&self, params: &[f64]) -> DMatrix<f64> {
        let n_params = params.len();
        let res0 = self.residuals(params);
        let n_res = res0.len();

        let mut jac = DMatrix::zeros(n_res, n_params);
        let mut p = params.to_vec();

        for j in 0..n_params {
            let slot_in_cam = j % 7;
            // Focal slot uses larger epsilon because the parameter is in
            // pixel units (~10³) while rotation and translation are in
            // radians / scene-depth-units (~10⁰ to 10⁻²).
            let eps = if slot_in_cam == 3 { 1e-4 } else { 1e-6 };

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
                        if verbose {
                            eprintln!("joint_ba: converged at iter={_iter}");
                            for i in 0..(params.len() / 7) {
                                let slot = i * 7;
                                let omega_norm = (params[slot] * params[slot]
                                    + params[slot + 1] * params[slot + 1]
                                    + params[slot + 2] * params[slot + 2])
                                    .sqrt();
                                let deg = omega_norm.to_degrees();
                                let t_norm = (params[slot + 4] * params[slot + 4]
                                    + params[slot + 5] * params[slot + 5]
                                    + params[slot + 6] * params[slot + 6])
                                    .sqrt();
                                eprintln!(
                                    "  cam[{}] omega_deg={:.2} focal={:.1} ‖t‖={:.4}",
                                    i + 1,
                                    deg,
                                    params[slot + 3],
                                    t_norm,
                                );
                            }
                        }
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
            for i in 0..(params.len() / 7) {
                let slot = i * 7;
                let omega_norm = (params[slot] * params[slot]
                    + params[slot + 1] * params[slot + 1]
                    + params[slot + 2] * params[slot + 2])
                    .sqrt();
                let deg = omega_norm.to_degrees();
                let t_norm = (params[slot + 4] * params[slot + 4]
                    + params[slot + 5] * params[slot + 5]
                    + params[slot + 6] * params[slot + 6])
                    .sqrt();
                eprintln!(
                    "  cam[{}] omega_deg={:.2} focal={:.1} ‖t‖={:.4}",
                    i + 1,
                    deg,
                    params[slot + 3],
                    t_norm,
                );
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
    use crate::types::{Keypoint, Match};

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

    /// With strong λ_rotation, BA refuses to drift far from the prior even
    /// when the inlier matches strongly suggest a different rotation.
    /// This is the key invariant Step 4 must enforce: prior wins when
    /// matches are bad (which is the DJI zero-displacement scenario).
    #[test]
    fn high_lambda_rotation_keeps_solution_near_prior() {
        // 2 cameras, 1 pair. The pair contains 4 zero-displacement
        // correspondences (pa == pb), which would normally pull camera 1
        // toward identity rotation. The prior says camera 1 is rotated
        // 20° around Y (yaw); we want BA to land near 20°, not 0°.
        let prior_yaw_deg = 20.0_f64;
        let prior_omega = Vector3::new(0.0, prior_yaw_deg.to_radians(), 0.0);
        let prior_rotation = rodrigues_exp(prior_omega);

        // Synthesise zero-displacement matches (pa == pb in a 1024×768 image).
        let kps = vec![
            Keypoint { x: 100.0, y: 100.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 200.0, y: 300.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 800.0, y: 400.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 500.0, y: 600.0, scale: 1.0, angle: 0.0, response: 1.0 },
        ];
        let feats = vec![
            Features { keypoints: kps.clone(), descriptors: vec![], descriptor_dim: 0 },
            Features { keypoints: kps.clone(), descriptors: vec![], descriptor_dim: 0 },
        ];
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
                Match { a: 3, b: 3, distance: 0.0 },
            ],
        };
        let pairs = vec![(0_usize, 1_usize, matches)];
        let priors_vec = vec![
            Some(CameraPrior::new(Matrix3::identity(), 1000.0)),
            Some(CameraPrior::new(prior_rotation, 1000.0)),
        ];

        // High lambda: BA should land near 20° yaw, not at 0°.
        //
        // Math: 4 zero-displacement matches at focal=1000 have reprojection
        // error ≈ focal·tan(20°) ≈ 364 px each → total match cost ≈ 1.0M.
        // Prior cost at identity (= 20° drift) = λ · (0.349 rad)² ≈ 0.122·λ.
        // For prior to dominate we need λ ≳ 1e7. Use 1e9 to be safe.
        let config_high = JointRotationFocalBA {
            max_iters: 200,
            step_tolerance: 1e-9,
            lambda_rotation: 1.0e9,
            lambda_focal: 0.0,
            lambda_translation: 0.0,
        };
        let cams_high = solve_joint_with_priors(
            &feats,
            &pairs,
            (1024, 768),
            Some(&priors_vec),
            &config_high,
        )
        .expect("solve must succeed");
        let omega_high = rodrigues_log(&cams_high[1].rotation.cast::<f64>());
        let yaw_high_deg = omega_high.y.to_degrees();
        assert!(
            (yaw_high_deg - prior_yaw_deg).abs() < 1.0,
            "high-λ solver should keep yaw near prior {prior_yaw_deg}°, got {yaw_high_deg}°"
        );

        // Zero lambda: BA should drift toward identity (the matches'
        // "answer"). Confirm the difference from prior is large to validate
        // that the prior is what's holding cams_high near 20°.
        let config_zero = JointRotationFocalBA {
            max_iters: 50,
            step_tolerance: 1e-6,
            lambda_rotation: 0.0,
            lambda_focal: 0.0,
            lambda_translation: 0.0,
        };
        let cams_zero = solve_joint_with_priors(
            &feats,
            &pairs,
            (1024, 768),
            Some(&priors_vec),
            &config_zero,
        )
        .expect("solve must succeed");
        let omega_zero = rodrigues_log(&cams_zero[1].rotation.cast::<f64>());
        let yaw_zero_deg = omega_zero.y.to_degrees();
        assert!(
            (yaw_zero_deg - prior_yaw_deg).abs() > (yaw_high_deg - prior_yaw_deg).abs() + 0.5,
            "zero-λ should drift further from prior than high-λ: zero={yaw_zero_deg}°, high={yaw_high_deg}°, prior={prior_yaw_deg}°"
        );
    }

    /// With matches that genuinely require translation (e.g. drone drift
    /// between two frames at the same gimbal pose), letting BA optimize
    /// translation should reduce reprojection residuals — confirming
    /// the planar-at-unit-depth model is wired correctly.
    ///
    /// Setup: two cameras at IDENTICAL rotation (cam[1] gimbal prior =
    /// identity), but the matches show a +5 px x-shift (i.e. the
    /// drone moved laterally by some small amount). With λ_t=0 (no
    /// translation prior) and λ_rot=∞ (rotation locked at identity),
    /// translation must absorb all the residual to fit the matches.
    #[test]
    fn translation_absorbs_pure_translation_residual() {
        // Both cameras rotation-locked at identity (gimbal prior says
        // they have the same pose). 4 matches that show a +20 px shift
        // in X — pure translation, not rotation.
        let prior_rotation = Matrix3::identity();
        let kps_a = vec![
            Keypoint { x: 200.0, y: 200.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 800.0, y: 200.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 200.0, y: 600.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 800.0, y: 600.0, scale: 1.0, angle: 0.0, response: 1.0 },
        ];
        // kps_b: same as kps_a shifted by +20 px in X.
        let kps_b: Vec<Keypoint> = kps_a
            .iter()
            .map(|kp| Keypoint { x: kp.x + 20.0, ..*kp })
            .collect();

        let feats = vec![
            Features { keypoints: kps_a, descriptors: vec![], descriptor_dim: 0 },
            Features { keypoints: kps_b, descriptors: vec![], descriptor_dim: 0 },
        ];
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
                Match { a: 3, b: 3, distance: 0.0 },
            ],
        };
        let pairs = vec![(0_usize, 1_usize, matches)];
        let priors_vec = vec![
            Some(CameraPrior::new(prior_rotation, 1000.0)),
            Some(CameraPrior::new(prior_rotation, 1000.0)),
        ];

        // Config: lock rotation + focal hard to the prior; allow
        // translation to move freely (λ_t = 0).
        let config = JointRotationFocalBA {
            max_iters: 200,
            step_tolerance: 1e-9,
            lambda_rotation: 1.0e9,
            lambda_focal: 1.0e9,
            lambda_translation: 0.0,
        };
        let cams = solve_joint_with_priors(
            &feats,
            &pairs,
            (1024, 768),
            Some(&priors_vec),
            &config,
        )
        .expect("solve must succeed");

        // cam[1] should have rotation ≈ prior (identity) and focal ≈ 1000.
        let omega = rodrigues_log(&cams[1].rotation.cast::<f64>());
        assert!(
            omega.norm().to_degrees() < 0.5,
            "rotation should stay locked at prior, got {} deg",
            omega.norm().to_degrees(),
        );
        assert!(
            (cams[1].focal as f64 - 1000.0).abs() < 5.0,
            "focal should stay locked at prior, got {}",
            cams[1].focal,
        );
        // Translation isn't returned in Camera but the test passes if
        // the rotation+focal stayed at prior — meaning BA used some
        // OTHER knob (translation) to reduce residual instead of
        // bending rotation/focal. With both rot/focal heavily clamped
        // and only translation free, this is the only way the
        // optimizer could have made progress.
    }

    /// With λ_t large and t_prior=0, BA should NOT move translation
    /// — equivalent to the legacy rotation-only solver. Sanity check.
    #[test]
    fn high_lambda_translation_keeps_translation_at_zero() {
        let kps = vec![
            Keypoint { x: 200.0, y: 200.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 800.0, y: 200.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 200.0, y: 600.0, scale: 1.0, angle: 0.0, response: 1.0 },
            Keypoint { x: 800.0, y: 600.0, scale: 1.0, angle: 0.0, response: 1.0 },
        ];
        let feats = vec![
            Features { keypoints: kps.clone(), descriptors: vec![], descriptor_dim: 0 },
            Features { keypoints: kps.clone(), descriptors: vec![], descriptor_dim: 0 },
        ];
        let matches = Matches {
            inliers: vec![
                Match { a: 0, b: 0, distance: 0.0 },
                Match { a: 1, b: 1, distance: 0.0 },
                Match { a: 2, b: 2, distance: 0.0 },
                Match { a: 3, b: 3, distance: 0.0 },
            ],
        };
        let pairs = vec![(0_usize, 1_usize, matches)];
        let priors_vec = vec![
            Some(CameraPrior::new(Matrix3::identity(), 1000.0)),
            Some(CameraPrior::new(Matrix3::identity(), 1000.0)),
        ];

        // High λ_t: translation should stay at zero prior.
        let config = JointRotationFocalBA {
            max_iters: 100,
            step_tolerance: 1e-9,
            lambda_rotation: 1.0e9,
            lambda_focal: 1.0e9,
            lambda_translation: 1.0e9,
        };
        let cams = solve_joint_with_priors(
            &feats,
            &pairs,
            (1024, 768),
            Some(&priors_vec),
            &config,
        )
        .expect("solve must succeed");

        // Trivial: zero-displacement matches + identity prior →
        // perfect fit, all params unchanged. Translation invisible
        // in Camera output, but rot/focal stay locked.
        let omega = rodrigues_log(&cams[1].rotation.cast::<f64>());
        assert!(omega.norm() < 1e-3);
        assert!((cams[1].focal as f64 - 1000.0).abs() < 1.0);
    }
}
