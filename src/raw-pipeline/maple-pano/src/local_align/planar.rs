//! Stage F on the tile path (#4577): the same bilinear mesh, fitted in
//! each frame's source-pixel space against its planar canvas pose.
//!
//! A tile frame is placed by a rigid similarity `S`, and the composite
//! samples source pixel `p' + E(p')` at the canvas pixel whose inverse
//! pose is `p'` — one resample, exactly as the rotation warp does. So a
//! source pixel `p` lands on the canvas at `S(p')` where `p' + E(p') = p`.
//!
//! For every verified match the two frames should meet at the midpoint
//! `M` of their placed positions, each side taking half of the
//! disagreement (iterated, see [`CONSENSUS_PASSES`]). Frame `a` reaches `M` when `E_a(S_a⁻¹(M)) = m_a −
//! S_a⁻¹(M)` — an exact, not linearised, data point at `S_a⁻¹(M)` for
//! the shared mesh fit.

use crate::tile::{TileEdge, TilePose};

use super::fit::{fit_mesh, MeshBounds};
use super::LocalCorrection;

/// Tile-path mesh bounds. Drone-survey relief (a dune under a 140 m
/// flight, rooftops over a street) moves depth bands by tens of source
/// pixels on 100 MP frames, far beyond the rotation path's centimetre
/// drift envelope; the cap still refuses a field that would have to
/// bend a frame the band choice has misplaced.
pub(crate) const TILE_BOUNDS: MeshBounds = MeshBounds {
    max_node_px: 96.0,
    max_rms_px: 48.0,
};

/// Fixed-point steps for `p' + E(p') = p`. Mesh cells span ~1.5 kpx on
/// production frames, so the map is a strong contraction and three steps
/// land well under 0.01 px.
const INVERT_STEPS: usize = 3;

/// Jacobi passes toward one consensus position per scene point. A point
/// seen by three or more frames gets a different pairwise midpoint from
/// each pair, so one pass leaves the frames disagreeing; each further pass
/// recomputes the midpoints from the corrected positions. On the planted
/// dune gate the mean residual goes 9.1 → 3.3 → 1.4 → 0.6 px over passes
/// 1–5 and flattens after.
const CONSENSUS_PASSES: usize = 5;

/// Inverse of `pose.sim` (canvas → source pixel), without the canvas offset.
fn to_source(pose: &TilePose, cx: f64, cy: f64) -> (f64, f64) {
    let s = &pose.sim;
    let (sin, cos) = s.theta.sin_cos();
    let (dx, dy) = ((cx - s.tx) / s.scale, (cy - s.ty) / s.scale);
    (cos * dx + sin * dy, -sin * dx + cos * dy)
}

/// Canvas position (without the canvas offset) of source pixel `p` once
/// `corr` is applied in the warp.
pub(crate) fn corrected_canvas_point(
    pose: &TilePose,
    corr: Option<&LocalCorrection>,
    p: (f64, f64),
) -> (f64, f64) {
    let sampled_at = corr.map_or(p, |c| {
        (0..INVERT_STEPS).fold(p, |q, _| {
            let (ax, ay) = c.apply(q.0, q.1);
            (p.0 - (ax - q.0), p.1 - (ay - q.1))
        })
    });
    pose.sim.apply(sampled_at.0, sampled_at.1)
}

/// Fit one mesh per placed frame (parallel to `poses`) from the verified
/// matches of `edges`, splitting each match's disagreement evenly between
/// its two frames.
pub(crate) fn fit_planar_corrections(
    poses: &[TilePose],
    full_dims: &[(u32, u32)],
    edges: &[TileEdge],
) -> Vec<LocalCorrection> {
    (0..CONSENSUS_PASSES)
        .fold(None, |prev: Option<Vec<LocalCorrection>>, _| {
            Some(fit_pass(poses, full_dims, edges, prev.as_deref()))
        })
        .unwrap_or_default()
}

fn fit_pass(
    poses: &[TilePose],
    full_dims: &[(u32, u32)],
    edges: &[TileEdge],
    prev: Option<&[LocalCorrection]>,
) -> Vec<LocalCorrection> {
    let local_of = local_index(poses);
    let corr_of = |l: usize| prev.map(|c| &c[l]);
    let mut pts: Vec<Vec<(f64, f64)>> = vec![Vec::new(); poses.len()];
    let mut targets: Vec<Vec<[f64; 2]>> = vec![Vec::new(); poses.len()];
    for edge in edges {
        let (Some(la), Some(lb)) = (local_of(edge.a), local_of(edge.b)) else {
            continue;
        };
        for m in &edge.inlier_matches {
            let (ax, ay) = corrected_canvas_point(&poses[la], corr_of(la), m.a);
            let (bx, by) = corrected_canvas_point(&poses[lb], corr_of(lb), m.b);
            let mid = (0.5 * (ax + bx), 0.5 * (ay + by));
            for (l, obs) in [(la, m.a), (lb, m.b)] {
                let at = to_source(&poses[l], mid.0, mid.1);
                pts[l].push(at);
                targets[l].push([obs.0 - at.0, obs.1 - at.1]);
            }
        }
    }
    poses
        .iter()
        .enumerate()
        .map(|(l, pose)| {
            let (w, h) = full_dims[pose.frame_idx];
            fit_mesh(
                f64::from(w),
                f64::from(h),
                &pts[l],
                &targets[l],
                TILE_BOUNDS,
            )
        })
        .collect()
}

/// Mean and max canvas distance between the two placed ends of every
/// verified match, with `corrections` (parallel to `poses`) applied.
pub(crate) fn planar_residuals(
    poses: &[TilePose],
    edges: &[TileEdge],
    corrections: Option<&[LocalCorrection]>,
) -> (f64, f64) {
    let local_of = local_index(poses);
    let corr_of = |l: usize| corrections.map(|c| &c[l]);
    let residuals: Vec<f64> = edges
        .iter()
        .filter_map(|e| Some((local_of(e.a)?, local_of(e.b)?, e)))
        .flat_map(|(la, lb, e)| {
            e.inlier_matches.iter().map(move |m| {
                let (ax, ay) = corrected_canvas_point(&poses[la], corr_of(la), m.a);
                let (bx, by) = corrected_canvas_point(&poses[lb], corr_of(lb), m.b);
                ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt()
            })
        })
        .collect();
    let max = residuals.iter().copied().fold(0.0, f64::max);
    let mean = if residuals.is_empty() {
        0.0
    } else {
        residuals.iter().sum::<f64>() / residuals.len() as f64
    };
    (mean, max)
}

fn local_index(poses: &[TilePose]) -> impl Fn(usize) -> Option<usize> + '_ {
    move |frame| poses.iter().position(|p| p.frame_idx == frame)
}

#[cfg(test)]
#[path = "planar_tests.rs"]
mod tests;
