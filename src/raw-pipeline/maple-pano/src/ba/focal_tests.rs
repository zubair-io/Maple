//! Unit tests for `ba/focal.rs`, split out to respect the file-size
//! budget (CONTRIBUTING.md § File-size budget).
//!
//! Ticket #1214's acceptance gate: "synthetic no-EXIF set (strip
//! priors) recovers focal within 5% at seed" — [`strip_of_five_recovers_shared_focal_within_5_percent`]
//! is that gate, expressed directly against [`homography_focal_seed_px`]
//! rather than through the full `stitch()` pipeline (which additionally
//! needs ONNX models — out of reach for a unit test).

use super::*;
use crate::camera::{focal_px_for_hfov, Camera};
use crate::graph::{MatchGraph, VerifiedEdge};
use crate::math::{matrix_to_axis_angle, Mat3};
use crate::prng::SplitMix64;
use crate::testkit::{generate_pair_correspondences, CorrespondenceOptions};

/// A synthetic pure-rotation camera: yaw `yaw_deg` about the shared
/// world origin, common `focal_px`, square-ish frame.
fn camera_at(yaw_deg: f64, focal_px: f64) -> Camera {
    let r = Mat3::rotation_y(yaw_deg.to_radians());
    Camera::new(matrix_to_axis_angle(&r), focal_px, 0.0, 0.0, 1600, 1200)
}

fn dummy_edge(
    a: usize,
    b: usize,
    matches: Vec<crate::twoview::PixelCorrespondence>,
) -> VerifiedEdge {
    VerifiedEdge {
        a,
        b,
        rotation: Mat3::identity(),
        inlier_count: matches.len(),
        mean_residual_rad: 0.0,
        inlier_matches: matches,
    }
}

#[test]
fn too_few_matches_yields_none() {
    let matches = vec![crate::twoview::PixelCorrespondence {
        a: (10.0, 10.0),
        b: (12.0, 11.0),
    }];
    assert!(focal_from_pair_homography(&matches, (1600, 1200), (1600, 1200)).is_none());
}

#[test]
fn pure_rotation_pair_recovers_focal_within_5_percent() {
    let true_focal = 2200.0;
    let cam_a = camera_at(0.0, true_focal);
    let cam_b = camera_at(18.0, true_focal);
    let mut rng = SplitMix64::new(0xF0CA1);
    let synth = generate_pair_correspondences(
        &cam_a,
        &cam_b,
        &CorrespondenceOptions {
            count: 200,
            noise_sigma_px: 0.0,
            outlier_fraction: 0.0,
            ..CorrespondenceOptions::default()
        },
        &mut rng,
    );
    let matches = synth.pixel_pairs();
    assert!(matches.len() >= 100, "overlap too small: {}", matches.len());

    let f = focal_from_pair_homography(&matches, (1600, 1200), (1600, 1200))
        .expect("pure rotation pair yields a homography focal estimate");
    let rel_err = (f - true_focal).abs() / true_focal;
    assert!(
        rel_err < 0.05,
        "recovered focal {f} vs true {true_focal} — {:.2}% off",
        rel_err * 100.0
    );
}

#[test]
fn small_pixel_noise_still_recovers_focal_within_5_percent() {
    let true_focal = 1850.0;
    let cam_a = camera_at(-10.0, true_focal);
    let cam_b = camera_at(12.0, true_focal);
    let mut rng = SplitMix64::new(0xF0CA2);
    let synth = generate_pair_correspondences(
        &cam_a,
        &cam_b,
        &CorrespondenceOptions {
            count: 300,
            noise_sigma_px: 0.3,
            outlier_fraction: 0.0,
            ..CorrespondenceOptions::default()
        },
        &mut rng,
    );
    let matches = synth.pixel_pairs();

    let f = focal_from_pair_homography(&matches, (1600, 1200), (1600, 1200))
        .expect("noisy pure-rotation pair still yields an estimate");
    let rel_err = (f - true_focal).abs() / true_focal;
    assert!(
        rel_err < 0.05,
        "recovered focal {f} vs true {true_focal} — {:.2}% off",
        rel_err * 100.0
    );
}

/// Ticket #1214's acceptance gate: a synthetic no-EXIF strip (5 frames,
/// consecutive-pair chain, like a handheld sweep with no camera priors)
/// recovers the shared focal within 5% from `homography_focal_seed_px`
/// alone.
#[test]
fn strip_of_five_recovers_shared_focal_within_5_percent() {
    let true_focal = 2400.0;
    let yaws = [-30.0, -15.0, 0.0, 15.0, 30.0];
    let cams: Vec<Camera> = yaws.iter().map(|&y| camera_at(y, true_focal)).collect();
    let dims: Vec<(u32, u32)> = cams.iter().map(|c| (c.width, c.height)).collect();

    let mut rng = SplitMix64::new(0xF0CA3);
    let mut edges = Vec::new();
    for i in 0..cams.len() - 1 {
        let synth = generate_pair_correspondences(
            &cams[i],
            &cams[i + 1],
            &CorrespondenceOptions {
                count: 150,
                noise_sigma_px: 0.2,
                outlier_fraction: 0.0,
                ..CorrespondenceOptions::default()
            },
            &mut rng,
        );
        edges.push(dummy_edge(i, i + 1, synth.pixel_pairs()));
    }

    let graph = MatchGraph {
        image_count: cams.len(),
        edges,
        rejected: vec![],
        components: vec![(0..cams.len()).collect()],
        orphans: vec![],
    };

    let seed =
        homography_focal_seed_px(&graph, &dims).expect("a 4-edge chain yields a shared-focal seed");
    let rel_err = (seed - true_focal).abs() / true_focal;
    assert!(
        rel_err < 0.05,
        "seed {seed} vs true {true_focal} — {:.2}% off",
        rel_err * 100.0
    );
}

#[test]
fn homography_focal_seed_px_is_none_for_an_edgeless_graph() {
    let graph = MatchGraph {
        image_count: 3,
        edges: vec![],
        rejected: vec![],
        components: vec![vec![0], vec![1], vec![2]],
        orphans: vec![],
    };
    assert!(homography_focal_seed_px(&graph, &[(100, 100), (100, 100), (100, 100)]).is_none());
}

#[test]
fn degenerate_coincident_points_yield_no_estimate() {
    // Every correspondence at the same pixel in both frames: no scale is
    // recoverable, `normalize` must reject it rather than divide by ~0.
    let matches: Vec<crate::twoview::PixelCorrespondence> = (0..6)
        .map(|_| crate::twoview::PixelCorrespondence {
            a: (800.0, 600.0),
            b: (800.0, 600.0),
        })
        .collect();
    assert!(focal_from_pair_homography(&matches, (1600, 1200), (1600, 1200)).is_none());
}

#[test]
fn focal_px_for_hfov_sanity_matches_pinhole_formula() {
    // Cross-check the test helper itself against the pinhole relation
    // f = (width/2) / tan(hfov/2), so a wrong assumption in these tests
    // doesn't silently pass.
    let f = focal_px_for_hfov(60.0, 1600);
    let expected = 800.0 / (30.0_f64.to_radians()).tan();
    assert!((f - expected).abs() < 1e-6);
}
