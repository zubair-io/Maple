//! Post-BA per-pair canvas-space translation refinement.
//!
//! Even after a converged bundle adjustment, the warped images on the
//! canvas often disagree by 1–4 pixels at seam regions. Common
//! sources:
//!
//!   - Lens-distortion residual not modelled by the K1/K2 polynomial.
//!   - Focal-length bias (EXIF prior off by a few percent — DJI's
//!     35mm-equivalent metadata is approximate).
//!   - Parallax from the (small) drone hover wobble that BA's t
//!     vector only partially captures.
//!   - Radial errors that grow toward the canvas edges.
//!
//! Visible result: doubled features at seams (cliff edges, trees),
//! soft-blurred cars/fences, brightness/colour blending hiding what
//! looks like ghosting.
//!
//! This module computes a SINGLE 2D translation per pair via SSD
//! search on a downsampled copy of the overlap region, then chains
//! per-pair shifts into per-image cumulative offsets that callers
//! apply via bilinear translation to the warped canvas pixels.
//!
//! Trade-offs:
//!   - Cheap (one SSD search per pair, downsampled).
//!   - Rotation/scale residual unhandled — only translation.
//!   - For real per-pixel flow (parallax handling), see the
//!     deferred T4 in `docs/superpowers/plans/...`.

use crate::error::PanoError;
use crate::types::PanoImage;

/// Count canvas pixels that are valid in BOTH images. Used to score
/// pairwise spatial adjacency for `build_overlap_spanning_tree`.
/// Operates on the underlying u64 chunks of `BitVec` for speed —
/// ~1 ms on a 50 MP canvas vs ~50 ms for per-bit iteration.
pub fn validity_overlap_count(a: &PanoImage, b: &PanoImage) -> u64 {
    debug_assert_eq!(a.validity.len(), b.validity.len());
    let a_chunks = a.validity.as_raw_slice();
    let b_chunks = b.validity.as_raw_slice();
    debug_assert_eq!(a_chunks.len(), b_chunks.len());
    let mut count: u64 = 0;
    for k in 0..a_chunks.len() {
        count += (a_chunks[k] & b_chunks[k]).count_ones() as u64;
    }
    count
}

/// Find all image pairs whose canvas-pixel overlap is at least
/// `min_overlap_px`. Returns `(i, j)` with `i < j`, sorted by
/// overlap count descending so the highest-confidence pairs come
/// first — useful when caller wants to cap the total pair count
/// for performance.
pub fn find_overlapping_pairs(
    warped: &[PanoImage],
    min_overlap_px: u64,
) -> Vec<(usize, usize, u64)> {
    let n = warped.len();
    let mut pairs: Vec<(usize, usize, u64)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let count = validity_overlap_count(&warped[i], &warped[j]);
            if count >= min_overlap_px {
                pairs.push((i, j, count));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.cmp(&a.2));
    pairs
}

/// Solve for per-image canvas-space `(dx, dy)` from a set of
/// per-pair observed offsets via weighted least squares.
///
/// For each pair `(i, j)` with observed offset `(o_x, o_y)`:
///
/// ```text
///   image_j_offset - image_i_offset = (o_x, o_y)
/// ```
///
/// Image 0's offset is pinned to `(0, 0)` (gauge). The remaining
/// `N - 1` per-image offsets are solved by LSQ over all observed
/// pairs. Per-pair weight is `min(overlap_px, 1) / 1` raw — pairs
/// with more shared canvas pixels carry more weight, so a
/// low-overlap pair with a noisy SSD result can't drag the global
/// solution. A small Tikhonov term keeps the system well-posed
/// even if the overlap graph is disconnected.
///
/// Returns one `(dx, dy)` per image. Image 0 is always `(0, 0)`.
pub fn solve_per_image_offsets_lsq(
    pair_offsets: &[(PairOffset, u64)],
    image_count: usize,
) -> Vec<(f32, f32)> {
    use nalgebra::{DMatrix, DVector};

    if image_count == 0 {
        return Vec::new();
    }
    if image_count == 1 || pair_offsets.is_empty() {
        return vec![(0.0_f32, 0.0_f32); image_count];
    }

    let m = pair_offsets.len();
    let n_vars = image_count - 1; // image 0 is gauge

    let mut a = DMatrix::<f64>::zeros(m, n_vars);
    let mut b_x = DVector::<f64>::zeros(m);
    let mut b_y = DVector::<f64>::zeros(m);

    for (k, (po, weight_px)) in pair_offsets.iter().enumerate() {
        // Weight = sqrt(overlap pixels). Square-root because LSQ
        // squares the residuals — sqrt-weighting gives the linear
        // weight in residual space.
        let w = (*weight_px as f64).sqrt();
        if po.i > 0 {
            a[(k, po.i - 1)] = -w;
        }
        if po.j > 0 {
            a[(k, po.j - 1)] = w;
        }
        b_x[k] = (po.dx as f64) * w;
        b_y[k] = (po.dy as f64) * w;
    }

    // Normal equations + small Tikhonov for stability when the
    // overlap graph is disconnected (a connected component has no
    // constraint pulling it toward image 0's gauge → singular A^T A).
    let at = a.transpose();
    let mut at_a = &at * &a;
    for k in 0..n_vars {
        at_a[(k, k)] += 1e-6;
    }
    let at_bx = &at * &b_x;
    let at_by = &at * &b_y;

    let lu = at_a.lu();
    let x_sol = lu.solve(&at_bx).unwrap_or_else(|| DVector::zeros(n_vars));
    let y_sol = lu.solve(&at_by).unwrap_or_else(|| DVector::zeros(n_vars));

    let mut out = vec![(0.0_f32, 0.0_f32); image_count];
    for i in 1..image_count {
        out[i] = (x_sol[i - 1] as f32, y_sol[i - 1] as f32);
    }
    out
}

