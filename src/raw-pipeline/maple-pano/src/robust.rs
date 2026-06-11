//! Robust two-view rotation verification (spec §5.2 — "MAGSAC++ on the
//! rotation model"; pair acceptance ≥ 30 inliers).
//!
//! # Estimator choice (documented per ticket #1138)
//!
//! Hand-rolled, zero new dependencies — a consensus crate would add
//! `cargo vendor` surface for ~200 lines of code whose every constant we
//! want pinned and testable. The pieces:
//!
//! - **Minimal-sample RANSAC, 2 bearing pairs per hypothesis.** Pure
//!   rotation has 3 DOF; each unit-bearing pair gives 2 constraints, so
//!   2 non-collinear pairs over-determine (4 ≥ 3) and fix `R` uniquely —
//!   see [`crate::twoview`] for the degeneracy analysis. Hypotheses are
//!   solved with the same closed-form q-method as the full solve.
//!   Near-collinear samples (cross-product norm < ~0.6°) are skipped:
//!   they are solvable but ill-conditioned, and a fresh sample is cheaper
//!   than scoring a wobbly model.
//! - **MAGSAC-style σ-marginalized scoring** on *angular* residuals
//!   `r_i = ∠(R·a_i, b_i)`. Instead of one hard threshold, model quality
//!   is averaged over `sigma_levels` noise scales `σ_k = k/K·σ_max`,
//!   each contributing a truncated-quadratic gain
//!   `max(0, 1 − r²/τ(σ_k)²)` with `τ(σ) = 3.03·σ` (the 0.99 χ²₂
//!   quantile — residual direction errors are 2-DOF). This is the
//!   discretized marginalization of the original MAGSAC paper; the
//!   MAGSAC++ closed-form incomplete-gamma weights are a speed
//!   optimization that buys nothing at pano match counts (≤ a few
//!   thousand pairs, 2-point samples).
//! - **Local optimization (σ-consensus).** Every time a hypothesis takes
//!   the lead it is polished: compute per-pair marginalized weights,
//!   re-solve the weighted Wahba problem on all pairs, repeat until the
//!   rotation moves < 1e-9 rad or `lo_max_iterations` is hit. The better
//!   of {hypothesis, polished} is kept.
//! - **Adaptive termination.** Standard RANSAC bound
//!   `N ≥ ln(1−confidence)/ln(1−ε²)` with ε the best model's inlier
//!   ratio at the widest gate `τ(σ_max)`, floored by `min_iterations`.
//!
//! # Final classification
//!
//! MAGSAC never commits to a single σ while *scoring*, but the spec's
//! pair gate ("keep pairs with ≥ 30 inliers") needs a binary inlier set.
//! After polishing, the noise scale is estimated from the data:
//! `σ̂ = median{r_i : r_i < τ(σ_max)} / √(2·ln 2)` (median of a Rayleigh
//! distribution — the residual magnitude of a 2-D isotropic Gaussian
//! error), floored at `1e-3·σ_max` so exact synthetic data cannot
//! produce a degenerate threshold. Inliers are `r_i < min(3.5·σ̂,
//! τ(σ_max))`; 3.5σ keeps ~99.8 % of true Rayleigh inliers.
//!
//! # Determinism
//!
//! All randomness comes from one [`SplitMix64`] seeded by
//! [`RobustOptions::seed`]; scoring, polishing, and termination are pure.
//! Same input + same options ⇒ bit-identical [`RotationEstimate`].

use crate::camera::Camera;
use crate::math::{Mat3, Vec3};
use crate::prng::SplitMix64;
use crate::twoview::{
    angular_residual_rad, bearing_correspondences, rotation_angle_between, solve_rotation,
    PixelCorrespondence,
};

/// `τ(σ) = TAU_SCALE·σ`: 0.99 quantile of the χ distribution with 2 DOF
/// (`sqrt(9.2103)`), the residual-magnitude cap MAGSAC pairs with a given
/// noise scale.
const TAU_SCALE: f64 = 3.0348;
/// Final inlier threshold in units of the estimated Rayleigh scale σ̂.
const INLIER_SCALE: f64 = 3.5;
/// Median of a Rayleigh(σ) distribution is `σ·sqrt(2·ln 2)`.
const RAYLEIGH_MEDIAN: f64 = 1.177_410_022_515_474_6;
/// Minimal-sample conditioning gate: skip 2-pair samples whose bearings
/// are closer than ~0.6° to collinear on either side.
const MIN_SAMPLE_CROSS: f64 = 1e-2;
/// Local-optimization convergence: stop when the re-solve moves the
/// rotation by less than this (radians).
const LO_CONVERGENCE_RAD: f64 = 1e-9;

