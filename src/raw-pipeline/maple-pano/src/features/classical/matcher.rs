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

/// Second-set descriptors scored side by side: one SIMD-friendly lane each.
const LANES: usize = 16;

/// First-set rows scored against each loaded group of lanes.
const ROWS_AT_ONCE: usize = 4;

/// The second set's descriptors regrouped `LANES` at a time, dimension-major
/// within a group (`[group][k][lane]`), zero-padded past `|b|` (#6057). A
/// row's dot products against one group then accumulate one dimension at a
/// time into `LANES` independent sums, each in the same order as the scalar
/// `Σ_k a_k·b_k`, so the similarities are bit-identical to it while the
/// compiler vectorises across lanes.
struct LaneMajor {
    dim: usize,
    len: usize,
    groups: usize,
    values: Vec<f32>,
}

impl LaneMajor {
    fn new(b: &FeatureSet) -> Self {
        let (dim, groups) = (b.descriptor_dim, b.len().div_ceil(LANES));
        let mut values = vec![0.0_f32; groups * dim * LANES];
        for j in 0..b.len() {
            let (group, lane) = (j / LANES, j % LANES);
            for (k, &v) in b.descriptor(j).iter().enumerate() {
                values[(group * dim + k) * LANES + lane] = v;
            }
        }
        Self {
            dim,
            len: b.len(),
            groups,
            values,
        }
    }

    /// `sims[r][j] = rows[r] · b_j` for every row. Each group of lanes is
    /// scored against all the rows while it is still in L1.
    fn score(&self, rows: &[&[f32]], sims: &mut [Vec<f32>]) {
        let interleaved: Vec<Vec<[f32; ROWS_AT_ONCE]>> = rows
            .chunks(ROWS_AT_ONCE)
            .map(|chunk| {
                let mut by_dim = vec![[0.0_f32; ROWS_AT_ONCE]; self.dim];
                for (r, row) in chunk.iter().enumerate() {
                    for (k, &v) in row.iter().enumerate() {
                        by_dim[k][r] = v;
                    }
                }
                by_dim
            })
            .collect();
        for group in 0..self.groups {
            let block = &self.values[group * self.dim * LANES..(group + 1) * self.dim * LANES];
            let j0 = group * LANES;
            let n = LANES.min(self.len - j0);
            for (c, by_dim) in interleaved.iter().enumerate() {
                let acc = dot_group(block, by_dim);
                let chunk_rows = ROWS_AT_ONCE.min(rows.len() - c * ROWS_AT_ONCE);
                for (r, acc) in acc.iter().enumerate().take(chunk_rows) {
                    sims[c * ROWS_AT_ONCE + r][j0..j0 + n].copy_from_slice(&acc[..n]);
                }
            }
        }
    }
}

/// [`ROWS_AT_ONCE`] rows (dimension-major) dotted with one group of
/// [`LANES`] descriptors. Kept out of line: inlined into its caller the
/// accumulators no longer stay in vector registers.
#[inline(never)]
fn dot_group(block: &[f32], by_dim: &[[f32; ROWS_AT_ONCE]]) -> [[f32; LANES]; ROWS_AT_ONCE] {
    // Start from -0.0, the identity `f32: Sum` folds from.
    let mut acc = [[-0.0_f32; LANES]; ROWS_AT_ONCE];
    for (column, a) in block.chunks_exact(LANES).zip(by_dim) {
        let column: &[f32; LANES] = column.try_into().expect("LANES-wide chunk");
        for (acc, &a) in acc.iter_mut().zip(a) {
            for (s, &b) in acc.iter_mut().zip(column) {
                *s += a * b;
            }
        }
    }
    acc
}

/// A first-set keypoint's nearest second-set descriptor (`j`, `best`) and
/// its spatially distinct runner-up similarity.
struct RowBest {
    i: usize,
    j: usize,
    best: f32,
    second: f32,
}

/// A block's row results plus its best `(similarity, row)` per column.
type BlockBest = (Vec<RowBest>, Vec<(f32, usize)>);

/// Forward nearest neighbours for `rows`, plus this block's best row per
/// second-set column (for the mutual check). Ties keep the lowest index.
fn match_block(
    a: &FeatureSet,
    b: &FeatureSet,
    lanes: &LaneMajor,
    rows: &[usize],
    distinct_sq: f32,
) -> BlockBest {
    let mut columns = vec![(f32::NEG_INFINITY, usize::MAX); b.len()];
    let mut found = Vec::with_capacity(rows.len());
    let mut sims = vec![vec![0.0_f32; b.len()]; rows.len()];
    let descriptors: Vec<&[f32]> = rows.iter().map(|&i| a.descriptor(i)).collect();
    lanes.score(&descriptors, &mut sims);
    {
        for (&i, sims) in rows.iter().zip(&sims) {
            let scan = RowScan::of(sims, &mut columns, i);
            if let Some((j, best)) = scan.best {
                let kb = b.keypoints[j];
                let distinct = |o: &crate::features::Keypoint| {
                    (o.x - kb.x).powi(2) + (o.y - kb.y).powi(2) >= distinct_sq
                };
                let second = scan.second(&b.keypoints, distinct).unwrap_or_else(|| {
                    sims.iter()
                        .zip(&b.keypoints)
                        .filter(|(_, o)| distinct(o))
                        .map(|(&v, _)| v)
                        .fold(-1.0_f32, f32::max)
                });
                found.push(RowBest { i, j, best, second });
            }
        }
    }
    (found, columns)
}

