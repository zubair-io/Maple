//! Robust 2D similarity estimation from pixel correspondences (spec §8,
//! ticket #1226).
//!
//! A 2D **similarity transform** maps one pixel frame into another:
//!
//! ```text
//! p_b = s · R(θ) · p_a + t,   s > 0, θ ∈ (−π, π], t ∈ ℝ²
//! ```
//!
//! In the tile strategy this is the model for how frame B sits relative
//! to frame A on the planar canvas — translation, small rotation (gimbal
//! attitude drift), and scale (altitude change). The solver is the same
//! MAGSAC-style minimal-sample RANSAC that [`crate::robust`] uses for
//! rotations, adapted for the 2-point minimal sample of a similarity
//! (4 DOF, 2 equations per point → exactly determined at 2 non-coincident
//! points).
//!
//! # Minimal sample
//!
//! Given two correspondences `(a₁, b₁)` and `(a₂, b₂)`:
//!
//! ```text
//! s·e^{iθ} · (a₂ − a₁) = (b₂ − b₁)
//! ```
//!
//! This fixes `s · e^{iθ}` uniquely (the complex ratio of the b-gap to the
//! a-gap) whenever `a₂ ≠ a₁`. Then `t = b₁ − s·R(θ)·a₁`. Degenerate when
//! both source points coincide (cross-product of complex vectors near zero).
//!
//! # Inlier scoring
//!
//! Euclidean residual `‖b − (s·R·a + t)‖` in pixels (symmetric: both
//! frames contribute equally in pixel space). MAGSAC-style σ-marginalized
//! score (truncated quadratic per scale level), then the data-driven
//! σ̂ = median/RAYLEIGH_MEDIAN (Rayleigh model for 2-D isotropic Gaussian
//! pixel errors, 2 DOF). Final inlier gate: residual < 3.5·σ̂ ∩ < τ(σ_max).
//!
//! # Comparison metric for auto-selection
//!
//! [`planar_rms_px`] evaluates the rotation model's correspondences under
//! the fitted similarity — if the similarity fits materially better, the
//! pair votes "tile". [`rotation_residual_px`] symmetrically evaluates the
//! similarity model's inliers under the angular-reprojection residual, for
//! the rotation vote.

use crate::prng::SplitMix64;
use crate::twoview::PixelCorrespondence;

/// 4-DOF similarity transform: scale `s`, rotation `theta` (radians),
/// translation `(tx, ty)` — all in pixel space.
///
/// The transform maps frame-A pixel coordinates into frame-B pixel
/// coordinates: `b = s·R(θ)·a + t`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Similarity2d {
    pub scale: f64,
    /// Rotation angle, radians. In the tile strategy |θ| is typically small
    /// (gimbal drift, < 5°) but the solver handles arbitrary rotations.
    pub theta: f64,
    pub tx: f64,
    pub ty: f64,
}

impl Similarity2d {
    /// Apply the transform to a source pixel, returning the destination
    /// pixel.
    pub fn apply(&self, ax: f64, ay: f64) -> (f64, f64) {
        let (sin, cos) = self.theta.sin_cos();
        let rx = cos * ax - sin * ay;
        let ry = sin * ax + cos * ay;
        (self.scale * rx + self.tx, self.scale * ry + self.ty)
    }

    /// Euclidean pixel residual: ‖b − T(a)‖.
    pub fn residual_px(&self, m: &PixelCorrespondence) -> f64 {
        let (bx, by) = self.apply(m.a.0, m.a.1);
        let dx = bx - m.b.0;
        let dy = by - m.b.1;
        (dx * dx + dy * dy).sqrt()
    }
}

