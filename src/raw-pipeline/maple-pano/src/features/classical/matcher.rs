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

/// Rows of the first set scored together; bounds the transient similarity
/// block to `ROW_BLOCK × |b|` instead of a full `|a| × |b|` matrix.
const ROW_BLOCK: usize = 64;

/// A first-set keypoint's nearest second-set descriptor (`j`, `best`) and
/// its spatially distinct runner-up similarity.
struct RowBest {
    i: usize,
    j: usize,
    best: f32,
    second: f32,
}

/// Forward nearest neighbours for `rows`, plus this block's best row per
/// second-set column (for the mutual check). Ties keep the lowest index.
fn match_block(
    a: &FeatureSet,
    b: &FeatureSet,
    rows: &[usize],
    distinct_sq: f32,
) -> (Vec<RowBest>, Vec<(f32, usize)>) {
    let initial = vec![(f32::NEG_INFINITY, usize::MAX); b.len()];
    rows.iter().fold(
        (Vec::with_capacity(rows.len()), initial),
        |(mut found, mut columns), &i| {
            let da = a.descriptor(i);
            let sims: Vec<f32> = (0..b.len())
                .map(|j| da.iter().zip(b.descriptor(j)).map(|(x, y)| x * y).sum())
                .collect();
            sims.iter().enumerate().for_each(|(j, &v)| {
                if v > columns[j].0 {
                    columns[j] = (v, i);
                }
            });
            let best = sims
                .iter()
                .enumerate()
                .fold(None, |acc: Option<(usize, f32)>, (j, &v)| match acc {
                    Some((_, bv)) if bv >= v => acc,
                    _ => Some((j, v)),
                });
            if let Some((j, best)) = best {
                let kb = b.keypoints[j];
                let second = sims
                    .iter()
                    .zip(&b.keypoints)
                    .filter(|(_, o)| (o.x - kb.x).powi(2) + (o.y - kb.y).powi(2) >= distinct_sq)
                    .map(|(&v, _)| v)
                    .fold(-1.0_f32, f32::max);
                found.push(RowBest { i, j, best, second });
            }
            (found, columns)
        },
    )
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
    let distinct_sq = opts.distinct_px * opts.distinct_px;
    let blocks: Vec<(Vec<RowBest>, Vec<(f32, usize)>)> = (0..a.len())
        .collect::<Vec<_>>()
        .par_chunks(ROW_BLOCK)
        .map(|rows| match_block(a, b, rows, distinct_sq))
        .collect();
    let column_best = blocks.iter().fold(
        vec![(f32::NEG_INFINITY, usize::MAX); b.len()],
        |acc, (_, block)| {
            acc.into_iter()
                .zip(block)
                .map(|(cur, &cand)| if cand.0 > cur.0 { cand } else { cur })
                .collect()
        },
    );
    let mut matches: Vec<(usize, MlMatch)> = blocks
        .into_iter()
        .flat_map(|(rows, _)| rows)
        .filter_map(|r| {
            let (d1, d2) = (unit_distance(r.best), unit_distance(r.second));
            (column_best[r.j].1 == r.i && d1 < opts.ratio * d2).then(|| {
                let (ka, kb) = (a.keypoints[r.i], b.keypoints[r.j]);
                (
                    r.i,
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