/// Build a spanning-tree adjacency list rooted at image 0 over the
/// pairwise canvas-pixel-overlap graph. The returned `(i, j)` pairs
/// are in tree-traversal order: when each pair is processed in
/// sequence, `i` is always an image that's already been "seen"
/// (either as the root or via a previous pair), and `j` is being
/// added. Compatible with `chain_pair_offsets_to_per_image`.
///
/// Pairs whose overlap count is below `min_overlap_px` are
/// excluded — for multi-row spherical panoramas this prevents the
/// chain from forcing a non-overlapping pair (e.g. file-sequential
/// frames captured at different pitches that don't actually share
/// content).
///
/// The DJI 21-frame "Sphere" panorama mode triggers this — frames
/// are captured in a non-row-major order, so file-order
/// `(0,1), (1,2), …` traverses cross-row jumps where the actual
/// canvas overlap is tiny. The validity-based tree picks the
/// genuine neighbours instead.
pub fn build_overlap_spanning_tree(
    warped: &[PanoImage],
    min_overlap_px: u64,
) -> Vec<(usize, usize)> {
    let n = warped.len();
    if n < 2 {
        return Vec::new();
    }

    // Pairwise overlap matrix. Dense — N=21 → 441 entries, cheap.
    let mut overlap = vec![vec![0u64; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let count = validity_overlap_count(&warped[i], &warped[j]);
            overlap[i][j] = count;
            overlap[j][i] = count;
        }
    }

    // Prim's MST rooted at image 0. At each step pick the highest-
    // overlap edge connecting an already-visited image to a new one.
    let mut visited = vec![false; n];
    visited[0] = true;
    let mut edges: Vec<(usize, usize)> = Vec::with_capacity(n - 1);

    while edges.len() < n - 1 {
        let mut best_count: u64 = 0;
        let mut best_i: Option<usize> = None;
        let mut best_j: Option<usize> = None;
        for i in 0..n {
            if !visited[i] {
                continue;
            }
            for j in 0..n {
                if visited[j] {
                    continue;
                }
                if overlap[i][j] >= min_overlap_px && overlap[i][j] > best_count {
                    best_count = overlap[i][j];
                    best_i = Some(i);
                    best_j = Some(j);
                }
            }
        }
        match (best_i, best_j) {
            (Some(i), Some(j)) => {
                edges.push((i, j));
                visited[j] = true;
            }
            _ => {
                // No more reachable images. The graph is
                // disconnected — return what we've got. The
                // unreachable images will keep their (0, 0) offset
                // in chain_pair_offsets_to_per_image.
                break;
            }
        }
    }

    edges
}

/// Compute pair offsets by **matching features in canvas space** —
/// AKAZE on each warped image, brute-force descriptor match across
/// each pair, robust median residual.
///
/// Why this beats SSD-on-overlap-pixels for large-magnitude
/// alignment errors:
///
///   - SSD on a textureless overlap (sky, water) has a flat
///     minimum across many candidate offsets. The "best" SSD
///     position is whichever pixel happens to be closest by chance
///     — at large search radii this finds garbage.
///   - Feature matching only fires on actual textured content.
///     Each matched feature pair is a pixel-accurate
///     correspondence by construction. RANSAC-style median
///     filtering rejects descriptor mismatches.
///   - The displacement between matched canvas-space keypoints IS
///     the per-pair shift, no search radius needed. Works at any
///     magnitude — 5 px or 500 px.
///
/// This is the right signal when BA leaves residuals that exceed
/// SSD's reliable search range (the road/coast duplication symptom
/// on a multi-row 21-frame pano: same physical place at two
/// canvas positions separated by ~100+ px).
///
/// Trade-off: slower than SSD (~1 s per image for AKAZE detection
/// + ~100 ms per pair to match). Acceptable for stitching.
///
/// Returns `(PairOffset, overlap_pixel_count)` for downstream
/// `solve_per_image_offsets_lsq`. Pairs that produced too few
/// matches to be reliable are dropped.
pub fn compute_pair_offsets_from_features(
    warped: &[PanoImage],
    pairs: &[(usize, usize, u64)],
    inlier_thresh_px: f32,
    min_inliers: usize,
) -> Vec<(PairOffset, u64)> {
    use crate::features::AkazeDetector;
    use crate::matching::brute_force::BruteForceMatcher;
    use crate::traits::{FeatureDetector, FeatureMatcher};

    // Same AKAZE threshold as the BA-stage matcher uses on input
    // DNGs (0.0005 is the package default). Lowering it on warped
    // canvas images sounds attractive (more keypoints in low-
    // texture regions) but in practice catches noise features
    // that descriptor-match by chance — RANSAC on 4 inliers
    // can't reject systematic descriptor noise, so the LSQ
    // produced wildly inconsistent per-image offsets (e.g. image
    // 8 = +186 px while neighbour image 12 = -162 px on pano_01).
    // Stick with the conservative default; rely on iterative
    // refinement at the call site to catch images that don't get
    // a feature constraint on the first pass.
    let detector = AkazeDetector::new();
    // Lowe-style ratio test (0.8) with mutual nearest-neighbour
    // check — same defaults the existing matching pipeline uses.
    let matcher = BruteForceMatcher::new(0.8, true);

    // Detect features once per image. Sparse — failed images get
    // empty Features and won't contribute to any pair's inliers.
    let feats: Vec<crate::types::Features> = warped
        .iter()
        .map(|img| detector.detect(img).unwrap_or_default())
        .collect();

    let mut out = Vec::with_capacity(pairs.len());
    for &(i, j, weight) in pairs {
        if i >= feats.len() || j >= feats.len() {
            continue;
        }
        let m = match matcher.match_pairs(&feats[i], &feats[j]) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if m.inliers.len() < min_inliers {
            continue;
        }
        // Per-match canvas residual: where the matched feature is
        // in image i's canvas vs image j's canvas. Positive (dx, dy)
        // = j's keypoint is at (kp_j.x - dx, kp_j.y - dy) of i's,
        // i.e. shifting image j by (+dx, +dy) brings the feature
        // into alignment with i.
        let mut dxs: Vec<f32> = Vec::with_capacity(m.inliers.len());
        let mut dys: Vec<f32> = Vec::with_capacity(m.inliers.len());
        for mt in &m.inliers {
            let kp_a = feats[i].keypoints[mt.a as usize];
            let kp_b = feats[j].keypoints[mt.b as usize];
            dxs.push(kp_a.x - kp_b.x);
            dys.push(kp_a.y - kp_b.y);
        }
        let med_dx = median_f32(&mut dxs.clone());
        let med_dy = median_f32(&mut dys.clone());

        // Reject inliers > thresh from coarse median, then refine.
        let mut inlier_dxs = Vec::with_capacity(dxs.len());
        let mut inlier_dys = Vec::with_capacity(dys.len());
        for k in 0..dxs.len() {
            let dist = (dxs[k] - med_dx).hypot(dys[k] - med_dy);
            if dist <= inlier_thresh_px {
                inlier_dxs.push(dxs[k]);
                inlier_dys.push(dys[k]);
            }
        }
        if inlier_dxs.len() < min_inliers {
            continue;
        }
        let final_dx = median_f32(&mut inlier_dxs.clone());
        let final_dy = median_f32(&mut inlier_dys);

        // Weight = inlier_count × CONFIDENCE_BOOST. Feature
        // matches are pixel-accurate by construction, so we
        // upweight them relative to SSD pairs (which use raw
        // overlap-pixel count). 100× boost means 10 feature
        // inliers carry the same weight as 1000² SSD overlap
        // pixels — strong dominance.
        const FEATURE_CONFIDENCE_BOOST: u64 = 100;
        let inlier_weight = (inlier_dxs.len() as u64) * FEATURE_CONFIDENCE_BOOST;
        // Also keep a floor of the original overlap weight so a
        // feature pair never weighs LESS than the equivalent
        // SSD pair.
        let final_weight = inlier_weight.max(weight);
        out.push((
            PairOffset {
                i,
                j,
                dx: final_dx,
                dy: final_dy,
                n_overlap_px: inlier_dxs.len() as u32,
            },
            final_weight,
        ));
    }
    out
}