/// Fit a [`Similarity2d`] from exactly two correspondences.
///
/// Returns `None` when the source points are nearly coincident (the
/// cross-product magnitude of the complex a-gap is below `MIN_CROSS`).
fn solve_similarity_2pt(
    m0: &PixelCorrespondence,
    m1: &PixelCorrespondence,
) -> Option<Similarity2d> {
    // Complex difference vectors: da = (a1 − a0), db = (b1 − b0).
    let da_x = m1.a.0 - m0.a.0;
    let da_y = m1.a.1 - m0.a.1;
    let da_norm_sq = da_x * da_x + da_y * da_y;
    if da_norm_sq < MIN_CROSS_SQ {
        return None;
    }
    let db_x = m1.b.0 - m0.b.0;
    let db_y = m1.b.1 - m0.b.1;

    // Complex ratio: (s·e^iθ) = db / da  (complex division).
    // Re(db/da) = (db_x·da_x + db_y·da_y) / |da|²
    // Im(db/da) = (db_y·da_x − db_x·da_y) / |da|²
    let c_re = (db_x * da_x + db_y * da_y) / da_norm_sq;
    let c_im = (db_y * da_x - db_x * da_y) / da_norm_sq;

    let scale = (c_re * c_re + c_im * c_im).sqrt();
    if scale < SCALE_FLOOR || scale > SCALE_CAP {
        return None;
    }
    let theta = c_im.atan2(c_re);

    // Translation: t = b0 − (s·R·a0).
    let (bx0, by0) = {
        let (sin, cos) = theta.sin_cos();
        let rx = cos * m0.a.0 - sin * m0.a.1;
        let ry = sin * m0.a.0 + cos * m0.a.1;
        (scale * rx, scale * ry)
    };
    let tx = m0.b.0 - bx0;
    let ty = m0.b.1 - by0;

    Some(Similarity2d {
        scale,
        theta,
        tx,
        ty,
    })
}

/// Minimum |da|² for a non-degenerate sample.
const MIN_CROSS_SQ: f64 = 1e-4;
/// Scale range accepted for a physical capture. Values outside [FLOOR, CAP]
/// arise from mismatches, not real camera motion.
const SCALE_FLOOR: f64 = 0.25;
const SCALE_CAP: f64 = 4.0;
/// σ-marginalization levels (mirrors the rotation RANSAC).
const SIGMA_LEVELS: usize = 8;
/// τ(σ) = TAU_SCALE·σ: 0.99-quantile of the χ distribution with 2 DOF.
const TAU_SCALE: f64 = 3.0348;
/// Final inlier gate in units of the Rayleigh σ̂.
const INLIER_SCALE: f64 = 3.5;
/// Rayleigh median: median of Rayleigh(σ) is σ·√(2 ln 2).
const RAYLEIGH_MEDIAN: f64 = 1.177_410_022_515_474_6;

/// Robust similarity estimator result.
#[derive(Debug, Clone)]
pub struct SimilarityEstimate {
    pub transform: Similarity2d,
    /// Index-aligned inlier mask for the input `matches`.
    pub inlier_mask: Vec<bool>,
    pub inlier_count: usize,
    /// Mean pixel residual over inliers.
    pub mean_residual_px: f64,
    /// Estimated Rayleigh noise scale of the residuals.
    pub sigma_hat_px: f64,
    pub iterations: usize,
}

/// Why robust similarity estimation failed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SimilarityFailure {
    #[error("too few correspondences: {have} (need >= {need})")]
    TooFewCorrespondences { have: usize, need: usize },
    #[error("no similarity hypothesis survived after {iterations} iterations")]
    NoModel { iterations: usize },
    #[error("only {inliers} inliers (pair acceptance requires >= {required})")]
    BelowMinInliers { inliers: usize, required: usize },
}

/// Tuning for [`estimate_similarity`].
#[derive(Debug, Clone)]
pub struct SimilarityOptions {
    pub max_iterations: usize,
    pub min_iterations: usize,
    pub confidence: f64,
    /// Maximum match noise 1-σ per axis, pixels. The marginalization
    /// integrates from 0 to this.
    pub sigma_max_px: f64,
    pub min_inliers: usize,
}

impl Default for SimilarityOptions {
    fn default() -> Self {
        Self {
            max_iterations: 2000,
            min_iterations: 20,
            confidence: 0.9995,
            sigma_max_px: 8.0,
            min_inliers: 30,
        }
    }
}

