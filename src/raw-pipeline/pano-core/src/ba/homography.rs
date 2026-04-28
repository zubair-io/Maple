//! DLT homography estimation and RANSAC fitting.
//!
//! ## Algorithm
//! Normalised DLT (8-point / 4-point) for the homography estimate.
//! Outlier rejection via `arrsac` (USAC-MAGSAC variant), implemented
//! through the `sample-consensus` traits below. A hand-rolled
//! deterministic 2000-iteration RANSAC is retained as
//! [`ransac_homography_handrolled`] for the pano-smoke regression
//! gate; the public [`ransac_homography`] dispatches to arrsac.

use nalgebra::{Matrix3, Vector3};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sample_consensus::{Consensus, Estimator, Model};

use crate::types::{Keypoint, Match};

/// A 3×3 homography mapping points in image A to image B (f64 for precision).
#[derive(Clone, Debug)]
pub struct Homography(pub Matrix3<f64>);

impl Homography {
    /// Map a 2D point `(x, y)` through this homography.
    pub fn map(&self, x: f64, y: f64) -> (f64, f64) {
        let p = self.0 * Vector3::new(x, y, 1.0);
        (p.x / p.z, p.y / p.z)
    }

    /// Squared reprojection error for a correspondence.
    pub fn reprojection_sq(&self, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        let (px, py) = self.map(ax, ay);
        let dx = px - bx;
        let dy = py - by;
        dx * dx + dy * dy
    }
}

/// Normalise 2D points so that the centroid is at the origin and the mean
/// distance from origin is sqrt(2).  Returns (normalised points, transform).
fn normalise(pts: &[(f64, f64)]) -> (Vec<(f64, f64)>, Matrix3<f64>) {
    let n = pts.len() as f64;
    let cx: f64 = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let cy: f64 = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let scale: f64 = {
        let mean_dist = pts
            .iter()
            .map(|p| ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt())
            .sum::<f64>()
            / n;
        if mean_dist < 1e-10 {
            1.0
        } else {
            std::f64::consts::SQRT_2 / mean_dist
        }
    };
    let normed: Vec<(f64, f64)> = pts
        .iter()
        .map(|&(x, y)| ((x - cx) * scale, (y - cy) * scale))
        .collect();
    // T: scale then translate
    #[rustfmt::skip]
    let t = Matrix3::new(
        scale, 0.0,   -cx * scale,
        0.0,   scale, -cy * scale,
        0.0,   0.0,   1.0,
    );
    (normed, t)
}

/// Compute a homography from exactly 4 (or more) point correspondences using
/// normalised DLT.  Returns `None` if the system is degenerate.
pub fn dlt_homography(pts_a: &[(f64, f64)], pts_b: &[(f64, f64)]) -> Option<Homography> {
    debug_assert_eq!(pts_a.len(), pts_b.len());
    debug_assert!(pts_a.len() >= 4);

    let (na, ta) = normalise(pts_a);
    let (nb, tb) = normalise(pts_b);

    // Build the 2n × 9 design matrix A.
    let n = na.len();
    let mut rows: Vec<[f64; 9]> = Vec::with_capacity(n * 2);
    for i in 0..n {
        let (ax, ay) = na[i];
        let (bx, by) = nb[i];
        rows.push([-ax, -ay, -1.0, 0.0, 0.0, 0.0, bx * ax, bx * ay, bx]);
        rows.push([0.0, 0.0, 0.0, -ax, -ay, -1.0, by * ax, by * ay, by]);
    }

    // Assemble into nalgebra DMatrix.  Pad to at least 9 rows so that
    // nalgebra's SVD returns a full 9×9 V^T (V_T has `min(m, n)` rows, so
    // for m < 9 we lose the last null-space column).
    let nrows = rows.len().max(9);
    let mut mat = nalgebra::DMatrix::<f64>::zeros(nrows, 9);
    for (i, row) in rows.iter().enumerate() {
        for j in 0..9 {
            mat[(i, j)] = row[j];
        }
    }
    // Extra zero rows (for the 4-point case) don't change the null space.

    let svd = mat.svd(false, true);
    let vt = svd.v_t?;

    // The solution is the last row of V^T (corresponding to the smallest
    // singular value).  With `min(m, n) = 9` rows in V^T, that is row 8.
    let last_row = vt.row(vt.nrows() - 1);
    #[rustfmt::skip]
    let hn = Matrix3::new(
        last_row[0], last_row[1], last_row[2],
        last_row[3], last_row[4], last_row[5],
        last_row[6], last_row[7], last_row[8],
    );

    // Denormalise: H = T_b^-1 * H_n * T_a
    let tb_inv = tb.try_inverse()?;
    let h = tb_inv * hn * ta;

    // Normalise so h[2][2] = 1 (if non-zero).
    if h[(2, 2)].abs() < 1e-10 {
        return None;
    }
    Some(Homography(h / h[(2, 2)]))
}