#[inline]
fn median_f32(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

/// Per-pair translation result. `(dx, dy)` is in canvas pixels: the
/// amount image `j` should shift to match image `i` at its current
/// canvas position. Positive `dx` = right, positive `dy` = down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairOffset {
    pub i: usize,
    pub j: usize,
    pub dx: f32,
    pub dy: f32,
    /// Number of overlap pixels actually used for the SSD search at
    /// the downsampled resolution. Zero means "no usable overlap, no
    /// refinement done" — caller should treat as `(0, 0)`.
    pub n_overlap_px: u32,
}

/// Search options for `compute_pair_offsets`.
///
/// Default is a single-scale search around `(0, 0)` with a
/// conservative radius. `coarse_search_radius_px > 0` enables a
/// two-stage (coarse → fine) search for cases where the BA
/// residual exceeds the fine radius.
///
/// **Caveat on aggressive search**: SSD on a whole-canvas overlap
/// can latch onto the *wrong* local minimum when content is
/// repetitive (sky, water, foliage with periodic texture) — the
/// "global" SSD minimum may not be the geometrically-correct
/// alignment. Bumping `coarse_search_radius_px` from 0 to 32
/// catches large BA residuals but also catches whatever spurious
/// correspondence happens to be at -32 px on a featureless
/// overlap. On 21-frame panoramas with low-overlap pairs we've
/// observed the chain producing wildly inconsistent shifts (image
/// i = -55 px, image i+1 = -22 px implying a +33 px "correction"
/// in the opposite direction) when aggressive search is used.
/// The robust path is to plumb AKAZE+RANSAC-validated inlier
/// correspondences from BA — but that's a separate refactor. For
/// now, default to a small conservative search; users with
/// converged BA on close-overlap pairs (e.g. 3-frame stitches)
/// see real signal in the ±4 range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairOffsetOptions {
    /// Coarse-pass integer search radius (canvas pixels at full
    /// resolution). Set to `0` (default) to skip the coarse pass
    /// and use a single-scale search around `(0, 0)`. Setting
    /// to e.g. 32 expands coverage at the cost of robustness on
    /// repetitive overlaps — see struct docs.
    pub coarse_search_radius_px: i32,
    /// Downsample factor inside the coarse SSD pass.
    pub coarse_downsample: u32,
    /// Fine-pass integer search radius. When the coarse pass is
    /// skipped, this is the only search radius. Default 6.
    pub search_radius_px: i32,
    /// Downsample factor inside the fine SSD pass. Default 4.
    pub downsample: u32,
    /// Overlap pixels below this count → skip the pair.
    pub min_overlap_px: u32,
}

impl Default for PairOffsetOptions {
    fn default() -> Self {
        Self {
            // 0 = single-scale; users opt into multi-scale by
            // bumping this.
            coarse_search_radius_px: 0,
            coarse_downsample: 16,
            search_radius_px: 6,
            downsample: 4,
            min_overlap_px: 1024,
        }
    }
}

/// Compute per-pair translation offsets for a chain of adjacent
/// images. `adjacent_pairs` lists `(i, j)` index tuples; for a
/// simple horizontal panorama this is `(0,1), (1,2), …, (N-2, N-1)`.
///
/// For each pair, runs an integer SSD search at the configured
/// downsample, finds the `(dx, dy)` that minimises the sum of
/// squared luma differences over the overlap, and reports it
/// alongside how many overlap pixels were used.
///
/// All warped images must share the same canvas dimensions; this is
/// the contract of `warp_image_to_canvas` so the caller doesn't
/// need to re-check.
pub fn compute_pair_offsets(
    warped: &[PanoImage],
    adjacent_pairs: &[(usize, usize)],
    options: PairOffsetOptions,
) -> Result<Vec<PairOffset>, PanoError> {
    if warped.is_empty() {
        return Ok(Vec::new());
    }
    let w = warped[0].width;
    let h = warped[0].height;
    for img in warped {
        if img.width != w || img.height != h {
            return Err(PanoError::Warp(
                "compute_pair_offsets: warped images must share canvas dims".into(),
            ));
        }
    }
    if options.downsample == 0 {
        return Err(PanoError::Warp(
            "compute_pair_offsets: downsample must be ≥ 1".into(),
        ));
    }

    let mut out = Vec::with_capacity(adjacent_pairs.len());
    for &(i, j) in adjacent_pairs {
        if i >= warped.len() || j >= warped.len() {
            return Err(PanoError::Warp(format!(
                "compute_pair_offsets: pair ({i}, {j}) out of range for {} images",
                warped.len()
            )));
        }
        out.push(refine_pair(&warped[i], &warped[j], i, j, options));
    }
    Ok(out)
}

/// Chain per-pair offsets into per-image cumulative offsets.
///
/// Image 0 is the gauge (offset `(0, 0)`). Image `i` accumulates
/// offsets along the chain `[(0,1), (1,2), …, (i-1, i)]`. If the
/// pair list is non-sequential or branching, the function still
/// produces a per-image offset but the result is the cumulative
/// offset along whatever chain reaches that image first.
///
/// Returns one `(dx, dy)` per image in `image_count`.
pub fn chain_pair_offsets_to_per_image(
    image_count: usize,
    pair_offsets: &[PairOffset],
) -> Vec<(f32, f32)> {
    let mut per_image = vec![(0.0_f32, 0.0_f32); image_count];
    let mut visited = vec![false; image_count];
    if image_count > 0 {
        visited[0] = true; // gauge
    }
    for po in pair_offsets {
        if po.i < image_count && po.j < image_count && visited[po.i] && !visited[po.j] {
            per_image[po.j] = (per_image[po.i].0 + po.dx, per_image[po.i].1 + po.dy);
            visited[po.j] = true;
        }
    }
    per_image
}

