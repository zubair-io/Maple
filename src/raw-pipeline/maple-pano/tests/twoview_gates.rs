//! M1a acceptance gates (#1138) — two-view estimation accuracy, inlier
//! classification quality, and determinism, on synthetic ground truth
//! from the M0a camera math + the `testkit` correspondence generator
//! (no fixtures, no network).
//!
//! Gates (ticket #1138):
//! - Pairwise R recovered within 0.05° on clean correspondences and
//!   within 0.3° at σ = 1 px noise + 30 % outliers, across rectilinear
//!   cameras with and without k1/k2.
//! - Inlier classification at σ = 1 px + 30 % outliers: precision ≥ 0.95
//!   and recall ≥ 0.95 against the testkit's ground-truth labels.
//! - Determinism: same seed ⇒ bit-identical estimator output.

use maple_pano::camera::Camera;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, CameraSetOptions, Pattern};
use maple_pano::robust::{verify_pair, RobustOptions, RotationEstimate};
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions, SyntheticMatches};
use maple_pano::twoview::{relative_rotation_ground_truth, rotation_angle_between};

/// Distortion variants every gate must cover: ideal rectilinear and a
/// drone-like barrel profile.
const K_VARIANTS: [(f64, f64); 2] = [(0.0, 0.0), (-0.06, 0.025)];
const RIG_SEEDS: [u64; 3] = [1, 2, 3];

/// Two overlapping cameras from the M0a camera-set builder: 60° FOV,
/// 50 % overlap, pitched and jittered so the poses are generic.
fn rig(k1: f64, k2: f64, seed: u64) -> (Camera, Camera) {
    let opts = CameraSetOptions {
        count: 2,
        pattern: Pattern::Ring { full: false },
        fov_deg: 60.0,
        overlap: 0.5,
        pitch_deg: 8.0,
        jitter_deg: 1.0,
        k1,
        k2,
        width: 960,
        height: 720,
    };
    let cams = build_camera_set(&opts, &mut SplitMix64::new(seed)).expect("valid options");
    (cams[0].to_camera(), cams[1].to_camera())
}

fn noisy_opts() -> CorrespondenceOptions {
    CorrespondenceOptions {
        count: 400,
        noise_sigma_px: 1.0,
        outlier_fraction: 0.3,
        ..Default::default()
    }
}

fn generate(
    cam_a: &Camera,
    cam_b: &Camera,
    opts: &CorrespondenceOptions,
    seed: u64,
) -> SyntheticMatches {
    let set = generate_pair_correspondences(cam_a, cam_b, opts, &mut SplitMix64::new(seed));
    assert!(
        set.len() == opts.count,
        "overlap too small: generated {} of {} requested correspondences",
        set.len(),
        opts.count
    );
    set
}

fn estimate(cam_a: &Camera, cam_b: &Camera, set: &SyntheticMatches) -> RotationEstimate {
    verify_pair(cam_a, cam_b, &set.pixel_pairs(), &RobustOptions::default())
        .expect("pair must verify")
}

fn rotation_error_deg(cam_a: &Camera, cam_b: &Camera, est: &RotationEstimate) -> f64 {
    rotation_angle_between(&est.rotation, &relative_rotation_ground_truth(cam_a, cam_b))
        .to_degrees()
}

#[test]
fn gate_clean_rotation_within_0_05_deg() {
    let mut worst = 0.0_f64;
    for (k1, k2) in K_VARIANTS {
        for seed in RIG_SEEDS {
            let (cam_a, cam_b) = rig(k1, k2, seed);
            let set = generate(
                &cam_a,
                &cam_b,
                &CorrespondenceOptions {
                    count: 200,
                    ..Default::default()
                },
                seed ^ 0xA5A5,
            );
            let est = estimate(&cam_a, &cam_b, &set);
            let err = rotation_error_deg(&cam_a, &cam_b, &est);
            eprintln!(
                "gate(clean) k=({k1},{k2}) seed={seed}: err={err:.3e}° inliers={}/{}",
                est.inlier_count,
                set.len()
            );
            assert!(err <= 0.05, "clean rotation error {err}° > 0.05°");
            assert_eq!(est.inlier_count, set.len(), "clean data must be all-inlier");
            worst = worst.max(err);
        }
    }
    eprintln!("gate(clean): worst rotation error {worst:.3e}° (budget 0.05°)");
}