/// Robustly estimate a 2D similarity from pixel correspondences.
///
/// Uses a MAGSAC-style σ-marginalized RANSAC with a 2-point minimal
/// sample. All randomness comes from `rng`.
pub fn estimate_similarity(
    matches: &[PixelCorrespondence],
    opts: &SimilarityOptions,
    rng: &mut SplitMix64,
) -> Result<SimilarityEstimate, SimilarityFailure> {
    let n = matches.len();
    if n < opts.min_inliers.max(2) {
        return Err(SimilarityFailure::TooFewCorrespondences {
            have: n,
            need: opts.min_inliers.max(2),
        });
    }

    let sigma_max = opts.sigma_max_px;
    let tau_max = TAU_SCALE * sigma_max;

    let magsac_score = |residuals: &[f64]| -> f64 {
        let mut total = 0.0_f64;
        for &r in residuals {
            if r >= tau_max {
                continue;
            }
            for k in 1..=SIGMA_LEVELS {
                let sigma_k = (k as f64 / SIGMA_LEVELS as f64) * sigma_max;
                let tau_k = TAU_SCALE * sigma_k;
                if r < tau_k {
                    total += 1.0 - (r * r) / (tau_k * tau_k);
                }
            }
        }
        total
    };

    let residuals_for =
        |sim: &Similarity2d| -> Vec<f64> { matches.iter().map(|m| sim.residual_px(m)).collect() };

    let mut best: Option<(Similarity2d, f64, Vec<f64>)> = None;
    let mut best_inlier_ratio = 0.0_f64;
    let mut iters = 0_usize;
    let mut target_iters = opts.max_iterations;

    while iters < target_iters && iters < opts.max_iterations {
        iters += 1;

        // 2-point minimal sample.
        let i0 = (rng.next_u64() % n as u64) as usize;
        let mut i1 = (rng.next_u64() % n as u64) as usize;
        if i1 == i0 {
            i1 = (i1 + 1) % n;
        }

        let Some(sim) = solve_similarity_2pt(&matches[i0], &matches[i1]) else {
            continue;
        };

        let residuals = residuals_for(&sim);
        let score = magsac_score(&residuals);

        let current_best_score = best.as_ref().map(|(_, s, _)| *s);
        if current_best_score.is_none_or(|bs| score > bs) {
            // Local optimization: re-fit on soft inliers (weighted LS).
            let sim_lo = local_optimize(&sim, matches, sigma_max, rng);
            let res_lo = residuals_for(&sim_lo);
            let score_lo = magsac_score(&res_lo);
            let (chosen_sim, chosen_res, chosen_score) = if score_lo >= score {
                (sim_lo, res_lo, score_lo)
            } else {
                (sim, residuals, score)
            };

            // Adaptive termination update.
            let inlier_count = chosen_res.iter().filter(|&&r| r < tau_max).count();
            let ratio = inlier_count as f64 / n as f64;
            best = Some((chosen_sim, chosen_score, chosen_res));

            if ratio > best_inlier_ratio {
                best_inlier_ratio = ratio;
                if ratio > 0.0 {
                    let log_one_minus_conf = (1.0 - opts.confidence).ln();
                    let log_outlier = (1.0 - ratio * ratio).ln().max(-100.0);
                    let adaptive =
                        (log_one_minus_conf / log_outlier).ceil() as usize + opts.min_iterations;
                    target_iters = adaptive.min(opts.max_iterations).max(iters);
                }
            }
        }
    }

    let Some((best_sim, _, best_res)) = best else {
        return Err(SimilarityFailure::NoModel { iterations: iters });
    };

    // Data-driven noise scale (Rayleigh model, 2-DOF residuals).
    let mut finite: Vec<f64> = best_res.iter().copied().filter(|&r| r < tau_max).collect();
    finite.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    let sigma_hat = if finite.is_empty() {
        sigma_max
    } else {
        let med = if finite.len() % 2 == 0 {
            0.5 * (finite[finite.len() / 2 - 1] + finite[finite.len() / 2])
        } else {
            finite[finite.len() / 2]
        };
        (med / RAYLEIGH_MEDIAN).max(1e-3 * sigma_max)
    };
    let inlier_thresh = (INLIER_SCALE * sigma_hat).min(tau_max);

    let inlier_mask: Vec<bool> = best_res.iter().map(|&r| r < inlier_thresh).collect();
    let inlier_count = inlier_mask.iter().filter(|&&b| b).count();

    if inlier_count < opts.min_inliers {
        return Err(SimilarityFailure::BelowMinInliers {
            inliers: inlier_count,
            required: opts.min_inliers,
        });
    }

    let mean_residual_px = if inlier_count > 0 {
        best_res
            .iter()
            .zip(&inlier_mask)
            .filter(|(_, &b)| b)
            .map(|(&r, _)| r)
            .sum::<f64>()
            / inlier_count as f64
    } else {
        0.0
    };

    Ok(SimilarityEstimate {
        transform: best_sim,
        inlier_mask,
        inlier_count,
        mean_residual_px,
        sigma_hat_px: sigma_hat,
        iterations: iters,
    })
}

