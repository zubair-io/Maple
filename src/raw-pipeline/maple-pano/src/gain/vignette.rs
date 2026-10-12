//! Blind per-lens vignette estimation (#4522), the fallback for frames
//! whose ingest flattened no lens falloff (no OpcodeList3 gain map and no
//! bundled lens profile, #4516). Shared by the rotation photometry
//! ([`super::falloff`]) and the tile photometry (`crate::tile`).
//!
//! Every frame shot through one lens shares a radial falloff whose
//! correction is `V(r) = (1 + q·r²)²`, `q = k² ≥ 0`, with `r²` normalised
//! elliptically about the frame centre (`r² = 2` at a corner). `k` is
//! estimated jointly with per-frame log-gains from corresponding samples:
//! a pair satisfies `ln I_j − ln I_i = (x_i − x_j) + (L_i − L_j)`,
//! `L = ln V(r)`, so only the radius *difference* of the same scene point
//! in two frames informs `k` while the log-gains absorb exposure.
//! Gauss–Newton with Tikhonov damping, Huber reweighting, `k ∈ [0, 1.5]`
//! seeded at 0.2 (at `k = 0` the Jacobian vanishes, so a zero seed could
//! never leave it).

use super::solve_dense;

const K_SEED: f64 = 0.2;
const K_MAX: f64 = 1.5;
const ITERATIONS: usize = 10;
const TIKHONOV: f64 = 1e-4;
const HUBER_K: f64 = 1.5;
const MAD_TO_SIGMA: f64 = 1.4826;
/// Huber limit floor in log units (~1.5%), so a noise-free overlap does
/// not collapse the scale and down-weight every sample.
const HUBER_FLOOR: f64 = 0.015;
/// A lens group needs this many usable correspondences before its `q`
/// is trusted; below it the group keeps `q = 0`.
const MIN_GROUP_OBSERVATIONS: usize = 256;

/// Elliptically normalised squared radius of a source position about the
/// frame centre.
#[inline]
pub(crate) fn radius_squared(x: f64, y: f64, width: f64, height: f64) -> f64 {
    let u = (x - 0.5 * width) / (0.5 * width);
    let v = (y - 0.5 * height) / (0.5 * height);
    u * u + v * v
}

/// The correction multiplier `V = (1 + q·r²)²`.
#[inline]
pub(crate) fn falloff_gain(q: f64, r2: f64) -> f64 {
    (1.0 + q * r2).powi(2)
}

/// One scene point seen by frames `i` and `j`: its squared radius in each
/// and `ln(I_j / I_i)` of the uncorrected values.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Correspondence {
    pub i: usize,
    pub j: usize,
    pub r2_i: f64,
    pub r2_j: f64,
    pub log_ratio: f64,
}

/// Unknowns are `[x_0 … x_{n−1}, k_0 … k_{G−1}]`.
struct Model<'a> {
    frames: usize,
    group_of: &'a [Option<usize>],
}

impl Model<'_> {
    /// Index of frame `f`'s `k`, its `L(r²)`, and `∂L/∂k`.
    fn lens_term(&self, params: &[f64], f: usize, r2: f64) -> Option<(usize, f64, f64)> {
        self.group_of[f].map(|g| {
            let k = params[self.frames + g];
            let base = 1.0 + k * k * r2;
            (self.frames + g, 2.0 * base.ln(), 4.0 * k * r2 / base)
        })
    }

    /// Residual and model Jacobian row of one observation.
    fn linearize(&self, params: &[f64], o: &Correspondence) -> (f64, [(usize, f64); 4]) {
        let li = self.lens_term(params, o.i, o.r2_i);
        let lj = self.lens_term(params, o.j, o.r2_j);
        let model = params[o.i] - params[o.j] + li.map_or(0.0, |t| t.1) - lj.map_or(0.0, |t| t.1);
        let row = [
            (o.i, 1.0),
            (o.j, -1.0),
            li.map_or((0, 0.0), |t| (t.0, t.2)),
            lj.map_or((0, 0.0), |t| (t.0, -t.2)),
        ];
        (o.log_ratio - model, row)
    }

    fn residuals(&self, params: &[f64], obs: &[Correspondence]) -> Vec<f64> {
        obs.iter().map(|o| self.linearize(params, o).0).collect()
    }

    fn step(&self, params: &[f64], obs: &[Correspondence], weights: &[f64]) -> Option<Vec<f64>> {
        let m = params.len();
        let (a, b) = obs.iter().zip(weights).fold(
            (vec![vec![0.0_f64; m]; m], vec![0.0_f64; m]),
            |(mut a, mut b), (o, w)| {
                let (e, row) = self.linearize(params, o);
                let terms = || row.iter().filter(|t| t.1 != 0.0);
                for &(r, cr) in terms() {
                    b[r] += w * cr * e;
                    for &(c, cc) in terms() {
                        a[r][c] += w * cr * cc;
                    }
                }
                (a, b)
            },
        );
        let (a, b): (Vec<Vec<f64>>, Vec<f64>) = a
            .into_iter()
            .zip(b)
            .zip(params)
            .enumerate()
            .map(|(d, ((mut row, rhs), theta))| {
                row[d] += TIKHONOV;
                (row, rhs - TIKHONOV * theta)
            })
            .unzip();
        let delta = solve_dense(a, b)?;
        Some(
            params
                .iter()
                .zip(&delta)
                .enumerate()
                .map(|(d, (p, s))| {
                    if d < self.frames {
                        p + s
                    } else {
                        (p + s).clamp(0.0, K_MAX)
                    }
                })
                .collect(),
        )
    }
}

fn huber_weights(residuals: &[f64]) -> Vec<f64> {
    let mut magnitudes: Vec<f64> = residuals.iter().map(|r| r.abs()).collect();
    let mid = magnitudes.len() / 2;
    let (_, median, _) = magnitudes.select_nth_unstable_by(mid, f64::total_cmp);
    let limit = (HUBER_K * MAD_TO_SIGMA * *median).max(HUBER_FLOOR);
    residuals
        .iter()
        .map(|r| {
            if r.abs() <= limit {
                1.0
            } else {
                limit / r.abs()
            }
        })
        .collect()
}

/// `q` per lens group (0 for groups without enough support). `group_of`
/// assigns each of the `group_of.len()` frames its group, `None` for
/// frames corrected at ingest.
pub(crate) fn estimate_falloff(
    obs: &[Correspondence],
    group_of: &[Option<usize>],
    groups: usize,
) -> Vec<f64> {
    if obs.is_empty() {
        return vec![0.0; groups];
    }
    let frames = group_of.len();
    let support: Vec<usize> = (0..groups)
        .map(|g| {
            obs.iter()
                .filter(|o| group_of[o.i] == Some(g) || group_of[o.j] == Some(g))
                .count()
        })
        .collect();
    let model = Model { frames, group_of };
    let seed: Vec<f64> = std::iter::repeat_n(0.0, frames)
        .chain(std::iter::repeat_n(K_SEED, groups))
        .collect();
    let (params, _) =
        (0..ITERATIONS).fold(
            (seed, vec![1.0; obs.len()]),
            |(params, weights), _| match model.step(&params, obs, &weights) {
                Some(next) => {
                    let weights = huber_weights(&model.residuals(&next, obs));
                    (next, weights)
                }
                None => (params, weights),
            },
        );
    params[frames..]
        .iter()
        .zip(&support)
        .map(|(k, n)| {
            if *n >= MIN_GROUP_OBSERVATIONS {
                k * k
            } else {
                0.0
            }
        })
        .collect()
}