#[test]
fn gate_noisy_rotation_within_0_3_deg() {
    let mut worst = 0.0_f64;
    for (k1, k2) in K_VARIANTS {
        for seed in RIG_SEEDS {
            let (cam_a, cam_b) = rig(k1, k2, seed);
            let set = generate(&cam_a, &cam_b, &noisy_opts(), seed ^ 0x5A5A);
            let est = estimate(&cam_a, &cam_b, &set);
            let err = rotation_error_deg(&cam_a, &cam_b, &est);
            eprintln!(
                "gate(noisy σ=1px,30% outliers) k=({k1},{k2}) seed={seed}: err={err:.5}° \
                 inliers={} σ̂={:.5}° iters={}",
                est.inlier_count,
                est.sigma_hat_rad.to_degrees(),
                est.iterations
            );
            assert!(err <= 0.3, "noisy rotation error {err}° > 0.3°");
            worst = worst.max(err);
        }
    }
    eprintln!("gate(noisy): worst rotation error {worst:.5}° (budget 0.3°)");
}

#[test]
fn gate_inlier_classification_precision_and_recall() {
    let (mut min_precision, mut min_recall) = (1.0_f64, 1.0_f64);
    for (k1, k2) in K_VARIANTS {
        for seed in RIG_SEEDS {
            let (cam_a, cam_b) = rig(k1, k2, seed);
            let set = generate(&cam_a, &cam_b, &noisy_opts(), seed ^ 0x5A5A);
            let est = estimate(&cam_a, &cam_b, &set);

            let labels = set.inlier_labels();
            let (mut tp, mut fp, mut fn_) = (0_usize, 0_usize, 0_usize);
            for (&predicted, &genuine) in est.inlier_mask.iter().zip(&labels) {
                match (predicted, genuine) {
                    (true, true) => tp += 1,
                    (true, false) => fp += 1,
                    (false, true) => fn_ += 1,
                    (false, false) => {}
                }
            }
            let precision = tp as f64 / (tp + fp) as f64;
            let recall = tp as f64 / (tp + fn_) as f64;
            eprintln!(
                "gate(classification) k=({k1},{k2}) seed={seed}: precision={precision:.4} \
                 recall={recall:.4} (tp={tp} fp={fp} fn={fn_})"
            );
            assert!(precision >= 0.95, "precision {precision} < 0.95");
            assert!(recall >= 0.95, "recall {recall} < 0.95");
            min_precision = min_precision.min(precision);
            min_recall = min_recall.min(recall);
        }
    }
    eprintln!(
        "gate(classification): min precision {min_precision:.4}, min recall {min_recall:.4} \
         (budget ≥ 0.95 each)"
    );
}

#[test]
fn gate_determinism_same_seed_bit_identical() {
    let (cam_a, cam_b) = rig(-0.06, 0.025, 4);
    let set = generate(&cam_a, &cam_b, &noisy_opts(), 0xD00D);
    let pairs = set.pixel_pairs();
    let opts = RobustOptions::default();
    let e1 = verify_pair(&cam_a, &cam_b, &pairs, &opts).expect("verifies");
    let e2 = verify_pair(&cam_a, &cam_b, &pairs, &opts).expect("verifies");
    assert_eq!(e1, e2, "same seed must produce bit-identical estimates");

    // A different seed samples differently but lands on the same answer
    // within the noisy-gate budget — and may differ in bits.
    let e3 = verify_pair(
        &cam_a,
        &cam_b,
        &pairs,
        &RobustOptions {
            seed: 1234,
            ..RobustOptions::default()
        },
    )
    .expect("verifies");
    assert!(rotation_angle_between(&e1.rotation, &e3.rotation).to_degrees() < 0.3);
}