/// Tuning knobs for [`estimate_rotation`] / [`verify_pair`].
#[derive(Debug, Clone)]
pub struct RobustOptions {
    /// Hypothesis budget. The adaptive bound usually stops far earlier.
    pub max_iterations: usize,
    /// Floor on hypothesis count even when the adaptive bound is tiny.
    pub min_iterations: usize,
    /// RANSAC confidence for the adaptive termination bound.
    pub confidence: f64,
    /// Largest plausible match noise, pixels (1 σ, per axis). The
    /// σ-marginalization integrates from 0 to this.
    pub sigma_max_px: f64,
    /// Number of discrete σ levels in the marginalized score.
    pub sigma_levels: usize,
    /// Pair acceptance gate: verified edges need at least this many
    /// inliers (spec §5.2 sets 30).
    pub min_inliers: usize,
    /// Cap on local-optimization re-solve rounds per new best model.
    pub lo_max_iterations: usize,
    /// PRNG seed — the determinism contract is keyed on it.
    pub seed: u64,
}

impl Default for RobustOptions {
    fn default() -> Self {
        Self {
            max_iterations: 1024,
            min_iterations: 32,
            confidence: 0.9999,
            sigma_max_px: 3.0,
            sigma_levels: 8,
            min_inliers: 30,
            lo_max_iterations: 16,
            seed: 0x4D31_4131_5041_4E4F, // "M1A1PANO"
        }
    }
}

/// A robustly estimated relative rotation plus its support.
#[derive(Debug, Clone, PartialEq)]
pub struct RotationEstimate {
    /// `d_b ≈ rotation · d_a` (the [`crate::twoview`] convention).
    pub rotation: Mat3,
    /// Index-aligned with the input correspondence list. Entries whose
    /// pixels could not be converted to bearings are always `false`.
    pub inlier_mask: Vec<bool>,
    pub inlier_count: usize,
    /// Mean angular residual over the inlier set, radians.
    pub mean_residual_rad: f64,
    /// Estimated Rayleigh noise scale of the angular residuals, radians.
    pub sigma_hat_rad: f64,
    /// Marginalized score of the winning model (diagnostic; comparable
    /// only across runs on the same input).
    pub score: f64,
    /// Hypothesis iterations actually executed.
    pub iterations: usize,
}

/// Why verification failed for a pair.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum VerifyFailure {
    #[error("too few correspondences: {have} (need >= {need})")]
    TooFewCorrespondences { have: usize, need: usize },
    #[error("no rotation hypothesis survived after {iterations} iterations")]
    NoModel { iterations: usize },
    #[error("only {inliers} inliers (pair acceptance requires >= {required})")]
    BelowMinInliers { inliers: usize, required: usize },
}