// ---------------------------------------------------------------------------
// sample-consensus glue for arrsac
// ---------------------------------------------------------------------------

/// Datum for arrsac: a single (a, b) keypoint correspondence in pixel
/// coordinates.
#[derive(Clone, Copy, Debug)]
pub struct Correspondence {
    pub ax: f64,
    pub ay: f64,
    pub bx: f64,
    pub by: f64,
}

impl Model<Correspondence> for Homography {
    fn residual(&self, data: &Correspondence) -> f64 {
        // Square root of reprojection so the residual matches arrsac's
        // pixel-distance threshold semantics directly.
        self.reprojection_sq(data.ax, data.ay, data.bx, data.by).sqrt()
    }
}

/// `Estimator` that fits a homography from at least 4 correspondences via
/// normalised DLT.
pub struct DltHomographyEstimator;

impl Estimator<Correspondence> for DltHomographyEstimator {
    type Model = Homography;
    type ModelIter = Vec<Homography>;
    const MIN_SAMPLES: usize = 4;

    fn estimate<I>(&self, data: I) -> Self::ModelIter
    where
        I: Iterator<Item = Correspondence> + Clone,
    {
        let pts: Vec<Correspondence> = data.collect();
        if pts.len() < Self::MIN_SAMPLES {
            return Vec::new();
        }
        let pts_a: Vec<(f64, f64)> = pts.iter().map(|c| (c.ax, c.ay)).collect();
        let pts_b: Vec<(f64, f64)> = pts.iter().map(|c| (c.bx, c.by)).collect();
        match dlt_homography(&pts_a, &pts_b) {
            Some(h) => vec![h],
            None => Vec::new(),
        }
    }
}

/// RANSAC homography estimation via `arrsac`.
///
/// Returns the best-fitting homography and the inlier indices into `matches`.
/// `inlier_threshold_px` is the pixel reprojection threshold; `max_iterations`
/// is forwarded as `arrsac`'s `max_candidate_hypotheses`.
pub fn ransac_homography(
    kps_a: &[Keypoint],
    kps_b: &[Keypoint],
    matches: &[Match],
    inlier_threshold_px: f64,
    max_iterations: usize,
    seed: u64,
) -> Option<(Homography, Vec<usize>)> {
    if matches.len() < 4 {
        return None;
    }

    // Build the data array (in match order so inlier indices map back).
    let data: Vec<Correspondence> = matches
        .iter()
        .map(|m| {
            let ka = &kps_a[m.a as usize];
            let kb = &kps_b[m.b as usize];
            Correspondence {
                ax: ka.x as f64,
                ay: ka.y as f64,
                bx: kb.x as f64,
                by: kb.y as f64,
            }
        })
        .collect();

    let rng = StdRng::seed_from_u64(seed);
    let mut arrsac = arrsac::Arrsac::new(inlier_threshold_px, rng)
        .max_candidate_hypotheses(max_iterations);

    let estimator = DltHomographyEstimator;
    let (model, inliers) =
        arrsac.model_inliers(&estimator, data.iter().copied())?;

    // Refit on all inliers via DLT (arrsac may have selected the best
    // 4-point sample but a refit on all inliers tightens the result).
    let inliers_vec: Vec<usize> = inliers.into_iter().collect();
    if inliers_vec.len() >= 4 {
        let pts_a: Vec<(f64, f64)> = inliers_vec
            .iter()
            .map(|&i| (data[i].ax, data[i].ay))
            .collect();
        let pts_b: Vec<(f64, f64)> = inliers_vec
            .iter()
            .map(|&i| (data[i].bx, data[i].by))
            .collect();
        if let Some(refined) = dlt_homography(&pts_a, &pts_b) {
            // Re-count inliers with the refined model.
            let thresh_sq = inlier_threshold_px * inlier_threshold_px;
            let refined_inliers: Vec<usize> = data
                .iter()
                .enumerate()
                .filter_map(|(i, c)| {
                    let err = refined.reprojection_sq(c.ax, c.ay, c.bx, c.by);
                    if err < thresh_sq {
                        Some(i)
                    } else {
                        None
                    }
                })
                .collect();
            return Some((refined, refined_inliers));
        }
    }

    Some((model, inliers_vec))
}

