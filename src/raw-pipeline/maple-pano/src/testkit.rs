//! Synthetic correspondence generation from ground-truth cameras
//! (cargo feature `testkit`).
//!
//! Feeds the M1 geometry gates and is the designated input source for
//! the BA milestone's gates: it produces pixel correspondences with
//! exactly known provenance — the true world direction, the noiseless
//! projections in both frames, per-item inlier/outlier labels — so
//! estimator accuracy, precision/recall, and reprojection error can all
//! be measured against ground truth without fixtures.
//!
//! # Generation model (conventions)
//!
//! 1. **Support sampling.** Pixels are drawn uniformly over camera A's
//!    frame (inside `margin_px`), back-projected to world directions
//!    through A's *true* pose, and kept iff the projection into camera B
//!    lands in-frame (same margin) — i.e. the support is uniform over
//!    A's view of the overlap, like real detections, not uniform on the
//!    sphere. Generation stops at `count` correspondences or after
//!    `count × max_attempt_factor` draws (small/empty overlaps yield
//!    short or empty outputs — never an error).
//! 2. **Noise.** `noise_sigma_px` is the 1-σ Gaussian noise added
//!    independently to each pixel axis in **both** frames
//!    (Box–Muller over [`SplitMix64`]). Noise may push a pixel slightly
//!    outside the frame; bearings extrapolate fine
//!    ([`crate::camera::Camera::pixel_to_camera_dir`]).
//! 3. **Outliers.** A `round(count × outlier_fraction)`-sized random
//!    subset is converted to outliers: the frame-B pixel is replaced by
//!    a uniform random in-frame pixel at least `min_outlier_error_px`
//!    away from the true projection (so labels are unambiguous at any
//!    sane verification threshold — a "random wrong pair" can never
//!    accidentally be correct). The frame-A pixel keeps its noisy value:
//!    a mismatch pairs a real feature in A with a wrong feature in B.
//! 4. **Determinism.** All randomness comes from the caller's
//!    [`SplitMix64`]; same cameras + options + rng state ⇒ identical
//!    output, forever.
//!
//! The pose used for generation is the cameras' ground-truth rotation
//! (e.g. from [`crate::gt::CameraGt::to_camera`]); consumers under test
//! must of course not look at it.

use crate::camera::Camera;
use crate::math::Vec3;
use crate::prng::SplitMix64;
use crate::twoview::PixelCorrespondence;

/// Options for [`generate_pair_correspondences`].
#[derive(Debug, Clone)]
pub struct CorrespondenceOptions {
    /// Target number of correspondences (fewer if the overlap is small).
    pub count: usize,
    /// 1-σ Gaussian pixel noise per axis, both frames. 0 = exact.
    pub noise_sigma_px: f64,
    /// Fraction of the generated set converted to outliers, `[0, 1]`.
    pub outlier_fraction: f64,
    /// Keep-away distance from every frame edge when sampling supports
    /// and outlier pixels.
    pub margin_px: f64,
    /// Minimum distance (pixels) between an outlier's frame-B pixel and
    /// the true projection. Guaranteed whenever the frame can admit a
    /// pixel that far away; on a degenerate frame too small for the
    /// floor, the farthest of 1024 uniform draws is used instead (see
    /// `plant_outlier_pixel`) so generation always terminates.
    pub min_outlier_error_px: f64,
    /// Sampling budget multiplier: at most `count × max_attempt_factor`
    /// support draws.
    pub max_attempt_factor: usize,
}

impl Default for CorrespondenceOptions {
    fn default() -> Self {
        Self {
            count: 300,
            noise_sigma_px: 0.0,
            outlier_fraction: 0.0,
            margin_px: 2.0,
            min_outlier_error_px: 20.0,
            max_attempt_factor: 64,
        }
    }
}