/// Robustly estimate the relative rotation from bearing pairs.
///
/// `sigma_max_rad` is the angular equivalent of
/// [`RobustOptions::sigma_max_px`] (callers coming from pixels should use
/// [`verify_pair`], which derives it from the focal lengths). Does **not**
/// apply the `min_inliers` acceptance gate — that is [`verify_pair`]'s
/// job; this function is the raw estimator.
pub fn estimate_rotation(
    pairs: &[(Vec3, Vec3)],
    sigma_max_rad: f64,
    opts: &RobustOptions,
) -> Result<RotationEstimate, VerifyFailure> {
    let n = pairs.len();
    if n < 2 {
        return Err(VerifyFailure::TooFewCorrespondences { have: n, need: 2 });
    }
    let sigma_max = sigma_max_rad.max(1e-12);
    let tau_max = TAU_SCALE * sigma_max;
    let levels = opts.sigma_levels.max(1);

    let mut rng = SplitMix64::new(opts.seed);
    let mut residuals = vec![0.0_f64; n];
    let mut best: Option<(f64, Mat3)> = None;
    let mut required = opts.max_iterations;
    let mut executed = 0_usize;

    for it in 0..opts.max_iterations {
        if it >= required && it >= opts.min_iterations {
            break;
        }
        executed = it + 1;

        // Two distinct indices; re-draw collinear-ish samples.
        let i = (rng.next_u64() % n as u64) as usize;
        let mut j = (rng.next_u64() % n as u64) as usize;
        if j == i {
            j = (j + 1) % n;
        }
        let (a1, b1) = pairs[i];
        let (a2, b2) = pairs[j];
        if a1.cross(a2).norm() < MIN_SAMPLE_CROSS || b1.cross(b2).norm() < MIN_SAMPLE_CROSS {
            continue;
        }
        let Some(model) = solve_rotation(&[(a1, b1), (a2, b2)], None) else {
            continue;
        };

        let score = marginal_score(pairs, &model, sigma_max, levels, &mut residuals);
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            // Local optimization: σ-consensus polish, keep the better.
            let polished = local_optimize(pairs, &model, sigma_max, levels, opts, &mut residuals);
            let polished_score =
                marginal_score(pairs, &polished, sigma_max, levels, &mut residuals);
            let (lead_score, lead) = if polished_score >= score {
                (polished_score, polished)
            } else {
                (score, model)
            };
            // `residuals` currently holds the *polished* model's
            // residuals; recompute for the leader if the raw hypothesis
            // won (rare).
            if polished_score < score {
                fill_residuals(pairs, &lead, &mut residuals);
            }
            let eps = residuals.iter().filter(|&&r| r < tau_max).count() as f64 / n as f64;
            required = required_iterations(eps, opts.confidence, opts.max_iterations);
            best = Some((lead_score, lead));
        }
    }

    let Some((score, rotation)) = best else {
        return Err(VerifyFailure::NoModel {
            iterations: executed,
        });
    };

    // Final classification: data-driven σ̂ from the sub-τ(σ_max)
    // residuals, threshold 3.5·σ̂ capped at τ(σ_max). See module docs.
    fill_residuals(pairs, &rotation, &mut residuals);
    let mut under_cap: Vec<f64> = residuals.iter().copied().filter(|&r| r < tau_max).collect();
    if under_cap.is_empty() {
        return Err(VerifyFailure::NoModel {
            iterations: executed,
        });
    }
    under_cap.sort_by(f64::total_cmp);
    let median = if under_cap.len() % 2 == 1 {
        under_cap[under_cap.len() / 2]
    } else {
        0.5 * (under_cap[under_cap.len() / 2 - 1] + under_cap[under_cap.len() / 2])
    };
    let sigma_hat = (median / RAYLEIGH_MEDIAN).max(sigma_max * 1e-3);
    let tau_in = (INLIER_SCALE * sigma_hat).min(tau_max);

    let inlier_mask: Vec<bool> = residuals.iter().map(|&r| r < tau_in).collect();
    let inlier_count = inlier_mask.iter().filter(|&&m| m).count();
    if inlier_count == 0 {
        return Err(VerifyFailure::NoModel {
            iterations: executed,
        });
    }
    let mean_residual_rad = residuals
        .iter()
        .zip(&inlier_mask)
        .filter(|(_, &m)| m)
        .map(|(&r, _)| r)
        .sum::<f64>()
        / inlier_count as f64;

    Ok(RotationEstimate {
        rotation,
        inlier_mask,
        inlier_count,
        mean_residual_rad,
        sigma_hat_rad: sigma_hat,
        score,
        iterations: executed,
    })
}

/// Verify one image pair from pixel correspondences: convert to bearings
/// through each camera's intrinsics, run [`estimate_rotation`], and apply
/// the spec §5.2 acceptance gate (`min_inliers`).
///
/// Camera poses are ignored; `sigma_max_px` becomes an angular scale via
/// `σ_rad = σ_px·√(1/f_a² + 1/f_b²)` (pixel noise in *both* frames
/// perturbs the residual; the local distortion rescaling is well below
/// the σ-marginalization's resolution). The returned `inlier_mask` is
/// index-aligned with `matches`.
pub fn verify_pair(
    cam_a: &Camera,
    cam_b: &Camera,
    matches: &[PixelCorrespondence],
    opts: &RobustOptions,
) -> Result<RotationEstimate, VerifyFailure> {
    let floor = opts.min_inliers.max(2);
    if matches.len() < floor {
        return Err(VerifyFailure::TooFewCorrespondences {
            have: matches.len(),
            need: floor,
        });
    }
    let maybe_bearings = bearing_correspondences(cam_a, cam_b, matches);
    let mut pairs = Vec::with_capacity(matches.len());
    let mut original_index = Vec::with_capacity(matches.len());
    for (idx, entry) in maybe_bearings.into_iter().enumerate() {
        if let Some(pair) = entry {
            pairs.push(pair);
            original_index.push(idx);
        }
    }
    if pairs.len() < floor {
        return Err(VerifyFailure::TooFewCorrespondences {
            have: pairs.len(),
            need: floor,
        });
    }

    let sigma_max_rad = opts.sigma_max_px
        * (1.0 / (cam_a.focal_px * cam_a.focal_px) + 1.0 / (cam_b.focal_px * cam_b.focal_px))
            .sqrt();
    let mut estimate = estimate_rotation(&pairs, sigma_max_rad, opts)?;

    if estimate.inlier_count < opts.min_inliers {
        return Err(VerifyFailure::BelowMinInliers {
            inliers: estimate.inlier_count,
            required: opts.min_inliers,
        });
    }
    // Re-align the mask with the caller's correspondence list (entries
    // dropped at bearing conversion stay `false`).
    let mut full_mask = vec![false; matches.len()];
    for (compact, &orig) in original_index.iter().enumerate() {
        full_mask[orig] = estimate.inlier_mask[compact];
    }
    estimate.inlier_mask = full_mask;
    Ok(estimate)
}