/// Hand-rolled deterministic RANSAC (kept for parity with the pre-arrsac
/// behaviour). Same signature as [`ransac_homography`]; useful for the
/// regression gate when comparing arrsac output against the older path.
#[allow(dead_code)]
pub fn ransac_homography_handrolled(
    kps_a: &[Keypoint],
    kps_b: &[Keypoint],
    matches: &[Match],
    inlier_threshold_px: f64,
    max_iterations: usize,
    seed: u64,
) -> Option<(Homography, Vec<usize>)> {
    if matches.len() < 4 {
        return None;
    }

    let thresh_sq = inlier_threshold_px * inlier_threshold_px;
    let mut rng = StdRng::seed_from_u64(seed);
    let n = matches.len();
    let mut best_h: Option<Homography> = None;
    let mut best_inliers: Vec<usize> = Vec::new();

    for _ in 0..max_iterations {
        // Sample 4 distinct correspondences.
        let sample = random_sample_4(&mut rng, n);
        let pts_a: Vec<(f64, f64)> = sample
            .iter()
            .map(|&i| {
                let kp = &kps_a[matches[i].a as usize];
                (kp.x as f64, kp.y as f64)
            })
            .collect();
        let pts_b: Vec<(f64, f64)> = sample
            .iter()
            .map(|&i| {
                let kp = &kps_b[matches[i].b as usize];
                (kp.x as f64, kp.y as f64)
            })
            .collect();

        let Some(h) = dlt_homography(&pts_a, &pts_b) else {
            continue;
        };

        // Count inliers.
        let inliers: Vec<usize> = matches
            .iter()
            .enumerate()
            .filter_map(|(i, m)| {
                let kpa = &kps_a[m.a as usize];
                let kpb = &kps_b[m.b as usize];
                let err = h.reprojection_sq(kpa.x as f64, kpa.y as f64, kpb.x as f64, kpb.y as f64);
                if err < thresh_sq {
                    Some(i)
                } else {
                    None
                }
            })
            .collect();

        if inliers.len() > best_inliers.len() {
            best_inliers = inliers;
            best_h = Some(h);
        }
    }

    // Refit on all inliers.
    if best_h.is_some() && best_inliers.len() >= 4 {
        {
            let pts_a: Vec<(f64, f64)> = best_inliers
                .iter()
                .map(|&i| {
                    let kp = &kps_a[matches[i].a as usize];
                    (kp.x as f64, kp.y as f64)
                })
                .collect();
            let pts_b: Vec<(f64, f64)> = best_inliers
                .iter()
                .map(|&i| {
                    let kp = &kps_b[matches[i].b as usize];
                    (kp.x as f64, kp.y as f64)
                })
                .collect();
            if let Some(refined) = dlt_homography(&pts_a, &pts_b) {
                // Recount inliers with refined model.
                let refined_inliers: Vec<usize> = matches
                    .iter()
                    .enumerate()
                    .filter_map(|(i, m)| {
                        let kpa = &kps_a[m.a as usize];
                        let kpb = &kps_b[m.b as usize];
                        let err = refined.reprojection_sq(
                            kpa.x as f64,
                            kpa.y as f64,
                            kpb.x as f64,
                            kpb.y as f64,
                        );
                        if err < thresh_sq {
                            Some(i)
                        } else {
                            None
                        }
                    })
                    .collect();
                return Some((refined, refined_inliers));
            }
        }
    }

    best_h.map(|h| (h, best_inliers))
}