/// Apply a per-image canvas-pixel offset by bilinear translation.
///
/// Image `i` is shifted by `(dx, dy)` so that what was at canvas
/// pixel `(x, y)` ends up at `(x + dx, y + dy)`. Pixels that would
/// pull from outside the image are marked invalid.
pub fn apply_per_image_canvas_offset(
    warped: &mut [PanoImage],
    offsets: &[(f32, f32)],
) -> Result<(), PanoError> {
    if warped.len() != offsets.len() {
        return Err(PanoError::Warp(format!(
            "apply_per_image_canvas_offset: image/offset count mismatch ({} vs {})",
            warped.len(),
            offsets.len()
        )));
    }
    for (img, &(dx, dy)) in warped.iter_mut().zip(offsets.iter()) {
        if dx.abs() < 1e-3 && dy.abs() < 1e-3 {
            continue; // identity shift
        }
        bilinear_shift_in_place(img, dx, dy);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    // Rec.709 luma. Matches what graph_cut_maxflow uses.
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Run a single-scale SSD search across `[cx - r .. cx + r] × [cy -
/// r .. cy + r]` candidate offsets, downsampled by `ds`. Returns
/// the best `(dx, dy)` and its overlap count.
fn ssd_search_around(
    a: &PanoImage,
    b: &PanoImage,
    cx: i32,
    cy: i32,
    r: i32,
    ds: i32,
    min_overlap_px: u32,
) -> (i32, i32, u32) {
    let w = a.width as i32;
    let h = a.height as i32;
    let dw = w / ds;
    let dh = h / ds;

    let mut best_dx = cx;
    let mut best_dy = cy;
    let mut best_ssd = f64::INFINITY;
    let mut best_count = 0u32;
    let mut best_dist_sq = i32::MAX;

    for cdy in (cy - r)..=(cy + r) {
        for cdx in (cx - r)..=(cx + r) {
            let mut ssd: f64 = 0.0;
            let mut count: u32 = 0;
            for gy in 0..dh {
                for gx in 0..dw {
                    let ax = gx * ds;
                    let ay = gy * ds;
                    let bx = ax + cdx;
                    let by = ay + cdy;
                    if bx < 0 || by < 0 || bx >= w || by >= h {
                        continue;
                    }
                    let a_idx = (ay as usize) * (a.width as usize) + (ax as usize);
                    let b_idx = (by as usize) * (b.width as usize) + (bx as usize);
                    if !a.validity[a_idx] || !b.validity[b_idx] {
                        continue;
                    }
                    let la = luma(
                        a.pixels[a_idx * 3],
                        a.pixels[a_idx * 3 + 1],
                        a.pixels[a_idx * 3 + 2],
                    );
                    let lb = luma(
                        b.pixels[b_idx * 3],
                        b.pixels[b_idx * 3 + 1],
                        b.pixels[b_idx * 3 + 2],
                    );
                    let d = (la - lb) as f64;
                    ssd += d * d;
                    count += 1;
                }
            }
            let needed = min_overlap_px / (ds * ds) as u32;
            if count >= needed {
                let mean = ssd / (count.max(1) as f64);
                let dist_sq = (cdx - cx) * (cdx - cx) + (cdy - cy) * (cdy - cy);
                let strictly_better = mean < best_ssd;
                let tied_and_closer = (mean - best_ssd).abs() < 1e-12 && dist_sq < best_dist_sq;
                if strictly_better || tied_and_closer {
                    best_ssd = mean;
                    best_dx = cdx;
                    best_dy = cdy;
                    best_count = count;
                    best_dist_sq = dist_sq;
                }
            }
        }
    }
    (best_dx, best_dy, best_count)
}

/// Two-stage SSD-search refinement for a single pair.
fn refine_pair(
    a: &PanoImage,
    b: &PanoImage,
    i: usize,
    j: usize,
    opts: PairOffsetOptions,
) -> PairOffset {
    let w = a.width as i32;
    let h = a.height as i32;
    let coarse_ds = opts.coarse_downsample as i32;
    let fine_ds = opts.downsample as i32;
    if w < 2 * coarse_ds.max(fine_ds) || h < 2 * coarse_ds.max(fine_ds) {
        return PairOffset {
            i,
            j,
            dx: 0.0,
            dy: 0.0,
            n_overlap_px: 0,
        };
    }

    // Stage 1: coarse pass (optional). When
    // `coarse_search_radius_px == 0`, skip and search only at the
    // fine scale around `(0, 0)`. Multi-scale buys more coverage
    // but risks chasing wrong SSD minima on repetitive content.
    let (cx, cy) = if opts.coarse_search_radius_px > 0 {
        let (cx, cy, _coarse_count) = ssd_search_around(
            a,
            b,
            0,
            0,
            opts.coarse_search_radius_px,
            coarse_ds,
            opts.min_overlap_px,
        );
        (cx, cy)
    } else {
        (0, 0)
    };

    // Stage 2: fine pass `±opts.search_radius_px` around `(cx, cy)`.
    let (best_dx, best_dy, best_count) = ssd_search_around(
        a,
        b,
        cx,
        cy,
        opts.search_radius_px,
        fine_ds,
        opts.min_overlap_px,
    );

    PairOffset {
        i,
        j,
        // Positive (dx, dy) means image b should shift by (-dx, -dy)
        // to align with a — but we report it as "the offset of b
        // relative to a's canvas coords." Caller uses this as image
        // j's translation so that pixels MOVE in the +dx +dy
        // direction. Inverted sign convention to match callers.
        dx: -best_dx as f32,
        dy: -best_dy as f32,
        n_overlap_px: best_count,
    }
}

// ---------------------------------------------------------------------------
// Per-tile local refinement
// ---------------------------------------------------------------------------

/// Per-tile local offset grid for one image pair, expressed in
/// canvas pixels. `offsets[ty * grid_cols + tx]` is the `(dx, dy)`
/// to shift image `j` so its content at the centre of tile `(tx,
/// ty)` matches image `i`'s content there. Tiles below the
/// per-tile minimum-overlap threshold get `(0, 0)` and `valid =
/// false`; the apply function fills them from neighbours so the
/// canvas edges don't get unstable.
///
/// Use after `compute_pair_offsets` + `apply_per_image_canvas_offset`
/// have applied the global per-image translation. The tile grid
/// then captures the *residual* per-tile flow that a single global
/// offset can't model — parallax that varies across the overlap.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalPairTiles {
    pub i: usize,
    pub j: usize,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// Length `grid_cols × grid_rows`. Row-major.
    pub offsets: Vec<(f32, f32)>,
    pub valid: Vec<bool>,
}

/// Options for `compute_pair_offset_tiles`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalPairOptions {
    /// Tile grid width. Higher = finer correction but slower.
    /// Default 16.
    pub grid_cols: u32,
    /// Tile grid height. Default 16.
    pub grid_rows: u32,
    /// Per-tile SSD search radius (full-resolution canvas pixels)
    /// around `(0, 0)`. Tighter than `PairOffsetOptions` because the
    /// global pair offset has already been applied. Default 3.
    pub search_radius_px: i32,
    /// Downsample factor inside each tile's SSD search. Default 4.
    pub downsample: u32,
    /// Minimum number of valid sample positions inside a tile (at
    /// the downsampled rate) for the tile to be considered usable.
    /// Default 16.
    pub min_overlap_per_tile: u32,
}

