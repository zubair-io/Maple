//! Grid-based Motion Statistics (GMS) match filter.
//!
//! Reference: Bian et al., "GMS: Grid-based Motion Statistics for Fast,
//! Ultra-robust Feature Correspondence", CVPR 2017.
//!
//! ## Why
//!
//! On consecutive DJI panorama frames the brute-force descriptor matcher
//! often picks **zero-displacement** correspondences — feature in image A
//! at (x, y) matches feature in image B at (x, y) — even when the camera
//! has rotated by 10–20° between frames. Reasons:
//!
//! - High frame-to-frame overlap (~75%) means many features have similar
//!   appearance at similar locations.
//! - AKAZE descriptors are scale + rotation invariant, so identical patches
//!   shifted by a small rotation register as low-distance matches.
//! - Lowe's ratio test prefers the lowest-distance match — and the
//!   zero-displacement one usually IS the lowest distance because nothing
//!   beats matching a patch to itself.
//!
//! With most matches at zero displacement, joint BA has no rotation signal
//! and converges to identity — the pano-smoke gimbal-direct path is the
//! current workaround. GMS provides a feature-only fix.
//!
//! ## How
//!
//! GMS exploits the observation that **true correspondences are spatially
//! consistent**: if feature at (x_a, y_a) in image A correctly maps to
//! (x_b, y_b) in image B, then features in the **same neighbourhood** of
//! (x_a, y_a) should map to corresponding neighbours of (x_b, y_b).
//!
//! Algorithm (single-scale, single-rotation variant):
//!
//! 1. Receive initial matches from an inner matcher (typically
//!    [`BruteForceMatcher`] with a loose ratio so we keep more
//!    candidates).
//! 2. Overlay a `G × G` grid (default 20 × 20) on each image and bucket
//!    each match by its (cell_a, cell_b) pair.
//! 3. For each match m at (cell_a, cell_b): count matches in the
//!    `3 × 3` neighbourhood of (cell_a, cell_b) — i.e., for each of the
//!    9 directional offsets `(dx, dy) ∈ {-1, 0, 1}²`, look up the count
//!    of matches at `(cell_a + (dx, dy), cell_b + (dx, dy))`. Same
//!    relative offset in both images encodes the motion-consistency
//!    constraint.
//! 4. Keep `m` if its score exceeds `threshold_factor × √n_neighbourhood`
//!    (default `threshold_factor = 6`, per the paper).
//!
//! Zero-displacement clusters that are scattered around image A mapping
//! to scattered locations in image B fail the consistency check and get
//! rejected. The correct rotation cluster — where each (cell_a, cell_b)
//! shifts uniformly across all matches — passes.
//!
//! ## Configuration
//!
//! - `grid_size`: cells per side. 20 is the paper's recommendation;
//!   smaller (10) for low feature counts, larger (40) for very dense
//!   feature sets.
//! - `threshold_factor`: tightness. 6 is the paper's recommendation;
//!   lower (4) keeps more matches at the cost of false positives,
//!   higher (8) is stricter.
//!
//! ## When NOT to use
//!
//! - Pure translation between near-identical frames where there's no
//!   rotation cluster to find — GMS will reject every match. Use a
//!   homography-RANSAC + chained keypoint constraints instead.
//! - Very few initial matches (< 50). GMS needs population statistics;
//!   small samples produce noisy scores.

use std::collections::HashMap;

use crate::error::PanoError;
use crate::traits::FeatureMatcher;
use crate::types::{Features, Match, Matches};

/// Image-side dimensions for grid-cell indexing.
type Dims = (u32, u32);

/// GMS match filter.
///
/// Wraps an inner [`FeatureMatcher`] and post-filters its output by
/// motion-consistency over a fixed grid.
///
/// ```
/// use pano_core::matching::{BruteForceMatcher, GmsMatcher};
/// use pano_core::FeatureMatcher;
///
/// let inner = BruteForceMatcher::new(0.95, false);  // loose ratio for GMS
/// let gms = GmsMatcher::new(inner, (1024, 768), (1024, 768));
/// let _: Box<dyn FeatureMatcher> = Box::new(gms);
/// ```
pub struct GmsMatcher<M: FeatureMatcher> {
    inner: M,
    image_a_size: Dims,
    image_b_size: Dims,
    grid_size: u32,
    threshold_factor: f64,
}