/// Similarities kept per row for the runner-up search.
const TOP: usize = 4;

/// One pass over a row's similarities: the nearest neighbour (first index
/// on ties), the row's [`TOP`] largest similarities, and the column-best
/// update for the mutual check.
struct RowScan {
    best: Option<(usize, f32)>,
    /// Descending; only filled with finite values.
    top: [(f32, usize); TOP],
    any_nan: bool,
}

impl RowScan {
    fn of(sims: &[f32], columns: &mut [(f32, usize)], i: usize) -> Self {
        let mut best: Option<(usize, f32)> = None;
        let mut top = [(f32::NEG_INFINITY, usize::MAX); TOP];
        let mut any_nan = false;
        for (j, (&v, column)) in sims.iter().zip(columns.iter_mut()).enumerate() {
            if v > column.0 {
                *column = (v, i);
            }
            best = match best {
                Some((_, bv)) if bv >= v => best,
                _ => Some((j, v)),
            };
            any_nan |= v.is_nan();
            if v > top[TOP - 1].0 {
                let at = top.partition_point(|&(t, _)| t >= v);
                top.copy_within(at..TOP - 1, at + 1);
                top[at] = (v, j);
            }
        }
        Self { best, top, any_nan }
    }

    /// The largest similarity whose keypoint passes `distinct`, floored at
    /// -1 like the full scan; `None` when the kept values cannot decide it.
    fn second(
        &self,
        keypoints: &[crate::features::Keypoint],
        distinct: impl Fn(&crate::features::Keypoint) -> bool,
    ) -> Option<f32> {
        if self.any_nan {
            return None;
        }
        self.top
            .iter()
            .take_while(|&&(_, j)| j != usize::MAX)
            .find(|&&(_, j)| distinct(&keypoints[j]))
            .map(|&(v, _)| v.max(-1.0))
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
    let distinct_sq = opts.distinct_px * opts.distinct_px;
    let lanes = LaneMajor::new(b);
    let blocks: Vec<BlockBest> = (0..a.len())
        .collect::<Vec<_>>()
        .par_chunks(ROW_BLOCK)
        .map(|rows| match_block(a, b, &lanes, rows, distinct_sq))
        .collect();
    let mut column_best = vec![(f32::NEG_INFINITY, usize::MAX); b.len()];
    for (_, block) in &blocks {
        for (cur, &cand) in column_best.iter_mut().zip(block) {
            if cand.0 > cur.0 {
                *cur = cand;
            }
        }
    }
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

    /// The lane-major scoring reproduces the scalar `Σ a·b` bit for bit,
    /// including a partial last group and signed zeros.
    #[test]
    fn lane_scores_are_bit_identical_to_the_scalar_sum() {
        let mut rng = crate::prng::SplitMix64::new(6040);
        let dim = 128;
        let descriptors = |n: usize, rng: &mut crate::prng::SplitMix64| -> Vec<f32> {
            (0..n * dim)
                .map(|i| match i % 37 {
                    0 => 0.0,
                    1 => -0.0,
                    _ => rng.next_range(-1.0, 1.0) as f32,
                })
                .collect()
        };
        let b = FeatureSet {
            keypoints: vec![
                Keypoint {
                    x: 0.0,
                    y: 0.0,
                    score: 1.0
                };
                37
            ],
            descriptors: descriptors(37, &mut rng),
            descriptor_dim: dim,
            norm_keypoints: Vec::new(),
        };
        let a_desc = descriptors(3, &mut rng);
        let rows: Vec<&[f32]> = a_desc.chunks_exact(dim).collect();
        let mut sims = vec![vec![0.0_f32; b.len()]; rows.len()];
        LaneMajor::new(&b).score(&rows, &mut sims);
        for (r, row) in rows.iter().enumerate() {
            for j in 0..b.len() {
                let want: f32 = row.iter().zip(b.descriptor(j)).map(|(x, y)| x * y).sum();
                assert_eq!(sims[r][j].to_bits(), want.to_bits(), "row {r} col {j}");
            }
        }
        let zeros = vec![0.0_f32; dim];
        LaneMajor::new(&b).score(&[&zeros], &mut sims);
        for j in 0..b.len() {
            let want: f32 = zeros.iter().zip(b.descriptor(j)).map(|(x, y)| x * y).sum();
            assert_eq!(sims[0][j].to_bits(), want.to_bits(), "zero row col {j}");
        }
    }

    /// The scalar matcher this module replaced (#6057), kept as the
    /// reference: one dot product per pair, three passes per row.
    fn reference_match(
        a: &FeatureSet,
        b: &FeatureSet,
        distinct_sq: f32,
        ratio: f32,
    ) -> Vec<MlMatch> {
        let sims: Vec<Vec<f32>> = (0..a.len())
            .map(|i| {
                (0..b.len())
                    .map(|j| {
                        a.descriptor(i)
                            .iter()
                            .zip(b.descriptor(j))
                            .map(|(x, y)| x * y)
                            .sum()
                    })
                    .collect()
            })
            .collect();
        let column_best: Vec<usize> = (0..b.len())
            .map(|j| {
                (0..a.len())
                    .fold((f32::NEG_INFINITY, usize::MAX), |acc, i| {
                        if sims[i][j] > acc.0 {
                            (sims[i][j], i)
                        } else {
                            acc
                        }
                    })
                    .1
            })
            .collect();
        let mut out: Vec<(usize, MlMatch)> = (0..a.len())
            .filter_map(|i| {
                let (j, best) = sims[i].iter().enumerate().fold(
                    None,
                    |acc: Option<(usize, f32)>, (j, &v)| match acc {
                        Some((_, bv)) if bv >= v => acc,
                        _ => Some((j, v)),
                    },
                )?;
                let kb = b.keypoints[j];
                let second = sims[i]
                    .iter()
                    .zip(&b.keypoints)
                    .filter(|(_, o)| (o.x - kb.x).powi(2) + (o.y - kb.y).powi(2) >= distinct_sq)
                    .map(|(&v, _)| v)
                    .fold(-1.0_f32, f32::max);
                let (d1, d2) = (unit_distance(best), unit_distance(second));
                (column_best[j] == i && d1 < ratio * d2).then(|| {
                    let (ka, kb) = (a.keypoints[i], b.keypoints[j]);
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
        out.sort_by(|(ia, ma), (ib, mb)| mb.score.total_cmp(&ma.score).then(ia.cmp(ib)));
        out.into_iter().map(|(_, m)| m).collect()
    }

    /// Two overlapping views: `b` holds noisy, shuffled copies of most of
    /// `a`'s descriptors (some twice, at near-duplicate positions) plus
    /// distractors, so every branch of the ratio and mutual tests fires.
    #[test]
    fn matches_equal_the_scalar_reference_bit_for_bit() {
        let mut rng = crate::prng::SplitMix64::new(6040);
        let dim = 128;
        let unit = |v: Vec<f32>| {
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.into_iter().map(|x| x / n).collect::<Vec<f32>>()
        };
        let n = 300;
        let a_desc: Vec<Vec<f32>> = (0..n)
            .map(|_| unit((0..dim).map(|_| rng.next_range(0.0, 1.0) as f32).collect()))
            .collect();
        let a_kp: Vec<(f32, f32)> = (0..n)
            .map(|_| {
                (
                    rng.next_range(0.0, 1600.0) as f32,
                    rng.next_range(0.0, 1200.0) as f32,
                )
            })
            .collect();
        let mut b_desc = Vec::new();
        let mut b_kp = Vec::new();
        for i in 0..n {
            let copies = match i % 10 {
                0 => 0,
                1 => 2,
                _ => 1,
            };
            for c in 0..copies {
                let noise = if i % 7 == 0 { 0.6 } else { 0.08 };
                b_desc.push(unit(
                    a_desc[i]
                        .iter()
                        .map(|&x| x + noise * rng.next_range(-0.1, 0.1) as f32)
                        .collect(),
                ));
                b_kp.push((a_kp[i].0 + 40.0 + c as f32 * 1.5, a_kp[i].1 - 25.0));
            }
        }
        for _ in 0..77 {
            b_desc.push(unit(
                (0..dim).map(|_| rng.next_range(0.0, 1.0) as f32).collect(),
            ));
            b_kp.push((
                rng.next_range(0.0, 1600.0) as f32,
                rng.next_range(0.0, 1200.0) as f32,
            ));
        }
        let order: Vec<usize> = {
            let mut o: Vec<usize> = (0..b_desc.len()).collect();
            for k in (1..o.len()).rev() {
                o.swap(k, (rng.next_u64() % (k as u64 + 1)) as usize);
            }
            o
        };
        let to_set = |kp: Vec<(f32, f32)>, desc: Vec<Vec<f32>>| FeatureSet {
            keypoints: kp
                .into_iter()
                .map(|(x, y)| Keypoint { x, y, score: 1.0 })
                .collect(),
            descriptors: desc.concat(),
            descriptor_dim: dim,
            norm_keypoints: Vec::new(),
        };
        let a = to_set(a_kp, a_desc);
        let b = to_set(
            order.iter().map(|&k| b_kp[k]).collect(),
            order.iter().map(|&k| b_desc[k].clone()).collect(),
        );
        let opts = ClassicalMatchOptions::default();
        let got = match_classical(&a, &b, &opts);
        let want = reference_match(&a, &b, opts.distinct_px * opts.distinct_px, opts.ratio);
        assert!(got.len() > 100, "scene should match: {}", got.len());
        assert!(got.len() < n, "some rows must fail the tests");
        let bits = |m: &[MlMatch]| -> Vec<[u32; 5]> {
            m.iter()
                .map(|m| [m.x0, m.y0, m.x1, m.y1, m.score].map(f32::to_bits))
                .collect()
        };
        assert_eq!(bits(&got), bits(&want));
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