/// Extract the rotation component from a homography under the pure-rotation
/// camera model: H ≈ K * R * K^-1.
///
/// `focal` is the assumed focal length (in pixels); the principal point is
/// assumed to be the image centre.
pub fn rotation_from_homography(
    h: &Homography,
    focal: f64,
    width: f64,
    height: f64,
) -> Matrix3<f64> {
    let cx = width / 2.0;
    let cy = height / 2.0;
    #[rustfmt::skip]
    let k = Matrix3::new(
        focal, 0.0,   cx,
        0.0,   focal, cy,
        0.0,   0.0,   1.0,
    );
    let k_inv = k.try_inverse().unwrap_or_else(Matrix3::identity);
    let r_approx = k_inv * h.0 * k;

    // Project onto SO(3) via SVD.
    let svd = r_approx.svd(true, true);
    match (svd.u, svd.v_t) {
        (Some(u), Some(vt)) => {
            let r = u * vt;
            // Ensure det(R) = +1 (not -1).
            let det = r.determinant();
            if det < 0.0 {
                let mut correction = Matrix3::identity();
                correction[(2, 2)] = -1.0;
                u * correction * vt
            } else {
                r
            }
        }
        _ => Matrix3::identity(),
    }
}

/// Sample 4 distinct indices uniformly from [0, n).
fn random_sample_4(rng: &mut StdRng, n: usize) -> [usize; 4] {
    let mut out = [0usize; 4];
    let mut count = 0;
    while count < 4 {
        let idx = rng.gen_range(0..n);
        if !out[..count].contains(&idx) {
            out[count] = idx;
            count += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Keypoint;

    fn kp(x: f32, y: f32) -> Keypoint {
        Keypoint {
            x,
            y,
            scale: 1.0,
            angle: 0.0,
            response: 1.0,
        }
    }

    #[test]
    fn dlt_identity_roundtrip() {
        // Identity homography: a = b for all points.
        let pts: Vec<(f64, f64)> = vec![(10.0, 20.0), (50.0, 80.0), (120.0, 30.0), (200.0, 150.0)];
        let h = dlt_homography(&pts, &pts).unwrap();
        for &(ax, ay) in &pts {
            let (px, py) = h.map(ax, ay);
            assert!((px - ax).abs() < 0.5, "x mismatch: {px} vs {ax}");
            assert!((py - ay).abs() < 0.5, "y mismatch: {py} vs {ay}");
        }
    }

    #[test]
    fn dlt_pure_translation() {
        let dx = 30.0_f64;
        let dy = -15.0_f64;
        let pts_a: Vec<(f64, f64)> = vec![(10.0, 10.0), (80.0, 20.0), (50.0, 90.0), (120.0, 60.0)];
        let pts_b: Vec<(f64, f64)> = pts_a.iter().map(|&(x, y)| (x + dx, y + dy)).collect();
        let h = dlt_homography(&pts_a, &pts_b).unwrap();
        for (&(ax, ay), &(bx, by)) in pts_a.iter().zip(pts_b.iter()) {
            let (px, py) = h.map(ax, ay);
            assert!((px - bx).abs() < 0.5);
            assert!((py - by).abs() < 0.5);
        }
    }

    #[test]
    fn ransac_recovers_translation() {
        // 20 exact correspondences from a pure 10px horizontal translation +
        // 5 random outliers.
        let n = 25;
        let dx = 10.0_f32;
        let dy = 5.0_f32;
        let mut kps_a: Vec<Keypoint> = Vec::new();
        let mut kps_b: Vec<Keypoint> = Vec::new();
        let mut matches: Vec<Match> = Vec::new();
        for i in 0..20u32 {
            let x = (i * 13 % 200) as f32 + 30.0;
            let y = (i * 17 % 150) as f32 + 30.0;
            kps_a.push(kp(x, y));
            kps_b.push(kp(x + dx, y + dy));
            matches.push(Match {
                a: i,
                b: i,
                distance: 0.0,
            });
        }
        // 5 outlier matches pointing at wrong locations.
        for i in 20u32..25 {
            kps_a.push(kp((i * 7 % 50) as f32, (i * 11 % 50) as f32));
            kps_b.push(kp(150.0, 150.0));
            matches.push(Match {
                a: i,
                b: i,
                distance: 10.0,
            });
        }
        let _ = n;

        let (h, inliers) = ransac_homography(&kps_a, &kps_b, &matches, 2.0, 500, 42).unwrap();

        assert!(
            inliers.len() >= 15,
            "expected ≥15 inliers, got {}",
            inliers.len()
        );

        // The translation components should be within ±3 px.
        let (ox, oy) = h.map(0.0, 0.0);
        assert!((ox - dx as f64).abs() < 3.0, "x translation off: {ox}");
        assert!((oy - dy as f64).abs() < 3.0, "y translation off: {oy}");
    }
}
