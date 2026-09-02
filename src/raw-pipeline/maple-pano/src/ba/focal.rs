//! Homography-based focal-length self-calibration — the EXIF-less
//! fallback camera-model seed (spec §5.3 "Initialization"; ticket
//! #1214). Carried over from PR #17's `ba/focal.rs` ("focal-from-
//! homography-decomposition survives as the EXIF-fallback initializer"
//! in that PR's eng-design disposition table).
//!
//! # Why homography, not two-view rotation
//!
//! [`crate::twoview::solve_rotation`] needs bearings, and a bearing
//! needs a focal length already — the exact thing missing here. A
//! planar homography needs no camera model at all: it is a pure
//! 2D-to-2D fit from raw pixel correspondences. Once fit, the
//! rotation-homography self-calibration relation `H = K R K⁻¹`
//! (`K = diag(f, f, 1)`, principal point at each frame's image centre,
//! the *same* `f` in both cameras — a pure-rotation pair shares
//! intrinsics by construction) lets `f` be read back out of `H` in
//! closed form.
//!
//! # Derivation
//!
//! Requiring `R = K⁻¹HK` be orthonormal (rows, and separately columns,
//! both mutually orthogonal and equal-norm) gives four equations in
//! `f²`: two from the top-two-row block (image `b`'s scaling in `H`)
//! and two from the left-two-column block (image `a`'s). Each block's
//! two equations are algebraically equivalent in the noiseless case but
//! differ in numerical conditioning; [`pick_more_stable`] takes
//! whichever has the larger-magnitude denominator, falling back to the
//! other when the preferred one isn't a valid (real, positive) `f²`.
//! The row-block and column-block estimates, when both available, are
//! averaged into one per-pair focal estimate; [`homography_focal_seed_px`]
//! then takes the median across every verified match-graph edge (spec
//! §5.3's "median over pairs for robustness").
//!
//! # Accuracy
//!
//! This is a seed, not a solution — bundle adjustment (`crate::ba`)
//! refines rotation *and* shared focal jointly afterward, so the seed
//! only needs to land BA's Levenberg–Marquardt basin, not be exact.
//! Single-pair homography self-calibration is a known-poor-conditioning
//! problem (near-degenerate for narrow-baseline or low-parallax pairs),
//! which is why every verified pair contributes an estimate and the
//! median absorbs individual pair failures rather than trusting one
//! pair alone.

use crate::eigen::eigen_symmetric;
use crate::graph::{MatchGraph, VerifiedEdge};
use crate::math::Mat3;
use crate::twoview::PixelCorrespondence;

/// Shared focal seed (pixels, median) over every verified edge in
/// `graph` with a usable per-pair homography estimate — the EXIF-less
/// fallback seed (spec §5.3, ticket #1214).
///
/// `dims[i]` is frame `i`'s `(width, height)` in the same coordinate
/// space `graph`'s edges were verified in (proxy or full resolution —
/// caller's choice, as long as it's consistent with the inlier pixel
/// coordinates on each edge). `None` when no edge yields an estimate —
/// the caller's hard-error condition ("fewer than 1 verified pair").
pub fn homography_focal_seed_px(graph: &MatchGraph, dims: &[(u32, u32)]) -> Option<f64> {
    let estimates: Vec<f64> = graph
        .edges
        .iter()
        .filter_map(|e| focal_from_edge(e, dims))
        .collect();
    super::support::median(estimates.into_iter())
}

/// Per-pair estimate for one verified match-graph edge (see module
/// docs).
fn focal_from_edge(edge: &VerifiedEdge, dims: &[(u32, u32)]) -> Option<f64> {
    focal_from_pair_homography(&edge.inlier_matches, dims[edge.a], dims[edge.b])
}

/// Estimate a shared focal length (pixels) from one pair's inlier pixel
/// correspondences (see module docs for the derivation). `None` when
/// there are too few correspondences to fit a homography (`< 4`), or
/// neither self-calibration block yields a real, positive `f²`.
pub fn focal_from_pair_homography(
    matches: &[PixelCorrespondence],
    dims_a: (u32, u32),
    dims_b: (u32, u32),
) -> Option<f64> {
    let center = |dims: (u32, u32)| (dims.0 as f64 / 2.0, dims.1 as f64 / 2.0);
    let (cx_a, cy_a) = center(dims_a);
    let (cx_b, cy_b) = center(dims_b);
    let centered: Vec<PixelCorrespondence> = matches
        .iter()
        .map(|m| PixelCorrespondence {
            a: (m.a.0 - cx_a, m.a.1 - cy_a),
            b: (m.b.0 - cx_b, m.b.1 - cy_b),
        })
        .collect();

    let h = fit_homography(&centered)?.0;
    let (h11, h12, h13) = (h[0][0], h[0][1], h[0][2]);
    let (h21, h22, h23) = (h[1][0], h[1][1], h[1][2]);
    let (h31, h32) = (h[2][0], h[2][1]);

    // Row block (top two rows): Row1·Row2 = 0 and |Row1| = |Row2|.
    let row_d1 = h11 * h21 + h12 * h22;
    let row_v1 = -(h13 * h23) / row_d1;
    let row_d2 = h21 * h21 + h22 * h22 - h11 * h11 - h12 * h12;
    let row_v2 = (h13 * h13 - h23 * h23) / row_d2;
    let row_f2 = pick_more_stable(row_v1, row_d1, row_v2, row_d2);

    // Column block (left two columns): Col1·Col2 = 0 and |Col1| = |Col2|.
    let col_d1 = h31 * h32;
    let col_v1 = -(h11 * h12 + h21 * h22) / col_d1;
    let col_d2 = h31 * h31 - h32 * h32;
    let col_v2 = (h12 * h12 + h22 * h22 - h11 * h11 - h21 * h21) / col_d2;
    let col_f2 = pick_more_stable(col_v1, col_d1, col_v2, col_d2);

    let f2 = match (row_f2, col_f2) {
        (Some(r), Some(c)) => 0.5 * (r + c),
        (Some(r), None) => r,
        (None, Some(c)) => c,
        (None, None) => return None,
    };
    Some(f2.sqrt())
}