impl Default for LocalPairOptions {
    fn default() -> Self {
        Self {
            grid_cols: 16,
            grid_rows: 16,
            search_radius_px: 3,
            downsample: 4,
            min_overlap_per_tile: 16,
        }
    }
}

/// Compute per-tile local offsets between `a` and `b`. Both images
/// must already be in their globally-aligned position (i.e. the
/// caller has run `compute_pair_offsets` + `apply_per_image_canvas_offset`).
pub fn compute_pair_offset_tiles(
    a: &PanoImage,
    b: &PanoImage,
    i: usize,
    j: usize,
    options: LocalPairOptions,
) -> Result<LocalPairTiles, PanoError> {
    if a.width != b.width || a.height != b.height {
        return Err(PanoError::Warp(
            "compute_pair_offset_tiles: a/b must share canvas dims".into(),
        ));
    }
    if options.grid_cols < 2 || options.grid_rows < 2 || options.downsample == 0 {
        return Err(PanoError::Warp(
            "compute_pair_offset_tiles: grid_cols/rows ≥ 2 and downsample ≥ 1".into(),
        ));
    }

    let w = a.width as i32;
    let h = a.height as i32;
    let ds = options.downsample as i32;
    let r = options.search_radius_px;
    let gc = options.grid_cols as i32;
    let gr = options.grid_rows as i32;

    let n_tiles = (gc * gr) as usize;
    let mut offsets = vec![(0.0_f32, 0.0_f32); n_tiles];
    let mut valid = vec![false; n_tiles];

    for ty in 0..gr {
        // Pixel-space tile bounds, integer.
        let y_lo = (ty * h) / gr;
        let y_hi = ((ty + 1) * h) / gr;
        for tx in 0..gc {
            let x_lo = (tx * w) / gc;
            let x_hi = ((tx + 1) * w) / gc;

            let mut best_dx = 0i32;
            let mut best_dy = 0i32;
            let mut best_ssd = f64::INFINITY;
            let mut best_count = 0u32;
            let mut best_dist_sq = i32::MAX;

            for cdy in -r..=r {
                for cdx in -r..=r {
                    let mut ssd: f64 = 0.0;
                    let mut count: u32 = 0;
                    let mut yy = y_lo;
                    while yy < y_hi {
                        let mut xx = x_lo;
                        while xx < x_hi {
                            let bx = xx + cdx;
                            let by = yy + cdy;
                            if bx < 0 || by < 0 || bx >= w || by >= h {
                                xx += ds;
                                continue;
                            }
                            let a_idx = (yy as usize) * (a.width as usize) + (xx as usize);
                            let b_idx = (by as usize) * (b.width as usize) + (bx as usize);
                            if !a.validity[a_idx] || !b.validity[b_idx] {
                                xx += ds;
                                continue;
                            }
                            let la = luma(
                                a.pixels[a_idx * 3],
                                a.pixels[a_idx * 3 + 1],
                                a.pixels[a_idx * 3 + 2],
                            );
                            let lb = luma(
                                b.pixels[b_idx * 3],
                                b.pixels[b_idx * 3 + 1],
                                b.pixels[b_idx * 3 + 2],
                            );
                            let d = (la - lb) as f64;
                            ssd += d * d;
                            count += 1;
                            xx += ds;
                        }
                        yy += ds;
                    }
                    if count >= options.min_overlap_per_tile {
                        let mean = ssd / (count.max(1) as f64);
                        let dist_sq = cdx * cdx + cdy * cdy;
                        let strictly_better = mean < best_ssd;
                        let tied_and_closer =
                            (mean - best_ssd).abs() < 1e-12 && dist_sq < best_dist_sq;
                        if strictly_better || tied_and_closer {
                            best_ssd = mean;
                            best_dx = cdx;
                            best_dy = cdy;
                            best_count = count;
                            best_dist_sq = dist_sq;
                        }
                    }
                }
            }

            let tile_idx = (ty * gc + tx) as usize;
            if best_count > 0 {
                // Convention matches refine_pair: returned dx = -best_dx
                // because best_dx > 0 means b's content is at +dx from a,
                // which means b should shift -dx to align.
                offsets[tile_idx] = (-best_dx as f32, -best_dy as f32);
                valid[tile_idx] = true;
            }
        }
    }

    // Median-filter the tile grid (3×3) to suppress spurious
    // single-tile minima from low-texture regions. Replace each
    // valid tile's offset with the median of its 3×3 neighbourhood
    // (counting only valid neighbours).
    let raw = offsets.clone();
    let raw_valid = valid.clone();
    for ty in 0..gr {
        for tx in 0..gc {
            let tile_idx = (ty * gc + tx) as usize;
            if !raw_valid[tile_idx] {
                continue;
            }
            let mut dxs: Vec<f32> = Vec::with_capacity(9);
            let mut dys: Vec<f32> = Vec::with_capacity(9);
            for ddy in -1..=1i32 {
                for ddx in -1..=1i32 {
                    let nx = tx + ddx;
                    let ny = ty + ddy;
                    if nx < 0 || nx >= gc || ny < 0 || ny >= gr {
                        continue;
                    }
                    let nidx = (ny * gc + nx) as usize;
                    if raw_valid[nidx] {
                        dxs.push(raw[nidx].0);
                        dys.push(raw[nidx].1);
                    }
                }
            }
            dxs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            dys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            offsets[tile_idx] = (dxs[dxs.len() / 2], dys[dys.len() / 2]);
        }
    }

    Ok(LocalPairTiles {
        i,
        j,
        grid_cols: options.grid_cols,
        grid_rows: options.grid_rows,
        canvas_width: a.width,
        canvas_height: a.height,
        offsets,
        valid,
    })
}

