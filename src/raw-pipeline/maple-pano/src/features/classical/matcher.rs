//! Mutual nearest-neighbour + ratio-test descriptor matching.
//!
//! A pair `(i, j)` is kept when `j` is `i`'s nearest descriptor in the
//! second set, `i` is `j`'s nearest in the first, and the nearest distance
//! is below `ratio` × the second-nearest. The second-nearest is taken only
//! among keypoints at least `distinct_px` away from the nearest one, so a
//! corner detected at two adjacent scales does not veto its own match.

use rayon::prelude::*;

use crate::features::FeatureSet;
use crate::matching::MlMatch;

/// Matcher tunables.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClassicalMatchOptions {
    /// Lowe ratio: nearest / second-nearest descriptor distance ceiling.
    pub ratio: f32,
    /// Minimum source-pixel separation of the second-nearest candidate.
    pub distinct_px: f32,
}

impl Default for ClassicalMatchOptions {
    fn default() -> Self {
        Self {
            ratio: 0.8,
            distinct_px: 4.0,
        }
    }
}

/// Distance between two unit descriptors from their dot product.
fn unit_distance(dot: f32) -> f32 {
    (2.0 - 2.0 * dot).max(0.0).sqrt()
}

/// Match two classical feature sets. Records carry source-pixel positions
/// and `score = 1 − nearest/second-nearest`, in descending score order.
pub fn match_classical(
    a: &FeatureSet,
    b: &FeatureSet,
    opts: &ClassicalMatchOptions,
) -> Vec<MlMatch> {
    if a.is_empty() || b.is_empty() || a.descriptor_dim != b.descriptor_dim {
        return Vec::new();
    }
    let nb = b.len();
    let similarity: Vec<f32> = (0..a.len())
        .into_par_iter()
        .flat_map_iter(|i| {
            let da = a.descriptor(i);
            (0..nb).map(move |j| da.iter().zip(b.descriptor(j)).map(|(x, y)| x * y).sum())
        })
        .collect();
    let argmax = |values: &mut dyn Iterator<Item = (usize, f32)>| {
        values.fold(None, |best: Option<(usize, f32)>, (k, v)| match best {
            Some((_, bv)) if bv >= v => best,
            _ => Some((k, v)),
        })
    };
    let backward: Vec<usize> = (0..nb)
        .into_par_iter()
        .map(|j| {
            argmax(&mut (0..a.len()).map(|i| (i, similarity[i * nb + j])))
                .map_or(usize::MAX, |(i, _)| i)
        })
        .collect();
    let distinct_sq = opts.distinct_px * opts.distinct_px;
    let mut matches: Vec<(usize, MlMatch)> = (0..a.len())
        .into_par_iter()
        .filter_map(|i| {
            let row = &similarity[i * nb..(i + 1) * nb];
            let (j, best) = argmax(&mut row.iter().copied().enumerate())?;
            if backward[j] != i {
                return None;
            }
            let kb = b.keypoints[j];
            let second = argmax(&mut row.iter().copied().enumerate().filter(|&(k, _)| {
                let o = b.keypoints[k];
                (o.x - kb.x).powi(2) + (o.y - kb.y).powi(2) >= distinct_sq
            }))
            .map_or(-1.0, |(_, v)| v);
            let (d1, d2) = (unit_distance(best), unit_distance(second));
            (d1 < opts.ratio * d2).then(|| {
                let ka = a.keypoints[i];
                (
                    i,
                    MlMatch {
                        x0: ka.x,
                        y0: ka.y,
                        x1: kb.x,
                        y1: kb.y,
                        score: 1.0 - d1 / d2,
                    },
                )
            })
        })
        .collect();
    matches.sort_by(|(ia, ma), (ib, mb)| mb.score.total_cmp(&ma.score).then(ia.cmp(ib)));
    matches.into_iter().map(|(_, m)| m).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::Keypoint;

    fn set(points: &[(f32, f32)], descriptors: &[[f32; 2]]) -> FeatureSet {
        FeatureSet {
            keypoints: points
                .iter()
                .map(|&(x, y)| Keypoint { x, y, score: 1.0 })
                .collect(),
            descriptors: descriptors.iter().flatten().copied().collect(),
            descriptor_dim: 2,
            norm_keypoints: Vec::new(),
        }
    }

    fn unit(deg: f32) -> [f32; 2] {
        let r = deg.to_radians();
        [r.cos(), r.sin()]
    }

    #[test]
    fn mutual_unambiguous_pairs_match_in_score_order() {
        let a = set(&[(1.0, 1.0), (50.0, 50.0)], &[unit(0.0), unit(90.0)]);
        let b = set(&[(2.0, 2.0), (60.0, 60.0)], &[unit(88.0), unit(1.0)]);
        let m = match_classical(&a, &b, &ClassicalMatchOptions::default());
        assert_eq!(m.len(), 2);
        assert!(m[0].score >= m[1].score);
        assert!(m.iter().any(|r| (r.x0, r.x1) == (1.0, 60.0)));
        assert!(m.iter().any(|r| (r.x0, r.x1) == (50.0, 2.0)));
    }

    #[test]
    fn ambiguous_nearest_neighbour_fails_the_ratio_test() {
        let a = set(&[(1.0, 1.0)], &[unit(0.0)]);
        let b = set(&[(10.0, 10.0), (90.0, 90.0)], &[unit(5.0), unit(-5.0)]);
        assert!(match_classical(&a, &b, &ClassicalMatchOptions::default()).is_empty());
    }

    #[test]
    fn same_place_duplicate_does_not_veto_the_match() {
        let a = set(&[(1.0, 1.0)], &[unit(0.0)]);
        let b = set(&[(10.0, 10.0), (11.0, 10.5)], &[unit(2.0), unit(4.0)]);
        let m = match_classical(&a, &b, &ClassicalMatchOptions::default());
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].x1, m[0].y1), (10.0, 10.0));
    }
}