/// One synthetic correspondence with full ground-truth provenance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SyntheticCorrespondence {
    /// Observed (noisy) pixel in frame A.
    pub pixel_a: (f64, f64),
    /// Observed pixel in frame B — noisy projection, or the planted
    /// wrong pixel when `is_outlier`.
    pub pixel_b: (f64, f64),
    /// Noiseless projection in frame A (the sampled support).
    pub true_pixel_a: (f64, f64),
    /// Noiseless projection of `world_dir` into frame B.
    pub true_pixel_b: (f64, f64),
    /// Ground-truth unit world direction of the support.
    pub world_dir: Vec3,
    pub is_outlier: bool,
}

/// A generated correspondence set for one image pair.
#[derive(Debug, Clone, PartialEq)]
pub struct SyntheticMatches {
    pub correspondences: Vec<SyntheticCorrespondence>,
}

impl SyntheticMatches {
    /// The observed pixel pairs, as the geometry stack consumes them.
    pub fn pixel_pairs(&self) -> Vec<PixelCorrespondence> {
        self.correspondences
            .iter()
            .map(|c| PixelCorrespondence {
                a: c.pixel_a,
                b: c.pixel_b,
            })
            .collect()
    }

    /// Ground-truth labels, index-aligned with [`Self::pixel_pairs`]:
    /// `true` = genuine correspondence (the precision/recall reference).
    pub fn inlier_labels(&self) -> Vec<bool> {
        self.correspondences.iter().map(|c| !c.is_outlier).collect()
    }

    pub fn len(&self) -> usize {
        self.correspondences.len()
    }

    pub fn is_empty(&self) -> bool {
        self.correspondences.is_empty()
    }
}