/// Weighted least-squares re-fit for local optimization.
///
/// Weight: MAGSAC soft weight at σ = σ_max. A similarity from `n ≥ 2`
/// weighted correspondences is solved in closed form via the weighted
/// covariance method (Horn 1987 §2, the 2-D special case).
fn local_optimize(
    seed: &Similarity2d,
    matches: &[PixelCorrespondence],
    sigma_max: f64,
    rng: &mut SplitMix64,
) -> Similarity2d {
    const LO_ITERS: usize = 5;
    let tau = TAU_SCALE * sigma_max;
    let mut current = *seed;

    for _ in 0..LO_ITERS {
        // Soft weights from the current model's residuals.
        let weights: Vec<f64> = matches
            .iter()
            .map(|m| {
                let r = current.residual_px(m);
                if r >= tau {
                    0.0
                } else {
                    1.0 - (r * r) / (tau * tau)
                }
            })
            .collect();

        let Some(fit) = wls_similarity(matches, &weights) else {
            break;
        };
        // Convergence check: if the translation and rotation barely moved,
        // stop early.
        let dt = (fit.tx - current.tx).hypot(fit.ty - current.ty);
        let da = (fit.theta - current.theta).abs();
        current = fit;
        if dt < 1e-6 && da < 1e-9 {
            break;
        }
        let _ = rng; // seed is not used for LO, parameter kept for API symmetry
    }
    current
}

/// Weighted least-squares similarity estimation (Horn 1987 §2, 2-D case).
///
/// Returns `None` when the weighted point cloud is degenerate (total weight
/// near zero, or all A-side points collapsed to one location).
fn wls_similarity(matches: &[PixelCorrespondence], weights: &[f64]) -> Option<Similarity2d> {
    let w_total: f64 = weights.iter().sum();
    if w_total < 1e-12 {
        return None;
    }

    // Weighted centroids.
    let mut ca_x = 0.0_f64;
    let mut ca_y = 0.0_f64;
    let mut cb_x = 0.0_f64;
    let mut cb_y = 0.0_f64;
    for (m, &w) in matches.iter().zip(weights) {
        ca_x += w * m.a.0;
        ca_y += w * m.a.1;
        cb_x += w * m.b.0;
        cb_y += w * m.b.1;
    }
    ca_x /= w_total;
    ca_y /= w_total;
    cb_x /= w_total;
    cb_y /= w_total;

    // Weighted cross-covariance and A-variance.
    // cov = Σ w · (a_cent)(b_cent)^T  (2×2, we track each element)
    // Saa = Σ w · |a_cent|²
    let mut s_xx = 0.0_f64;
    let mut s_xy = 0.0_f64;
    let mut s_yx = 0.0_f64;
    let mut s_yy = 0.0_f64;
    let mut saa = 0.0_f64;
    for (m, &w) in matches.iter().zip(weights) {
        let ax = m.a.0 - ca_x;
        let ay = m.a.1 - ca_y;
        let bx = m.b.0 - cb_x;
        let by = m.b.1 - cb_y;
        s_xx += w * ax * bx;
        s_xy += w * ax * by;
        s_yx += w * ay * bx;
        s_yy += w * ay * by;
        saa += w * (ax * ax + ay * ay);
    }
    if saa < 1e-12 {
        return None; // all A points collapsed
    }

    // Scale + rotation: s·e^{iθ} = (S_xx + S_yy + i(S_yx − S_xy)) / Saa
    let c_re = (s_xx + s_yy) / saa;
    let c_im = (s_yx - s_xy) / saa;
    let scale = (c_re * c_re + c_im * c_im).sqrt();
    if scale < SCALE_FLOOR || scale > SCALE_CAP {
        return None;
    }
    let theta = c_im.atan2(c_re);

    // Translation from centroids.
    let (sin, cos) = theta.sin_cos();
    let rx = cos * ca_x - sin * ca_y;
    let ry = sin * ca_x + cos * ca_y;
    let tx = cb_x - scale * rx;
    let ty = cb_y - scale * ry;

    Some(Similarity2d {
        scale,
        theta,
        tx,
        ty,
    })
}