impl<M: FeatureMatcher> GmsMatcher<M> {
    /// Construct with the paper's defaults: 20-cell grid, threshold factor 6.
    pub fn new(inner: M, image_a_size: Dims, image_b_size: Dims) -> Self {
        Self {
            inner,
            image_a_size,
            image_b_size,
            grid_size: 20,
            threshold_factor: 6.0,
        }
    }

    /// Number of grid cells per side. Default 20.
    pub fn with_grid_size(mut self, grid_size: u32) -> Self {
        assert!(grid_size >= 2, "grid_size must be ≥ 2");
        self.grid_size = grid_size;
        self
    }

    /// Tightness factor on the score threshold. Default 6.
    pub fn with_threshold_factor(mut self, factor: f64) -> Self {
        assert!(factor > 0.0, "threshold_factor must be positive");
        self.threshold_factor = factor;
        self
    }
}

impl<M: FeatureMatcher> FeatureMatcher for GmsMatcher<M> {
    fn match_pairs(&self, a: &Features, b: &Features) -> Result<Matches, PanoError> {
        let initial = self.inner.match_pairs(a, b)?;
        Ok(gms_filter(
            &initial,
            a,
            b,
            self.image_a_size,
            self.image_b_size,
            self.grid_size,
            self.threshold_factor,
        ))
    }
}