/// Apply a per-tile offset grid by bilinear-translating each pixel
/// of `img` according to the bilinearly-interpolated tile offset
/// at its canvas position. Modifies `img` in place; pixels that
/// would source from outside the input or from invalid samples are
/// marked invalid.
pub fn apply_local_pair_tiles(img: &mut PanoImage, tiles: &LocalPairTiles) -> Result<(), PanoError> {
    if img.width != tiles.canvas_width || img.height != tiles.canvas_height {
        return Err(PanoError::Warp(format!(
            "apply_local_pair_tiles: image {}×{} doesn't match tile canvas {}×{}",
            img.width, img.height, tiles.canvas_width, tiles.canvas_height
        )));
    }
    let w = img.width as i32;
    let h = img.height as i32;
    let n_pixels = (img.width as usize) * (img.height as usize);
    let gc = tiles.grid_cols as i32;
    let gr = tiles.grid_rows as i32;
    let mut new_pixels = vec![0.0_f32; n_pixels * 3];
    let mut new_validity = bitvec::vec::BitVec::repeat(false, n_pixels);

    let sample_tile = |tx: i32, ty: i32| -> (f32, f32) {
        let tx_c = tx.clamp(0, gc - 1);
        let ty_c = ty.clamp(0, gr - 1);
        tiles.offsets[(ty_c * gc + tx_c) as usize]
    };

    for y in 0..h {
        for x in 0..w {
            // Fractional tile position: tile centre at (tx + 0.5, ty + 0.5)
            // in tile-grid coords corresponds to pixel ((tx + 0.5) * w / gc,
            // (ty + 0.5) * h / gr). Inverse: tx_f = x * gc / w - 0.5.
            let tx_f = (x as f32 + 0.5) * (gc as f32) / (w as f32) - 0.5;
            let ty_f = (y as f32 + 0.5) * (gr as f32) / (h as f32) - 0.5;
            let tx0 = tx_f.floor() as i32;
            let ty0 = ty_f.floor() as i32;
            let fx = tx_f - tx0 as f32;
            let fy = ty_f - ty0 as f32;
            let (d00x, d00y) = sample_tile(tx0, ty0);
            let (d01x, d01y) = sample_tile(tx0 + 1, ty0);
            let (d10x, d10y) = sample_tile(tx0, ty0 + 1);
            let (d11x, d11y) = sample_tile(tx0 + 1, ty0 + 1);
            let dx0 = d00x * (1.0 - fx) + d01x * fx;
            let dx1 = d10x * (1.0 - fx) + d11x * fx;
            let dx = dx0 * (1.0 - fy) + dx1 * fy;
            let dy0 = d00y * (1.0 - fx) + d01y * fx;
            let dy1 = d10y * (1.0 - fx) + d11y * fx;
            let dy = dy0 * (1.0 - fy) + dy1 * fy;

            // Bilinear-sample img at (x - dx, y - dy).
            let sx = (x as f32) - dx;
            let sy = (y as f32) - dy;
            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            let x1 = x0 + 1;
            let y1 = y0 + 1;
            if x0 < 0 || y0 < 0 || x1 >= w || y1 >= h {
                continue;
            }
            let fx_s = sx - x0 as f32;
            let fy_s = sy - y0 as f32;
            let i00 = (y0 as usize) * (img.width as usize) + (x0 as usize);
            let i01 = (y0 as usize) * (img.width as usize) + (x1 as usize);
            let i10 = (y1 as usize) * (img.width as usize) + (x0 as usize);
            let i11 = (y1 as usize) * (img.width as usize) + (x1 as usize);
            if !(img.validity[i00]
                && img.validity[i01]
                && img.validity[i10]
                && img.validity[i11])
            {
                continue;
            }
            let out_idx = (y as usize) * (img.width as usize) + (x as usize);
            for c in 0..3 {
                let v00 = img.pixels[i00 * 3 + c];
                let v01 = img.pixels[i01 * 3 + c];
                let v10 = img.pixels[i10 * 3 + c];
                let v11 = img.pixels[i11 * 3 + c];
                let v0 = v00 * (1.0 - fx_s) + v01 * fx_s;
                let v1 = v10 * (1.0 - fx_s) + v11 * fx_s;
                let v = v0 * (1.0 - fy_s) + v1 * fy_s;
                new_pixels[out_idx * 3 + c] = v;
            }
            new_validity.set(out_idx, true);
        }
    }

    img.pixels = new_pixels;
    img.validity = new_validity;
    Ok(())
}

