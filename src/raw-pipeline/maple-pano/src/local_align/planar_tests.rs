use super::*;
use crate::similarity::{Similarity2d, SimilarityEstimate};
use crate::tile::{TileEdge, TilePose};
use crate::twoview::PixelCorrespondence;

const W: f64 = 3000.0;
const H: f64 = 2000.0;
const FLIGHT_HEIGHT: f64 = 1.0;

/// Nadir camera centres on the ground plane, 2 rows × 3 columns with
/// ~40% side and forward overlap.
fn centres() -> Vec<(f64, f64)> {
    (0..2)
        .flat_map(|row| (0..3).map(move |col| (col as f64 * 1800.0, row as f64 * 1200.0)))
        .collect()
}

/// Ground-plane placement: the pose a rigid planar solve converges to
/// when the scene has no relief.
fn ground_poses(centres: &[(f64, f64)]) -> Vec<TilePose> {
    centres
        .iter()
        .enumerate()
        .map(|(i, &(cx, cy))| TilePose {
            sim: Similarity2d {
                scale: 1.0,
                theta: 0.0,
                tx: cx - W / 2.0,
                ty: cy - H / 2.0,
            },
            frame_idx: i,
        })
        .collect()
}

/// Pinhole nadir projection of a ground point with height `relief(p)`:
/// relief magnifies its offset from the camera's nadir by `Z / (Z − h)`.
fn project(centre: (f64, f64), p: (f64, f64), relief: &dyn Fn((f64, f64)) -> f64) -> (f64, f64) {
    let k = FLIGHT_HEIGHT / (FLIGHT_HEIGHT - relief(p));
    (
        (p.0 - centre.0) * k + W / 2.0,
        (p.1 - centre.1) * k + H / 2.0,
    )
}

fn inside(p: (f64, f64)) -> bool {
    p.0 > 0.0 && p.0 < W && p.1 > 0.0 && p.1 < H
}

fn edges_over(centres: &[(f64, f64)], relief: &dyn Fn((f64, f64)) -> f64) -> Vec<TileEdge> {
    let n = centres.len();
    (0..n)
        .flat_map(|a| ((a + 1)..n).map(move |b| (a, b)))
        .filter_map(|(a, b)| {
            let matches: Vec<PixelCorrespondence> = (0..120)
                .flat_map(|gy| {
                    (0..120).map(move |gx| (gx as f64 * 40.0 - 1500.0, gy as f64 * 40.0 - 1000.0))
                })
                .map(|p| {
                    (
                        project(centres[a], p, relief),
                        project(centres[b], p, relief),
                    )
                })
                .filter(|&(pa, pb)| inside(pa) && inside(pb))
                .map(|(pa, pb)| PixelCorrespondence { a: pa, b: pb })
                .collect();
            (matches.len() >= 20).then(|| TileEdge {
                a,
                b,
                estimate: SimilarityEstimate {
                    transform: Similarity2d {
                        scale: 1.0,
                        theta: 0.0,
                        tx: centres[a].0 - centres[b].0,
                        ty: centres[a].1 - centres[b].1,
                    },
                    inlier_mask: vec![true; matches.len()],
                    inlier_count: matches.len(),
                    mean_residual_px: 0.0,
                    sigma_hat_px: 0.0,
                    iterations: 0,
                },
                inlier_matches: matches,
            })
        })
        .collect()
}

/// A dune: a broad Gaussian mound 3% of the flight height tall, centred
/// under the set's middle — the depth-dependent parallax a rigid
/// per-frame similarity cannot absorb.
fn dune(p: (f64, f64)) -> f64 {
    let (dx, dy) = (p.0 - 1800.0, p.1 - 600.0);
    0.03 * FLIGHT_HEIGHT * (-(dx * dx + dy * dy) / (2.0 * 1400.0_f64.powi(2))).exp()
}

fn dims() -> Vec<(u32, u32)> {
    vec![(W as u32, H as u32); 6]
}

#[test]
fn planted_relief_parallax_is_absorbed_by_the_mesh() {
    let centres = centres();
    let poses = ground_poses(&centres);
    let edges = edges_over(&centres, &dune);
    let corrections = fit_planar_corrections(&poses, &dims(), &edges);

    let (mean_off, max_off) = planar_residuals(&poses, &edges, None);
    let (mean_on, max_on) = planar_residuals(&poses, &edges, Some(&corrections));
    assert!(
        mean_off > 10.0,
        "planted parallax too weak: {mean_off:.2} px"
    );
    assert!(
        mean_on < 0.05 * mean_off,
        "mesh mean {mean_on:.2} px vs off {mean_off:.2} px"
    );
    assert!(
        max_on < 0.15 * max_off,
        "mesh max {max_on:.2} px vs off {max_off:.2} px"
    );
    assert!(corrections.iter().all(|c| c.rms_px > 0.0));
}

#[test]
fn flat_ground_fits_the_identity() {
    let centres = centres();
    let poses = ground_poses(&centres);
    let edges = edges_over(&centres, &|_| 0.0);
    let corrections = fit_planar_corrections(&poses, &dims(), &edges);

    assert!(corrections.iter().all(|c| c.max_correction_px < 1e-9));
    assert_eq!(
        planar_residuals(&poses, &edges, Some(&corrections)),
        planar_residuals(&poses, &edges, None)
    );
}

#[test]
fn misplaced_frame_is_refused_not_bent() {
    let centres = centres();
    let mut poses = ground_poses(&centres);
    poses[4].sim.tx += 400.0;
    let edges = edges_over(&centres, &|_| 0.0);
    let corrections = fit_planar_corrections(&poses, &dims(), &edges);

    assert_eq!(corrections[4].max_correction_px, 0.0);
    assert!(corrections[4].fit_blocks > 0);
}

#[test]
fn corrected_point_inverts_the_sample_shift() {
    let pose = &ground_poses(&centres())[1];
    let mut corr = LocalCorrection::identity(W, H);
    corr.nodes
        .iter_mut()
        .enumerate()
        .for_each(|(i, n)| *n = [3.0 + 0.2 * i as f64, -2.0 + 0.1 * i as f64]);
    let p = (1234.5, 876.25);
    let (cx, cy) = corrected_canvas_point(pose, Some(&corr), p);
    let (sx, sy) = to_source(pose, cx, cy);
    let (ax, ay) = corr.apply(sx, sy);
    assert!((ax - p.0).abs() < 1e-3 && (ay - p.1).abs() < 1e-3);
}