/// Standard-normal sample via Box–Muller (cosine branch only — two
/// uniform draws per Gaussian, fixed stream cost). Public for reuse by
/// later milestones' synthetic perturbations.
pub fn gaussian(rng: &mut SplitMix64) -> f64 {
    let u1 = 1.0 - rng.next_f64(); // (0, 1] — keeps ln() finite.
    let u2 = rng.next_f64();
    (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

/// A sampled support before observation: `(true_pixel_a, true_pixel_b,
/// world_dir)`.
type Support = ((f64, f64), (f64, f64), Vec3);

/// Generate synthetic correspondences between two ground-truth cameras
/// per the module-doc model.
///
/// Panics if either frame is too small for `margin_px` (testkit misuse,
/// not a runtime condition).
pub fn generate_pair_correspondences(
    cam_a: &Camera,
    cam_b: &Camera,
    opts: &CorrespondenceOptions,
    rng: &mut SplitMix64,
) -> SyntheticMatches {
    for cam in [cam_a, cam_b] {
        assert!(
            2.0 * opts.margin_px < cam.width as f64 && 2.0 * opts.margin_px < cam.height as f64,
            "margin_px {} leaves no sampling area in a {}x{} frame",
            opts.margin_px,
            cam.width,
            cam.height
        );
    }

    // Phase 1: noiseless supports in the overlap.
    let budget = opts.count.saturating_mul(opts.max_attempt_factor.max(1));
    let mut base: Vec<Support> = Vec::with_capacity(opts.count);
    let mut attempts = 0_usize;
    while base.len() < opts.count && attempts < budget {
        attempts += 1;
        let px = rng.next_range(opts.margin_px, cam_a.width as f64 - opts.margin_px);
        let py = rng.next_range(opts.margin_px, cam_a.height as f64 - opts.margin_px);
        let Some(dir) = cam_a.pixel_to_world_dir(px, py) else {
            continue;
        };
        let Some((qx, qy)) = cam_b.world_dir_to_pixel(dir) else {
            continue;
        };
        if !cam_b.pixel_in_bounds(qx, qy, opts.margin_px) {
            continue;
        }
        base.push(((px, py), (qx, qy), dir));
    }

    // Phase 2: pick the outlier subset (partial Fisher–Yates).
    let n = base.len();
    let n_out = ((n as f64) * opts.outlier_fraction.clamp(0.0, 1.0)).round() as usize;
    let n_out = n_out.min(n);
    let mut order: Vec<usize> = (0..n).collect();
    for k in 0..n_out {
        let pick = k + (rng.next_u64() % (n - k) as u64) as usize;
        order.swap(k, pick);
    }
    let mut is_outlier = vec![false; n];
    for &i in &order[..n_out] {
        is_outlier[i] = true;
    }

    // Phase 3: observation noise + outlier planting, in support order.
    let correspondences = base
        .iter()
        .enumerate()
        .map(|(i, &(true_a, true_b, world_dir))| {
            let pixel_a = (
                true_a.0 + opts.noise_sigma_px * gaussian(rng),
                true_a.1 + opts.noise_sigma_px * gaussian(rng),
            );
            let pixel_b = if is_outlier[i] {
                plant_outlier_pixel(cam_b, true_b, opts, rng)
            } else {
                (
                    true_b.0 + opts.noise_sigma_px * gaussian(rng),
                    true_b.1 + opts.noise_sigma_px * gaussian(rng),
                )
            };
            SyntheticCorrespondence {
                pixel_a,
                pixel_b,
                true_pixel_a: true_a,
                true_pixel_b: true_b,
                world_dir,
                is_outlier: is_outlier[i],
            }
        })
        .collect();
    SyntheticMatches { correspondences }
}

/// Uniform random in-frame pixel at least `min_outlier_error_px` from the
/// true projection. If the frame is too small to ever satisfy the floor,
/// the farthest draw seen wins (terminates regardless).
fn plant_outlier_pixel(
    cam_b: &Camera,
    true_b: (f64, f64),
    opts: &CorrespondenceOptions,
    rng: &mut SplitMix64,
) -> (f64, f64) {
    let min_d2 = opts.min_outlier_error_px * opts.min_outlier_error_px;
    let mut best = ((0.0, 0.0), -1.0_f64);
    for _ in 0..1024 {
        let cand = (
            rng.next_range(opts.margin_px, cam_b.width as f64 - opts.margin_px),
            rng.next_range(opts.margin_px, cam_b.height as f64 - opts.margin_px),
        );
        let d2 = (cand.0 - true_b.0).powi(2) + (cand.1 - true_b.1).powi(2);
        if d2 >= min_d2 {
            return cand;
        }
        if d2 > best.1 {
            best = (cand, d2);
        }
    }
    best.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::matrix_to_axis_angle;
    use crate::math::Mat3;

    fn rig() -> (Camera, Camera) {
        let f = crate::camera::focal_px_for_hfov(60.0, 960);
        let a = Camera::new([0.0; 3], f, -0.05, 0.01, 960, 720);
        let r_b = Mat3::rotation_y(30.0_f64.to_radians());
        let b = Camera::new(matrix_to_axis_angle(&r_b), f, -0.05, 0.01, 960, 720);
        (a, b)
    }

    #[test]
    fn noiseless_correspondences_are_exact_and_consistent() {
        let (cam_a, cam_b) = rig();
        let opts = CorrespondenceOptions {
            count: 120,
            ..Default::default()
        };
        let set = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(42));
        assert_eq!(set.len(), 120);
        for c in &set.correspondences {
            assert!(!c.is_outlier);
            assert_eq!(c.pixel_a, c.true_pixel_a);
            assert_eq!(c.pixel_b, c.true_pixel_b);
            // The recorded world direction reproduces both projections.
            let (qx, qy) = cam_b.world_dir_to_pixel(c.world_dir).unwrap();
            assert!((qx - c.true_pixel_b.0).abs() < 1e-9);
            assert!((qy - c.true_pixel_b.1).abs() < 1e-9);
            let d = cam_a
                .pixel_to_world_dir(c.true_pixel_a.0, c.true_pixel_a.1)
                .unwrap();
            assert!((d - c.world_dir).norm() < 1e-12);
            assert!(cam_b.pixel_in_bounds(c.true_pixel_b.0, c.true_pixel_b.1, opts.margin_px));
        }
    }

    #[test]
    fn outlier_count_and_distance_floor_hold() {
        let (cam_a, cam_b) = rig();
        let opts = CorrespondenceOptions {
            count: 200,
            noise_sigma_px: 1.0,
            outlier_fraction: 0.3,
            ..Default::default()
        };
        let set = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(7));
        assert_eq!(set.len(), 200);
        let n_out = set.correspondences.iter().filter(|c| c.is_outlier).count();
        assert_eq!(n_out, 60);
        assert_eq!(
            set.inlier_labels().iter().filter(|&&l| l).count(),
            140,
            "labels must mirror is_outlier"
        );
        for c in set.correspondences.iter().filter(|c| c.is_outlier) {
            let d = ((c.pixel_b.0 - c.true_pixel_b.0).powi(2)
                + (c.pixel_b.1 - c.true_pixel_b.1).powi(2))
            .sqrt();
            assert!(
                d >= opts.min_outlier_error_px,
                "outlier only {d:.2} px from the truth"
            );
        }
    }

    #[test]
    fn noise_statistics_match_sigma() {
        let (cam_a, cam_b) = rig();
        let opts = CorrespondenceOptions {
            count: 4000,
            noise_sigma_px: 1.5,
            ..Default::default()
        };
        let set = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(99));
        let mut sum_sq = 0.0;
        let mut n = 0usize;
        for c in &set.correspondences {
            for d in [
                c.pixel_a.0 - c.true_pixel_a.0,
                c.pixel_a.1 - c.true_pixel_a.1,
                c.pixel_b.0 - c.true_pixel_b.0,
                c.pixel_b.1 - c.true_pixel_b.1,
            ] {
                sum_sq += d * d;
                n += 1;
            }
        }
        let sigma = (sum_sq / n as f64).sqrt();
        assert!(
            (sigma - 1.5).abs() < 0.15,
            "sample σ {sigma:.3} vs requested 1.5"
        );
    }

    #[test]
    fn same_rng_state_reproduces_the_set() {
        let (cam_a, cam_b) = rig();
        let opts = CorrespondenceOptions {
            count: 64,
            noise_sigma_px: 0.7,
            outlier_fraction: 0.25,
            ..Default::default()
        };
        let s1 = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(5));
        let s2 = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(5));
        assert_eq!(s1, s2);
        let s3 = generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut SplitMix64::new(6));
        assert_ne!(s1, s3, "different seed must change the set");
    }

    #[test]
    fn disjoint_views_yield_empty_set() {
        let f = crate::camera::focal_px_for_hfov(50.0, 640);
        let a = Camera::new([0.0; 3], f, 0.0, 0.0, 640, 480);
        let r_b = Mat3::rotation_y(140.0_f64.to_radians());
        let b = Camera::new(matrix_to_axis_angle(&r_b), f, 0.0, 0.0, 640, 480);
        let set = generate_pair_correspondences(
            &a,
            &b,
            &CorrespondenceOptions {
                count: 50,
                ..Default::default()
            },
            &mut SplitMix64::new(1),
        );
        assert!(set.is_empty());
    }

    #[test]
    fn gaussian_moments_are_sane() {
        let mut rng = SplitMix64::new(2024);
        let n = 20_000;
        let (mut sum, mut sum_sq) = (0.0, 0.0);
        for _ in 0..n {
            let g = gaussian(&mut rng);
            sum += g;
            sum_sq += g * g;
        }
        let mean = sum / n as f64;
        let var = sum_sq / n as f64 - mean * mean;
        assert!(mean.abs() < 0.03, "mean {mean}");
        assert!((var - 1.0).abs() < 0.05, "variance {var}");
    }
}