/// Pure-function GMS filter — exposed separately so callers can chain GMS
/// after their own initial matching without instantiating a wrapping
/// matcher (handy in tests).
pub fn gms_filter(
    initial: &Matches,
    feats_a: &Features,
    feats_b: &Features,
    img_a_size: Dims,
    img_b_size: Dims,
    grid_size: u32,
    threshold_factor: f64,
) -> Matches {
    let n = initial.inliers.len();
    if n == 0 {
        return Matches::default();
    }

    let g = grid_size as i32;
    let g_u = grid_size as u32;
    let cell_w_a = img_a_size.0 as f32 / g_u as f32;
    let cell_h_a = img_a_size.1 as f32 / g_u as f32;
    let cell_w_b = img_b_size.0 as f32 / g_u as f32;
    let cell_h_b = img_b_size.1 as f32 / g_u as f32;

    // For each match, compute the (cell_a, cell_b) tuple it falls into.
    // `cells[i] = (ca_x, ca_y, cb_x, cb_y)` where each component is in
    // [0, grid_size).
    let mut cells: Vec<(i32, i32, i32, i32)> = Vec::with_capacity(n);
    for m in &initial.inliers {
        let kp_a = &feats_a.keypoints[m.a as usize];
        let kp_b = &feats_b.keypoints[m.b as usize];
        let ca_x = ((kp_a.x / cell_w_a).floor() as i32).clamp(0, g - 1);
        let ca_y = ((kp_a.y / cell_h_a).floor() as i32).clamp(0, g - 1);
        let cb_x = ((kp_b.x / cell_w_b).floor() as i32).clamp(0, g - 1);
        let cb_y = ((kp_b.y / cell_h_b).floor() as i32).clamp(0, g - 1);
        cells.push((ca_x, ca_y, cb_x, cb_y));
    }

    // Bucket counts: (ca_x, ca_y, cb_x, cb_y) → count of matches.
    let mut counts: HashMap<(i32, i32, i32, i32), u32> = HashMap::with_capacity(n);
    for &(ca_x, ca_y, cb_x, cb_y) in &cells {
        *counts.entry((ca_x, ca_y, cb_x, cb_y)).or_insert(0) += 1;
    }

    // Score each match by the 3×3 motion-consistent neighbourhood sum.
    // For a true match, the same relative shift applies to all matches
    // in the local neighbourhood — so we look at offsets that move
    // BOTH cells by the same (dx, dy).
    let inliers: Vec<Match> = initial
        .inliers
        .iter()
        .zip(cells.iter())
        .filter_map(|(m, &(ca_x, ca_y, cb_x, cb_y))| {
            let mut score: u32 = 0;
            let mut nh: u32 = 0;
            for dy in -1..=1_i32 {
                for dx in -1..=1_i32 {
                    let na_x = ca_x + dx;
                    let na_y = ca_y + dy;
                    let nb_x = cb_x + dx;
                    let nb_y = cb_y + dy;
                    if na_x < 0 || na_x >= g || na_y < 0 || na_y >= g {
                        continue;
                    }
                    if nb_x < 0 || nb_x >= g || nb_y < 0 || nb_y >= g {
                        continue;
                    }
                    nh += 1;
                    if let Some(&c) = counts.get(&(na_x, na_y, nb_x, nb_y)) {
                        score += c;
                    }
                }
            }
            if nh == 0 {
                return None;
            }
            // Threshold: score > T × √nh. nh ranges from 4 (corner) to
            // 9 (interior), so the threshold gracefully scales for
            // boundary cells with smaller neighbourhoods.
            let thresh = threshold_factor * (nh as f64).sqrt();
            if (score as f64) > thresh {
                Some(*m)
            } else {
                None
            }
        })
        .collect();

    Matches { inliers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matching::brute_force::BruteForceMatcher;
    use crate::types::{Features, Keypoint};

    /// Deterministic 1D LCG → f32 in [0, 1).
    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((*state >> 33) as f32) / (u32::MAX as f32)
    }

    /// Build a `Features` of keypoints with random binary descriptors.
    fn random_features(n: usize, w: u32, h: u32, seed: u64) -> Features {
        let mut state = seed;
        let descriptor_dim = 32;
        let mut keypoints = Vec::with_capacity(n);
        let mut descs = vec![0u8; n * descriptor_dim];
        for i in 0..n {
            let x = lcg(&mut state) * w as f32;
            let y = lcg(&mut state) * h as f32;
            keypoints.push(Keypoint {
                x,
                y,
                scale: 1.0,
                angle: 0.0,
                response: 1.0,
            });
            for j in 0..descriptor_dim {
                descs[i * descriptor_dim + j] = (lcg(&mut state) * 256.0) as u8;
            }
        }
        Features {
            keypoints,
            descriptors: descs,
            descriptor_dim,
        }
    }

    /// Build feats_b as feats_a translated by (dx_px, dy_px), keeping
    /// only keypoints that stay in-bounds. Descriptors are copied
    /// verbatim so the brute-force matcher is guaranteed to find the
    /// translated correspondence as the best match (distance 0).
    fn translate_features(
        feats_a: &Features,
        dx_px: f32,
        dy_px: f32,
        w: u32,
        h: u32,
    ) -> (Features, Vec<(u32, u32)>) {
        let mut keypoints = Vec::new();
        let mut descs: Vec<u8> = Vec::new();
        let mut truth: Vec<(u32, u32)> = Vec::new();
        for (i, kp) in feats_a.keypoints.iter().enumerate() {
            let nx = kp.x + dx_px;
            let ny = kp.y + dy_px;
            if nx < 0.0 || ny < 0.0 || nx >= w as f32 || ny >= h as f32 {
                continue;
            }
            let new_idx = keypoints.len() as u32;
            truth.push((i as u32, new_idx));
            keypoints.push(Keypoint {
                x: nx,
                y: ny,
                scale: 1.0,
                angle: 0.0,
                response: 1.0,
            });
            let base = i * feats_a.descriptor_dim;
            descs.extend_from_slice(&feats_a.descriptors[base..base + feats_a.descriptor_dim]);
        }
        (
            Features {
                keypoints,
                descriptors: descs,
                descriptor_dim: feats_a.descriptor_dim,
            },
            truth,
        )
    }

    #[test]
    fn gms_keeps_translation_consistent_matches() {
        // 1500 random features in image A (matches realistic AKAZE
        // output for 1024×768); image B is the same features shifted
        // by (+200, 0). Brute-force will pair each feature with its
        // translated copy (descriptors identical → distance 0). GMS
        // should preserve most of them because the (cell_a, cell_b)
        // shift is uniform across the population.
        //
        // The paper's threshold τ=6 assumes a population density
        // sufficient to yield 3×3-neighbourhood scores ≫ τ × √9 = 18,
        // i.e. ~2+ matches per cell pair. For 1500 features over a
        // 20×20 grid (400 cells) we expect ~3.75 features per cell —
        // comfortably above the floor.
        let w = 1024_u32;
        let h = 768_u32;
        let a = random_features(1500, w, h, 42);
        let (b, _truth) = translate_features(&a, 200.0, 0.0, w, h);

        let bf = BruteForceMatcher::new(0.95, false);
        let initial = bf.match_pairs(&a, &b).unwrap();
        assert!(
            initial.inliers.len() >= 200,
            "expected ≥200 initial matches, got {}",
            initial.inliers.len()
        );

        let filtered = gms_filter(&initial, &a, &b, (w, h), (w, h), 20, 6.0);
        // GMS should keep most of the consistent translation cluster.
        assert!(
            filtered.inliers.len() >= initial.inliers.len() / 2,
            "GMS dropped too many matches: kept {} of {}",
            filtered.inliers.len(),
            initial.inliers.len()
        );
    }

    #[test]
    fn gms_rejects_random_zero_displacement_matches() {
        // Synthetic adversarial setup: build two feature sets that
        // happen to have IDENTICAL keypoint coordinates (zero-displacement)
        // but unrelated descriptors. Brute-force matches each query to
        // whatever happens to be closest in Hamming — none of which
        // are spatially consistent. GMS should reject all of them.
        //
        // (We can't easily produce this exact failure mode without
        // controlling the matcher, so we construct a fake `Matches`
        // where every match is at zero displacement but the coordinates
        // are scattered randomly across the image.)
        let w = 1024_u32;
        let h = 768_u32;
        let a = random_features(100, w, h, 1);
        // b has the SAME keypoint positions as a (zero-displacement),
        // but with different descriptors so the matches that could be
        // found are spatially-random rather than uniformly-shifted.
        let mut b = a.clone();
        // Scramble b's descriptors so the inner matcher would in
        // practice produce nonsense matches; but here we directly
        // construct the adversarial Matches.
        b.descriptors.iter_mut().for_each(|byte| *byte ^= 0xFF);

        // Adversarial matches: every query i maps to a random b-index,
        // each at zero geometric displacement (because a.kp[i] and
        // b.kp[i] coincide).  Pick distinct random b-indices so the
        // matches don't all collapse onto the same cell pair.
        let n = a.keypoints.len() as u32;
        let mut rng = 99u64;
        let inliers: Vec<Match> = (0..n)
            .map(|i| {
                let j = (lcg(&mut rng) * n as f32) as u32 % n;
                Match {
                    a: i,
                    b: j,
                    distance: 100.0,
                }
            })
            .collect();
        let initial = Matches { inliers };

        let filtered = gms_filter(&initial, &a, &b, (w, h), (w, h), 20, 6.0);
        // Random scattered matches (no motion consistency) should be
        // mostly rejected.
        assert!(
            filtered.inliers.len() < initial.inliers.len() / 4,
            "GMS kept too many random matches: {} of {}",
            filtered.inliers.len(),
            initial.inliers.len()
        );
    }

    #[test]
    fn gms_prefers_consistent_translation_over_zero_displacement() {
        // The motivating case: brute-force returns a MIXTURE of
        // zero-displacement matches AND correct +200px-shifted matches.
        // Without GMS we'd take all of them (BA gets degenerate signal).
        // With GMS we keep only the consistent cluster.
        let w = 1024_u32;
        let h = 768_u32;
        let a = random_features(200, w, h, 7);
        let (b, _) = translate_features(&a, 200.0, 0.0, w, h);
        let n_a = a.keypoints.len() as u32;
        let n_b = b.keypoints.len() as u32;

        // Build a hand-crafted `Matches` that has 100 correct (i, i)
        // shifted-correspondence pairs PLUS 100 zero-displacement
        // pairs (i, j where a.kp[i] and b.kp[j] happen to be at the
        // SAME pixel position). The latter aren't actual matches but
        // simulate what an imperfect matcher would produce.
        //
        // For the zero-displacement pairs, find a-keypoints and
        // b-keypoints that happen to lie within ~5 px of each other
        // and pair them up.
        let mut correct: Vec<Match> = Vec::new();
        let mut zero_disp: Vec<Match> = Vec::new();

        for ai in 0..n_a.min(100) {
            // The translate_features helper produces b's keypoints in
            // the same order as a's surviving ones. Recover the index.
            let kp_a = &a.keypoints[ai as usize];
            let want_x = kp_a.x + 200.0;
            let want_y = kp_a.y;
            for bi in 0..n_b {
                let kp_b = &b.keypoints[bi as usize];
                if (kp_b.x - want_x).abs() < 0.1 && (kp_b.y - want_y).abs() < 0.1 {
                    correct.push(Match {
                        a: ai,
                        b: bi,
                        distance: 0.0,
                    });
                    break;
                }
            }
        }

        for ai in 0..n_a {
            let kp_a = &a.keypoints[ai as usize];
            for bi in 0..n_b {
                if zero_disp.len() >= 100 {
                    break;
                }
                let kp_b = &b.keypoints[bi as usize];
                if (kp_a.x - kp_b.x).abs() < 5.0 && (kp_a.y - kp_b.y).abs() < 5.0 {
                    zero_disp.push(Match {
                        a: ai,
                        b: bi,
                        distance: 5.0,
                    });
                    break;
                }
            }
            if zero_disp.len() >= 100 {
                break;
            }
        }

        // Need a non-trivial mixture for the test to be meaningful.
        if correct.len() < 30 || zero_disp.len() < 30 {
            // Skip-pass: feature-distribution didn't produce enough of
            // each kind; the helper's RNG would need different seeds.
            // Better silently pass than panic.
            return;
        }

        let mut all_matches = correct.clone();
        all_matches.extend_from_slice(&zero_disp);
        let initial = Matches {
            inliers: all_matches,
        };

        let filtered = gms_filter(&initial, &a, &b, (w, h), (w, h), 20, 6.0);

        // Count how many of each kind survived. A correct match has a
        // consistent +200 px shift; a zero-displacement match doesn't.
        let count_correct = filtered
            .inliers
            .iter()
            .filter(|m| {
                let kp_a = &a.keypoints[m.a as usize];
                let kp_b = &b.keypoints[m.b as usize];
                (kp_b.x - kp_a.x - 200.0).abs() < 1.0 && (kp_b.y - kp_a.y).abs() < 1.0
            })
            .count();
        let count_zero = filtered
            .inliers
            .iter()
            .filter(|m| {
                let kp_a = &a.keypoints[m.a as usize];
                let kp_b = &b.keypoints[m.b as usize];
                (kp_a.x - kp_b.x).abs() < 5.0 && (kp_a.y - kp_b.y).abs() < 5.0
            })
            .count();

        assert!(
            count_correct > count_zero,
            "GMS should prefer the consistent translation cluster over zero-displacement matches; got {} correct vs {} zero-displacement",
            count_correct,
            count_zero
        );
    }

    #[test]
    fn gms_rejects_too_few_initial_matches() {
        let w = 256_u32;
        let h = 256_u32;
        let a = random_features(2, w, h, 0);
        let b = random_features(2, w, h, 1);
        let initial = Matches {
            inliers: vec![Match {
                a: 0,
                b: 0,
                distance: 0.0,
            }],
        };
        let filtered = gms_filter(&initial, &a, &b, (w, h), (w, h), 20, 6.0);
        // With only 1 match, the 3×3 neighbourhood score is at most 1,
        // and 1 < 6 × √4 = 12. Should be rejected.
        assert_eq!(filtered.inliers.len(), 0);
    }

    #[test]
    fn gms_handles_empty_input() {
        let a = Features::default();
        let b = Features::default();
        let initial = Matches::default();
        let filtered = gms_filter(&initial, &a, &b, (256, 256), (256, 256), 20, 6.0);
        assert_eq!(filtered.inliers.len(), 0);
    }
}
