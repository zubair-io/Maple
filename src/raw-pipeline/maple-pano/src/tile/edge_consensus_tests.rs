//! Unit tests for [`super::verify_tile_edges`].

use super::*;
use crate::graph::VerifiedEdge;
use crate::math::Mat3;

const DIMS: (u32, u32) = (1000, 1000);

/// `n` matches on a depth band whose content moves by `shift` from frame
/// `a` to frame `b` (frame `b` sits `shift` further along the canvas).
fn band(
    n: usize,
    xs: (f64, f64),
    ys: (f64, f64),
    shift: (f64, f64),
    jitter: f64,
    seed: u64,
) -> Vec<PixelCorrespondence> {
    let mut rng = SplitMix64::new(seed);
    (0..n)
        .map(|_| {
            let (x, y) = (rng.next_range(xs.0, xs.1), rng.next_range(ys.0, ys.1));
            let noise = (
                rng.next_range(-jitter, jitter),
                rng.next_range(-jitter, jitter),
            );
            PixelCorrespondence {
                a: (x, y),
                b: (x - shift.0 + noise.0, y - shift.1 + noise.1),
            }
        })
        .collect()
}

fn ground(shift_y: f64, n: usize, seed: u64) -> Vec<PixelCorrespondence> {
    band(
        n,
        (50.0, 950.0),
        (shift_y, 1000.0),
        (0.0, shift_y),
        1.5,
        seed,
    )
}

/// A tight, narrow band (a rooftop row, a tree line) moving `shift_y`.
fn alias(shift_y: f64, n: usize, seed: u64) -> Vec<PixelCorrespondence> {
    band(
        n,
        (800.0, 900.0),
        (shift_y, 1000.0),
        (0.0, shift_y),
        0.5,
        seed,
    )
}

fn graph(frames: usize, edges: Vec<(usize, usize, Vec<PixelCorrespondence>)>) -> MatchGraph {
    MatchGraph {
        image_count: frames,
        edges: edges
            .into_iter()
            .map(|(a, b, inlier_matches)| VerifiedEdge {
                a,
                b,
                rotation: Mat3::identity(),
                inlier_count: inlier_matches.len(),
                mean_residual_rad: 0.0,
                inlier_matches,
            })
            .collect(),
        rejected: vec![],
        components: vec![(0..frames).collect()],
        orphans: vec![],
    }
}

fn verify(g: &MatchGraph) -> Vec<TileEdge> {
    verify_tile_edges(
        g,
        7,
        &SimilarityOptions::default(),
        &vec![DIMS; g.image_count],
    )
}

fn edge(edges: &[TileEdge], a: usize, b: usize) -> Option<&TileEdge> {
    edges.iter().find(|e| (e.a, e.b) == (a, b))
}

#[test]
fn skip_edge_takes_the_band_its_neighbours_agree_on() {
    let skip = [alias(450.0, 120, 3), ground(600.0, 80, 4)].concat();
    let g = graph(
        3,
        vec![
            (0, 1, ground(300.0, 200, 1)),
            (1, 2, ground(300.0, 200, 2)),
            (0, 2, skip),
        ],
    );
    let edges = verify(&g);
    assert_eq!(edges.len(), 3);
    let chosen = edge(&edges, 0, 2)
        .expect("skip edge kept")
        .estimate
        .transform;
    assert!(
        (chosen.ty + 600.0).abs() < 5.0,
        "skip edge kept the alias band: ty={}",
        chosen.ty
    );
}

#[test]
fn edge_with_only_a_contradicting_band_is_dropped() {
    let g = graph(
        4,
        vec![
            (0, 1, ground(300.0, 200, 1)),
            (1, 2, ground(300.0, 200, 2)),
            (2, 3, ground(300.0, 200, 3)),
            (0, 2, alias(450.0, 60, 5)),
            (1, 3, ground(600.0, 120, 4)),
        ],
    );
    let kept: Vec<(usize, usize)> = verify(&g).iter().map(|e| (e.a, e.b)).collect();
    assert_eq!(kept, vec![(0, 1), (1, 2), (2, 3), (1, 3)]);
}

#[test]
fn consistent_strip_keeps_every_edge_and_its_dominant_fit() {
    let g = graph(
        3,
        vec![
            (0, 1, ground(300.0, 150, 1)),
            (1, 2, ground(300.0, 150, 2)),
            (0, 2, ground(600.0, 90, 3)),
        ],
    );
    let edges = verify(&g);
    assert_eq!(edges.len(), 3);
    assert!(edges
        .iter()
        .all(|e| (e.estimate.transform.ty + 300.0 * (e.b - e.a) as f64).abs() < 3.0));
}

#[test]
fn triangle_whose_dominant_fits_disagree_settles_on_a_consistent_set() {
    let g = graph(
        3,
        vec![
            (0, 1, ground(300.0, 330, 1)),
            (0, 2, [ground(600.0, 84, 2), alias(720.0, 41, 3)].concat()),
            (1, 2, [alias(370.0, 295, 4), ground(300.0, 139, 5)].concat()),
        ],
    );
    let edges = verify(&g);
    let ty = |a, b| edge(&edges, a, b).map(|e| -e.estimate.transform.ty);
    let (t01, t02, t12) = (ty(0, 1), ty(0, 2), ty(1, 2));
    assert!(
        matches!((t01, t02, t12), (Some(a), Some(c), Some(b)) if (a + b - c).abs() < 5.0),
        "inconsistent bands: 0-1 {t01:?}, 1-2 {t12:?}, 0-2 {t02:?}"
    );
}