/// Evaluate the mean planar pixel residual of the given correspondences
/// under the fitted similarity — used for the auto-selection comparison.
///
/// This is also the metric used to decide whether a pair "votes tile":
/// comparing `planar_rms_px` (similarity model RMS) against the rotation
/// model's angular residual converted to pixels at the frame's focal
/// length.
pub fn planar_rms_px(sim: &Similarity2d, matches: &[PixelCorrespondence]) -> f64 {
    if matches.is_empty() {
        return f64::INFINITY;
    }
    let sum: f64 = matches.iter().map(|m| sim.residual_px(m).powi(2)).sum();
    (sum / matches.len() as f64).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prng::SplitMix64;

    fn pixel_pair(ax: f64, ay: f64, bx: f64, by: f64) -> PixelCorrespondence {
        PixelCorrespondence {
            a: (ax, ay),
            b: (bx, by),
        }
    }

    fn apply_sim_to_corr(
        sim: &Similarity2d,
        matches: &[PixelCorrespondence],
    ) -> Vec<PixelCorrespondence> {
        matches
            .iter()
            .map(|m| {
                let (bx, by) = sim.apply(m.a.0, m.a.1);
                PixelCorrespondence {
                    a: m.a,
                    b: (bx, by),
                }
            })
            .collect()
    }

    #[test]
    fn solve_2pt_pure_translation() {
        let sim_gt = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 50.0,
            ty: -30.0,
        };
        let pts = vec![
            pixel_pair(100.0, 200.0, 150.0, 170.0),
            pixel_pair(300.0, 400.0, 350.0, 370.0),
        ];
        let est = solve_similarity_2pt(&pts[0], &pts[1]).unwrap();
        assert!(
            (est.scale - sim_gt.scale).abs() < 1e-10,
            "scale {}",
            est.scale
        );
        assert!(
            (est.theta - sim_gt.theta).abs() < 1e-10,
            "theta {}",
            est.theta
        );
        assert!((est.tx - sim_gt.tx).abs() < 1e-10, "tx {}", est.tx);
        assert!((est.ty - sim_gt.ty).abs() < 1e-10, "ty {}", est.ty);
    }

    #[test]
    fn solve_2pt_scale_and_rotation() {
        let sim_gt = Similarity2d {
            scale: 1.5,
            theta: 0.1,
            tx: 20.0,
            ty: -10.0,
        };
        let a0 = (100.0_f64, 200.0_f64);
        let a1 = (300.0_f64, 150.0_f64);
        let m0 = pixel_pair(
            a0.0,
            a0.1,
            sim_gt.apply(a0.0, a0.1).0,
            sim_gt.apply(a0.0, a0.1).1,
        );
        let m1 = pixel_pair(
            a1.0,
            a1.1,
            sim_gt.apply(a1.0, a1.1).0,
            sim_gt.apply(a1.0, a1.1).1,
        );
        let est = solve_similarity_2pt(&m0, &m1).unwrap();
        assert!((est.scale - sim_gt.scale).abs() < 1e-9);
        assert!((est.theta - sim_gt.theta).abs() < 1e-9);
        assert!((est.tx - sim_gt.tx).abs() < 1e-9);
        assert!((est.ty - sim_gt.ty).abs() < 1e-9);
    }

    #[test]
    fn coincident_points_return_none() {
        let m = pixel_pair(100.0, 100.0, 150.0, 150.0);
        assert!(solve_similarity_2pt(&m, &m).is_none());
    }

    #[test]
    fn robust_estimate_recovers_translation_under_noise() {
        let sim_gt = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 120.0,
            ty: -80.0,
        };
        let mut rng = SplitMix64::new(42);

        // Generate 200 matches with noise + 40 outliers.
        let n = 200;
        let n_out = 40;
        let mut matches: Vec<PixelCorrespondence> = (0..n)
            .map(|i| {
                let ax = (i as f64) * 3.0 + 50.0;
                let ay = ((i as f64) * 1.7).sin() * 100.0 + 300.0;
                let (mut bx, mut by) = sim_gt.apply(ax, ay);
                // add 0.5px noise
                bx += (rng.next_u64() as f64 / u64::MAX as f64 - 0.5) * 1.0;
                by += (rng.next_u64() as f64 / u64::MAX as f64 - 0.5) * 1.0;
                pixel_pair(ax, ay, bx, by)
            })
            .collect();
        // plant outliers
        for i in 0..n_out {
            matches[i].b.0 = (rng.next_u64() % 1000) as f64;
            matches[i].b.1 = (rng.next_u64() % 1000) as f64;
        }

        let opts = SimilarityOptions {
            min_inliers: 10,
            ..Default::default()
        };
        let est = estimate_similarity(&matches, &opts, &mut rng).unwrap();

        assert!(
            (est.transform.tx - sim_gt.tx).abs() < 2.0,
            "tx off: {}",
            est.transform.tx
        );
        assert!(
            (est.transform.ty - sim_gt.ty).abs() < 2.0,
            "ty off: {}",
            est.transform.ty
        );
        assert!(
            est.inlier_count >= n - n_out - 10,
            "inlier_count {}",
            est.inlier_count
        );
    }

    #[test]
    fn wls_similarity_pure_translation() {
        let matches: Vec<PixelCorrespondence> = (0..10)
            .map(|i| {
                pixel_pair(
                    i as f64 * 50.0,
                    i as f64 * 30.0,
                    i as f64 * 50.0 + 100.0,
                    i as f64 * 30.0 - 50.0,
                )
            })
            .collect();
        let weights = vec![1.0_f64; 10];
        let sim = wls_similarity(&matches, &weights).unwrap();
        assert!((sim.tx - 100.0).abs() < 1e-8, "tx {}", sim.tx);
        assert!((sim.ty + 50.0).abs() < 1e-8, "ty {}", sim.ty);
        assert!((sim.scale - 1.0).abs() < 1e-8, "scale {}", sim.scale);
        assert!(sim.theta.abs() < 1e-8, "theta {}", sim.theta);
    }

    #[test]
    fn planar_rms_is_zero_for_exact_inliers() {
        let sim = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 50.0,
            ty: -20.0,
        };
        let matches: Vec<PixelCorrespondence> = (0..5)
            .map(|i| {
                let ax = i as f64 * 100.0;
                let ay = i as f64 * 50.0;
                let (bx, by) = sim.apply(ax, ay);
                pixel_pair(ax, ay, bx, by)
            })
            .collect();
        let rms = planar_rms_px(&sim, &matches);
        assert!(rms < 1e-10, "rms {rms}");
    }
}