fn fill_residuals(pairs: &[(Vec3, Vec3)], model: &Mat3, out: &mut [f64]) {
    for (r, &(a, b)) in out.iter_mut().zip(pairs) {
        *r = angular_residual_rad(model, a, b);
    }
}

/// Discretized σ-marginalized model quality (module docs): mean over
/// `levels` noise scales of the truncated-quadratic inlier gain.
fn marginal_score(
    pairs: &[(Vec3, Vec3)],
    model: &Mat3,
    sigma_max: f64,
    levels: usize,
    residuals: &mut [f64],
) -> f64 {
    fill_residuals(pairs, model, residuals);
    let mut score = 0.0;
    for k in 0..levels {
        let tau = TAU_SCALE * sigma_max * (k + 1) as f64 / levels as f64;
        let inv_tau2 = 1.0 / (tau * tau);
        score += residuals
            .iter()
            .map(|&r| (1.0 - r * r * inv_tau2).max(0.0))
            .sum::<f64>();
    }
    score / levels as f64
}

/// σ-consensus local optimization: iterate {marginalized per-pair
/// weights → weighted closed-form re-solve} to convergence.
fn local_optimize(
    pairs: &[(Vec3, Vec3)],
    start: &Mat3,
    sigma_max: f64,
    levels: usize,
    opts: &RobustOptions,
    residuals: &mut [f64],
) -> Mat3 {
    let mut model = *start;
    let mut weights = vec![0.0_f64; pairs.len()];
    for _ in 0..opts.lo_max_iterations {
        fill_residuals(pairs, &model, residuals);
        for (w, &r) in weights.iter_mut().zip(residuals.iter()) {
            let mut acc = 0.0;
            for k in 0..levels {
                let tau = TAU_SCALE * sigma_max * (k + 1) as f64 / levels as f64;
                acc += (1.0 - (r * r) / (tau * tau)).max(0.0);
            }
            *w = acc / levels as f64;
        }
        let Some(next) = solve_rotation(pairs, Some(&weights)) else {
            break;
        };
        let moved = rotation_angle_between(&model, &next);
        model = next;
        if moved < LO_CONVERGENCE_RAD {
            break;
        }
    }
    model
}

