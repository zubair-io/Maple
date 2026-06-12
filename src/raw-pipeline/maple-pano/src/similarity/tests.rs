//! Unit tests for [`super`] — split from `similarity.rs` for the
//! file-size budget (#1226).

use super::*;
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