/// Picks whichever of two `f²` candidates has the larger-magnitude
/// denominator (more numerically stable), falling back to the other
/// when the preferred one isn't a real, positive value. `None` when
/// neither candidate is usable.
fn pick_more_stable(v_a: f64, d_a: f64, v_b: f64, d_b: f64) -> Option<f64> {
    let (preferred, fallback) = if d_a.abs() >= d_b.abs() {
        (v_a, v_b)
    } else {
        (v_b, v_a)
    };
    [preferred, fallback]
        .into_iter()
        .find(|v| v.is_finite() && *v > 0.0)
}

/// Fit a planar homography `H` (`p_b ≈ H · p_a`, homogeneous, up to
/// scale) from `≥ 4` pixel correspondences via the normalized DLT:
/// Hartley-normalize each side, solve the homogeneous system for the
/// eigenvector of `AᵀA` belonging to its smallest eigenvalue
/// ([`eigen_symmetric`]), then denormalize. `None` when there are fewer
/// than 4 correspondences, or normalization is degenerate (every point
/// on one side coincides).
fn fit_homography(matches: &[PixelCorrespondence]) -> Option<Mat3> {
    if matches.len() < 4 {
        return None;
    }
    let (norm_a, t_a) = normalize(matches.iter().map(|m| m.a))?;
    let (norm_b, t_b) = normalize(matches.iter().map(|m| m.b))?;

    // AᵀA accumulated directly (2 design-matrix rows per point) rather
    // than materializing the full 2n×9 matrix.
    let mut ata = [[0.0_f64; 9]; 9];
    for ((xa, ya), (xb, yb)) in norm_a.iter().zip(&norm_b) {
        let rows = [
            [-xa, -ya, -1.0, 0.0, 0.0, 0.0, xa * xb, ya * xb, *xb],
            [0.0, 0.0, 0.0, -xa, -ya, -1.0, xa * yb, ya * yb, *yb],
        ];
        for row in rows {
            for i in 0..9 {
                for j in 0..9 {
                    ata[i][j] += row[i] * row[j];
                }
            }
        }
    }
    let (_, eigenvectors) = eigen_symmetric::<9>(&ata);
    // `eigen_symmetric` sorts eigenvalues descending; the DLT solution
    // is the eigenvector of the *smallest* eigenvalue — the last row.
    let h = eigenvectors[8];
    let h_norm = Mat3([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]]);
    Some(inverse_similarity(&t_b).mul_mat(&h_norm).mul_mat(&t_a))
}

/// Hartley normalization: translate `points` to a zero centroid and
/// isotropically scale so the mean distance from the origin is `√2`.
/// Returns the normalized points plus the similarity transform `T` used
/// (`p' = T · p`, homogeneous) so the fit can be denormalized. `None`
/// when `points` is empty or every point coincides (zero mean distance
/// — no scale is recoverable).
fn normalize(points: impl Iterator<Item = (f64, f64)> + Clone) -> Option<(Vec<(f64, f64)>, Mat3)> {
    let n = points.clone().count();
    if n == 0 {
        return None;
    }
    let (sum_x, sum_y) = points
        .clone()
        .fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x, sy + y));
    let (cx, cy) = (sum_x / n as f64, sum_y / n as f64);
    let mean_dist = points
        .clone()
        .map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
        .sum::<f64>()
        / n as f64;
    if mean_dist < 1e-9 {
        return None;
    }
    let s = std::f64::consts::SQRT_2 / mean_dist;
    let normalized: Vec<(f64, f64)> = points.map(|(x, y)| (s * (x - cx), s * (y - cy))).collect();
    let t = Mat3([[s, 0.0, -s * cx], [0.0, s, -s * cy], [0.0, 0.0, 1.0]]);
    Some((normalized, t))
}

/// Inverse of a [`normalize`]-shaped similarity transform (uniform
/// scale + translate, bottom row `[0, 0, 1]`) — closed form, cheaper
/// and exacter than a general 3×3 inverse for this restricted shape.
fn inverse_similarity(t: &Mat3) -> Mat3 {
    let s = t.0[0][0];
    let inv_s = 1.0 / s;
    let cx = -t.0[0][2] * inv_s;
    let cy = -t.0[1][2] * inv_s;
    Mat3([[inv_s, 0.0, cx], [0.0, inv_s, cy], [0.0, 0.0, 1.0]])
}

#[cfg(test)]
#[path = "focal_tests.rs"]
mod tests;