/// `N ≥ ln(1−confidence)/ln(1−ε²)` for 2-point samples, clamped to the
/// caller's budget. ε ≈ 0 keeps the full budget; ε ≈ 1 collapses to ~1
/// (the `min_iterations` floor still applies at the call site).
fn required_iterations(eps: f64, confidence: f64, max: usize) -> usize {
    let eps = eps.clamp(0.0, 1.0);
    let p_good = eps * eps;
    if p_good <= f64::MIN_POSITIVE {
        return max;
    }
    if p_good >= 1.0 - 1e-12 {
        return 1;
    }
    let n = (1.0 - confidence.clamp(0.5, 1.0 - 1e-12)).ln() / (1.0 - p_good).ln();
    if !n.is_finite() {
        return max;
    }
    (n.ceil() as usize).clamp(1, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::axis_angle_to_matrix;

    /// Bearings in a ~25°-radius cap around +Z in frame A, mapped through
    /// a ground-truth rotation into frame B, with optional angular noise
    /// and a controlled fraction of outliers (random cap directions).
    fn synthetic_pairs(
        r_gt: &Mat3,
        n: usize,
        noise_rad: f64,
        outlier_fraction: f64,
        seed: u64,
    ) -> (Vec<(Vec3, Vec3)>, Vec<bool>) {
        let mut rng = SplitMix64::new(seed);
        let cap_dir = |rng: &mut SplitMix64| {
            // Uniform-ish direction within ~25° of +Z.
            let x = rng.next_range(-0.45, 0.45);
            let y = rng.next_range(-0.45, 0.45);
            Vec3::new(x, y, 1.0).normalized().unwrap()
        };
        let perturb = |rng: &mut SplitMix64, v: Vec3, amount: f64| {
            if amount <= 0.0 {
                return v;
            }
            let t = rng.next_unit_vector();
            let tangent = t - v.scale(t.dot(v));
            match tangent.normalized() {
                Some(t) => {
                    let ang = amount * rng.next_range(0.0, 2.0);
                    (v.scale(ang.cos()) + t.scale(ang.sin()))
                        .normalized()
                        .unwrap()
                }
                None => v,
            }
        };
        let n_out = ((n as f64) * outlier_fraction).round() as usize;
        let mut pairs = Vec::with_capacity(n);
        let mut genuine = Vec::with_capacity(n);
        for i in 0..n {
            let a = cap_dir(&mut rng);
            let outlier = i < n_out;
            let b = if outlier {
                cap_dir(&mut rng)
            } else {
                perturb(&mut rng, r_gt.mul_vec(a), noise_rad)
            };
            pairs.push((perturb(&mut rng, a, noise_rad), b));
            genuine.push(!outlier);
        }
        (pairs, genuine)
    }

    #[test]
    fn clean_pairs_recover_exactly_with_full_support() {
        let r_gt = axis_angle_to_matrix([0.1, 0.6, -0.05]);
        let (pairs, _) = synthetic_pairs(&r_gt, 80, 0.0, 0.0, 3);
        let est = estimate_rotation(&pairs, 0.005, &RobustOptions::default()).unwrap();
        assert!(rotation_angle_between(&est.rotation, &r_gt) < 1e-9);
        assert_eq!(est.inlier_count, 80);
        assert!(est.mean_residual_rad < 1e-9);
    }

    #[test]
    fn survives_sixty_percent_outliers() {
        let r_gt = axis_angle_to_matrix([-0.3, 0.4, 0.2]);
        let (pairs, genuine) = synthetic_pairs(&r_gt, 200, 0.0015, 0.6, 9);
        let est = estimate_rotation(&pairs, 0.005, &RobustOptions::default()).unwrap();
        assert!(
            rotation_angle_between(&est.rotation, &r_gt) < 0.005,
            "rotation error {} rad",
            rotation_angle_between(&est.rotation, &r_gt)
        );
        // Every claimed inlier should be genuine at this noise level.
        let false_pos = est
            .inlier_mask
            .iter()
            .zip(&genuine)
            .filter(|(&m, &g)| m && !g)
            .count();
        assert!(false_pos <= 2, "{false_pos} outliers classified as inliers");
        assert!(est.inlier_count >= 70);
    }

    #[test]
    fn pure_junk_yields_too_little_support() {
        // a/b unrelated: hypotheses exist, but no model gathers ≥ 30
        // inliers, so the verify-style acceptance must fail.
        let r_gt = axis_angle_to_matrix([0.0, 0.5, 0.0]);
        let (pairs, _) = synthetic_pairs(&r_gt, 200, 0.0, 1.0, 21);
        let est = estimate_rotation(&pairs, 0.005, &RobustOptions::default()).unwrap();
        assert!(
            est.inlier_count < 30,
            "random pairs produced {} inliers",
            est.inlier_count
        );
    }

    #[test]
    fn too_few_pairs_is_reported() {
        let a = Vec3::new(0.0, 0.0, 1.0);
        assert_eq!(
            estimate_rotation(&[(a, a)], 0.005, &RobustOptions::default()),
            Err(VerifyFailure::TooFewCorrespondences { have: 1, need: 2 })
        );
    }

    #[test]
    fn same_seed_is_bit_identical_and_seed_changes_sampling() {
        let r_gt = axis_angle_to_matrix([0.2, -0.5, 0.1]);
        let (pairs, _) = synthetic_pairs(&r_gt, 150, 0.0015, 0.3, 13);
        let opts = RobustOptions::default();
        let e1 = estimate_rotation(&pairs, 0.005, &opts).unwrap();
        let e2 = estimate_rotation(&pairs, 0.005, &opts).unwrap();
        assert_eq!(e1, e2, "same seed must be bit-identical");

        let other = RobustOptions {
            seed: 999,
            ..RobustOptions::default()
        };
        let e3 = estimate_rotation(&pairs, 0.005, &other).unwrap();
        // Different seed still converges to the same answer within noise.
        assert!(rotation_angle_between(&e1.rotation, &e3.rotation) < 0.002);
    }

    #[test]
    fn required_iterations_bounds() {
        assert_eq!(required_iterations(0.0, 0.9999, 500), 500);
        assert_eq!(required_iterations(1.0, 0.9999, 500), 1);
        let n_half = required_iterations(0.5, 0.9999, 10_000);
        // ln(1e-4)/ln(0.75) ≈ 32.
        assert!((30..=35).contains(&n_half), "got {n_half}");
    }
}