/// Bilinear-interpolated rigid-translation in canvas space.
///
/// Sources pixel `(x - dx, y - dy)` for output pixel `(x, y)` so
/// that what was at `(x, y)` ends up at `(x + dx, y + dy)`. Pixels
/// pulling from outside the image are marked invalid.
fn bilinear_shift_in_place(img: &mut PanoImage, dx: f32, dy: f32) {
    let w = img.width as i32;
    let h = img.height as i32;
    let n_pixels = (img.width as usize) * (img.height as usize);
    let mut new_pixels = vec![0.0_f32; n_pixels * 3];
    let mut new_validity = bitvec::vec::BitVec::repeat(false, n_pixels);

    for y in 0..h {
        for x in 0..w {
            let sx = (x as f32) - dx;
            let sy = (y as f32) - dy;
            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            let x1 = x0 + 1;
            let y1 = y0 + 1;
            if x0 < 0 || y0 < 0 || x1 >= w || y1 >= h {
                continue;
            }
            let fx = sx - x0 as f32;
            let fy = sy - y0 as f32;
            let i00 = (y0 as usize) * (img.width as usize) + (x0 as usize);
            let i01 = (y0 as usize) * (img.width as usize) + (x1 as usize);
            let i10 = (y1 as usize) * (img.width as usize) + (x0 as usize);
            let i11 = (y1 as usize) * (img.width as usize) + (x1 as usize);
            // All four source samples must be valid. Otherwise we
            // could blend valid + invalid into a partial-validity
            // pixel, which downstream blenders mishandle.
            if !(img.validity[i00]
                && img.validity[i01]
                && img.validity[i10]
                && img.validity[i11])
            {
                continue;
            }
            let out_idx = (y as usize) * (img.width as usize) + (x as usize);
            for c in 0..3 {
                let v00 = img.pixels[i00 * 3 + c];
                let v01 = img.pixels[i01 * 3 + c];
                let v10 = img.pixels[i10 * 3 + c];
                let v11 = img.pixels[i11 * 3 + c];
                let v0 = v00 * (1.0 - fx) + v01 * fx;
                let v1 = v10 * (1.0 - fx) + v11 * fx;
                let v = v0 * (1.0 - fy) + v1 * fy;
                new_pixels[out_idx * 3 + c] = v;
            }
            new_validity.set(out_idx, true);
        }
    }

    img.pixels = new_pixels;
    img.validity = new_validity;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;

    fn solid(w: u32, h: u32, rgb: [f32; 3]) -> PanoImage {
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for px in 0..(w * h) as usize {
            img.pixels[px * 3] = rgb[0];
            img.pixels[px * 3 + 1] = rgb[1];
            img.pixels[px * 3 + 2] = rgb[2];
        }
        img
    }

    /// Two identical images → minimum-SSD offset is (0, 0).
    #[test]
    fn refine_pair_identical_images_returns_zero_offset() {
        let a = solid(64, 32, [0.5, 0.5, 0.5]);
        let b = a.clone();
        let opts = PairOffsetOptions {
            coarse_search_radius_px: 4,
            coarse_downsample: 2,
            search_radius_px: 2,
            downsample: 1,
            min_overlap_px: 16,
        };
        let res = refine_pair(&a, &b, 0, 1, opts);
        assert_eq!(res.dx, 0.0);
        assert_eq!(res.dy, 0.0);
    }

    /// Image b is image a shifted right by 2 px. The SSD-min offset
    /// should report dx ≈ ±2 (sign is a convention; magnitude is
    /// what matters). A monotonic horizontal-gradient pattern gives
    /// a unique global minimum so the search can't get fooled by
    /// the periodic-pattern aliases that a stripe pattern produces.
    #[test]
    fn refine_pair_recovers_pure_translation() {
        let w = 64u32;
        let h = 16u32;
        let mut a = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        // Smooth, monotonic, non-periodic gradient with horizontal
        // banding — SSD has a single global minimum at the true
        // offset.
        for y in 0..h {
            for x in 0..w {
                let v = (x as f32 / (w as f32 - 1.0)) * 0.7
                    + (y as f32 / (h as f32 - 1.0)) * 0.2;
                let idx = (y * w + x) as usize;
                a.pixels[idx * 3] = v;
                a.pixels[idx * 3 + 1] = v;
                a.pixels[idx * 3 + 2] = v;
            }
        }
        // Build b as a shifted right by 2 px.
        let mut b = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for y in 0..h {
            for x in 2..w {
                let src_idx = (y * w + (x - 2)) as usize;
                let dst_idx = (y * w + x) as usize;
                b.pixels[dst_idx * 3] = a.pixels[src_idx * 3];
                b.pixels[dst_idx * 3 + 1] = a.pixels[src_idx * 3 + 1];
                b.pixels[dst_idx * 3 + 2] = a.pixels[src_idx * 3 + 2];
            }
            // Mark the un-shifted left columns invalid so they don't
            // pollute the SSD.
            for x in 0..2 {
                let idx = (y * w + x) as usize;
                b.validity.set(idx, false);
            }
        }
        let opts = PairOffsetOptions {
            coarse_search_radius_px: 4,
            coarse_downsample: 1,
            search_radius_px: 2,
            downsample: 1,
            min_overlap_px: 16,
        };
        let res = refine_pair(&a, &b, 0, 1, opts);
        assert_eq!(res.dx.abs(), 2.0, "got dx={}", res.dx);
        assert_eq!(res.dy, 0.0);
    }

    #[test]
    fn chain_pair_offsets_accumulates_along_chain() {
        let pairs = vec![
            PairOffset {
                i: 0,
                j: 1,
                dx: 1.0,
                dy: 2.0,
                n_overlap_px: 100,
            },
            PairOffset {
                i: 1,
                j: 2,
                dx: 3.0,
                dy: -1.0,
                n_overlap_px: 100,
            },
        ];
        let per_image = chain_pair_offsets_to_per_image(3, &pairs);
        assert_eq!(per_image[0], (0.0, 0.0));
        assert_eq!(per_image[1], (1.0, 2.0));
        assert_eq!(per_image[2], (4.0, 1.0));
    }

    #[test]
    fn apply_per_image_canvas_offset_translates_pixels() {
        let mut img = PanoImage::new(8, 4, ColorSpace::rec2020_d65_linear());
        // Mark a 2×2 block at (1..3, 1..3) red.
        for y in 1..3 {
            for x in 1..3 {
                let idx = (y * 8 + x) as usize;
                img.pixels[idx * 3] = 1.0;
                img.pixels[idx * 3 + 1] = 0.0;
                img.pixels[idx * 3 + 2] = 0.0;
            }
        }
        let mut imgs = vec![img];
        // Shift by +2, +1 — content originally at (1..3, 1..3) should
        // now be at (3..5, 2..4). The two regions are disjoint, so
        // we can assert "old location empty, new location red"
        // unambiguously.
        apply_per_image_canvas_offset(&mut imgs, &[(2.0, 1.0)]).expect("apply");
        for y in 2..4 {
            for x in 3..5 {
                let idx = (y * 8 + x) as usize;
                assert!(
                    (imgs[0].pixels[idx * 3] - 1.0).abs() < 1e-6,
                    "expected red at ({x},{y}) after shift (+2,+1), got {}",
                    imgs[0].pixels[idx * 3]
                );
            }
        }
        // Original red block — disjoint from the new red region —
        // should now read 0.0 (pulls from `(x-2, y-1)` which was
        // 0.0 in the source).
        for y in 1..3 {
            for x in 1..3 {
                let idx = (y * 8 + x) as usize;
                assert!(
                    imgs[0].pixels[idx * 3].abs() < 1e-6,
                    "expected 0.0 at old red position ({x},{y}), got {}",
                    imgs[0].pixels[idx * 3]
                );
            }
        }
    }

    #[test]
    fn apply_per_image_canvas_offset_size_mismatch_errors() {
        let mut imgs = vec![PanoImage::new(8, 4, ColorSpace::rec2020_d65_linear())];
        assert!(apply_per_image_canvas_offset(&mut imgs, &[]).is_err());
    }

    /// Two identical images → all tile offsets should be ≈ (0, 0).
    #[test]
    fn local_tiles_identical_images_zero_offsets() {
        let a = solid(64, 32, [0.5, 0.5, 0.5]);
        let b = a.clone();
        let opts = LocalPairOptions {
            grid_cols: 4,
            grid_rows: 4,
            search_radius_px: 2,
            downsample: 1,
            min_overlap_per_tile: 4,
        };
        let tiles = compute_pair_offset_tiles(&a, &b, 0, 1, opts).expect("compute");
        for &(dx, dy) in tiles.offsets.iter() {
            assert_eq!(dx, 0.0, "tile dx should be 0 on uniform image, got {}", dx);
            assert_eq!(dy, 0.0, "tile dy should be 0 on uniform image, got {}", dy);
        }
    }

    /// Spatially-adjacent images get linked, far-apart ones don't.
    /// Build 4 images in a 2×2 grid where image 0 overlaps with 1
    /// and 2 (but not 3 directly), image 3 overlaps with 1 and 2.
    /// Spanning tree should connect each image via its true
    /// neighbour, not via file-order.
    #[test]
    fn spanning_tree_uses_validity_overlap_not_file_order() {
        let w = 16u32;
        let h = 16u32;
        // 4 images on a 16×16 canvas, each with a different
        // 12×12-pixel valid region positioned so:
        //   image 0: top-left  (cols 0..12, rows 0..12)
        //   image 1: top-right (cols 4..16, rows 0..12)
        //   image 2: bot-left  (cols 0..12, rows 4..16)
        //   image 3: bot-right (cols 4..16, rows 4..16)
        // Overlaps: 0-1 ≈ 8 cols × 12 rows = 96, similarly 0-2,
        // 1-3, 2-3. Cross-corner pairs 0-3 and 1-2 share a smaller
        // 8×8 = 64-pixel patch.
        let imgs: Vec<PanoImage> = [
            (0..12u32, 0..12u32),
            (4..16, 0..12),
            (0..12, 4..16),
            (4..16, 4..16),
        ]
        .iter()
        .map(|(xr, yr)| {
            let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
            for y in 0..h {
                for x in 0..w {
                    let idx = (y * w + x) as usize;
                    if !xr.contains(&x) || !yr.contains(&y) {
                        img.validity.set(idx, false);
                    }
                }
            }
            img
        })
        .collect();

        // Sanity: image 0 - image 1 has more overlap than 0 - 3.
        let c01 = validity_overlap_count(&imgs[0], &imgs[1]);
        let c03 = validity_overlap_count(&imgs[0], &imgs[3]);
        assert!(c01 > c03, "expected 0-1 ({c01}) > 0-3 ({c03})");

        let edges = build_overlap_spanning_tree(&imgs, 1);
        // 4 images → 3 edges in any spanning tree.
        assert_eq!(edges.len(), 3);

        // The tree must connect every image (BFS from 0 visits all).
        let mut visited = [false; 4];
        visited[0] = true;
        for (i, j) in &edges {
            assert!(
                visited[*i],
                "edge ({i},{j}) inserted before {i} was visited \
                 — chain order broken"
            );
            visited[*j] = true;
        }
        for (idx, v) in visited.iter().enumerate() {
            assert!(*v, "image {idx} not in spanning tree");
        }
    }

    /// Minimum-overlap threshold filters out pairs that don't
    /// share enough validity to be reliable.
    #[test]
    fn spanning_tree_skips_below_threshold_pairs() {
        // 3 disjoint images. Set a high threshold; expect 0 edges.
        let imgs: Vec<PanoImage> = (0..3)
            .map(|i| {
                let mut img =
                    PanoImage::new(8, 8, ColorSpace::rec2020_d65_linear());
                // Mark only one specific pixel valid per image, all
                // different positions so no overlap.
                for px in 0..64 {
                    img.validity.set(px, false);
                }
                img.validity.set(i, true);
                img
            })
            .collect();
        let edges = build_overlap_spanning_tree(&imgs, 1);
        assert_eq!(edges.len(), 0, "no overlap → no tree edges");
    }

    /// `apply_local_pair_tiles` with a uniform `(2, 1)` offset grid
    /// should produce the same result as `bilinear_shift_in_place`
    /// with the same uniform shift.
    #[test]
    fn apply_local_pair_tiles_uniform_grid_matches_global_shift() {
        let mut img = PanoImage::new(8, 4, ColorSpace::rec2020_d65_linear());
        // Mark a 2×2 block at (1..3, 1..3) red.
        for y in 1..3 {
            for x in 1..3 {
                let idx = (y * 8 + x) as usize;
                img.pixels[idx * 3] = 1.0;
                img.pixels[idx * 3 + 1] = 0.0;
                img.pixels[idx * 3 + 2] = 0.0;
            }
        }
        let mut img_local = img.clone();
        let mut img_global = img.clone();
        // Global shift of (+2, +1).
        bilinear_shift_in_place(&mut img_global, 2.0, 1.0);
        // Local-tile equivalent: 4×4 grid all (2, 1).
        let tiles = LocalPairTiles {
            i: 0,
            j: 1,
            grid_cols: 4,
            grid_rows: 4,
            canvas_width: 8,
            canvas_height: 4,
            offsets: vec![(2.0, 1.0); 16],
            valid: vec![true; 16],
        };
        apply_local_pair_tiles(&mut img_local, &tiles).expect("apply");
        // The two should match pixel-for-pixel.
        for y in 0..4u32 {
            for x in 0..8u32 {
                let idx = (y * 8 + x) as usize;
                if img_global.validity[idx] != img_local.validity[idx] {
                    panic!(
                        "validity mismatch at ({x},{y}): global={} local={}",
                        img_global.validity[idx], img_local.validity[idx]
                    );
                }
                for c in 0..3 {
                    let g = img_global.pixels[idx * 3 + c];
                    let l = img_local.pixels[idx * 3 + c];
                    assert!(
                        (g - l).abs() < 1e-5,
                        "pixel ({x},{y}) ch {c}: global={} local={}",
                        g,
                        l
                    );
                }
            }
        }
    }
}
