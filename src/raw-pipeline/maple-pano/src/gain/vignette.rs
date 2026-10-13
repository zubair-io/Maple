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

/// One lens group's falloff estimate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FalloffFit {
    /// The applied `q` (0 when not estimable).
    pub q: f64,
    /// Linearised estimate without the `q ≥ 0` bound — negative when the
    /// overlaps say the corners are brighter than the centre.
    pub q_unconstrained: f64,
    /// Standard error of `q_unconstrained`.
    pub sigma: f64,
    /// Enough correspondences, with radius differences independent enough
    /// of a pure gain step, to resolve `q` to [`MAX_Q_SIGMA`].
    pub estimable: bool,
}

/// Largest standard error at which `q` is still applied: a quarter of the
/// smallest falloff worth correcting (`q = 0.04`, ~14% corner darkening).
const MAX_Q_SIGMA: f64 = 0.01;

/// Per-group estimate. `group_of` assigns each of the `group_of.len()`
/// frames its group, `None` for frames corrected at ingest.
pub(crate) fn estimate_falloff(
    obs: &[Correspondence],
    group_of: &[Option<usize>],
    groups: usize,
) -> Vec<FalloffFit> {
    let frames = group_of.len();
    if obs.is_empty() {
        let unknown = FalloffFit {
            q: 0.0,
            q_unconstrained: 0.0,
            sigma: f64::INFINITY,
            estimable: false,
        };
        return vec![unknown; groups];
    }
    let support: Vec<usize> = (0..groups)
        .map(|g| {
            obs.iter()
                .filter(|o| group_of[o.i] == Some(g) || group_of[o.j] == Some(g))
                .count()
        })
        .collect();
    let linear = linear_falloff(obs, group_of, groups);
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
        .zip(&linear)
        .map(|((k, n), lin)| {
            let estimable = *n >= MIN_GROUP_OBSERVATIONS && lin.sigma <= MAX_Q_SIGMA;
            FalloffFit {
                q: if estimable { k * k } else { 0.0 },
                q_unconstrained: lin.q,
                sigma: lin.sigma,
                estimable,
            }
        })
        .collect()
}

/// Small-`q` linearisation of one group's falloff (`L ≈ 2·q·r²`) with the
/// gains profiled out: the unconstrained estimate (negative = corners
/// brighter than the centre) and its standard error.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LinearFalloff {
    pub q: f64,
    pub sigma: f64,
}

const LINEAR_IRLS_ITERATIONS: usize = 5;
const RESIDUAL_SCALE_FLOOR: f64 = 0.01;

/// Huber IRLS on the linearised model. The standard error is the robust
/// residual scale through the inverse normal matrix — large when the
/// overlaps' radius differences are nearly collinear with a pure gain
/// step, i.e. when the falloff is not observable from this geometry.
pub(crate) fn linear_falloff(
    obs: &[Correspondence],
    group_of: &[Option<usize>],
    groups: usize,
) -> Vec<LinearFalloff> {
    let frames = group_of.len();
    let m = frames + groups;
    let row = |o: &Correspondence| {
        [
            (o.i, 1.0),
            (o.j, -1.0),
            group_of[o.i].map_or((0, 0.0), |g| (frames + g, 2.0 * o.r2_i)),
            group_of[o.j].map_or((0, 0.0), |g| (frames + g, -2.0 * o.r2_j)),
        ]
    };
    let normal = |weights: &[f64]| {
        obs.iter().zip(weights).fold(
            (
                (0..m)
                    .map(|d| {
                        let mut r = vec![0.0_f64; m];
                        r[d] = TIKHONOV;
                        r
                    })
                    .collect::<Vec<_>>(),
                vec![0.0_f64; m],
            ),
            |(mut a, mut b), (o, w)| {
                let terms = row(o);
                let live = || terms.iter().filter(|t| t.1 != 0.0);
                for &(r, cr) in live() {
                    b[r] += w * cr * o.log_ratio;
                    for &(c, cc) in live() {
                        a[r][c] += w * cr * cc;
                    }
                }
                (a, b)
            },
        )
    };
    let residuals = |params: &[f64]| -> Vec<f64> {
        obs.iter()
            .map(|o| o.log_ratio - row(o).iter().map(|&(k, c)| c * params[k]).sum::<f64>())
            .collect()
    };
    let unknown = || {
        vec![
            LinearFalloff {
                q: 0.0,
                sigma: f64::INFINITY
            };
            groups
        ]
    };
    if obs.is_empty() {
        return unknown();
    }
    let solved = (0..LINEAR_IRLS_ITERATIONS).try_fold(
        (vec![0.0_f64; m], vec![1.0_f64; obs.len()]),
        |(_, weights), _| {
            let (a, b) = normal(&weights);
            let params = solve_dense(a, b)?;
            let weights = huber_weights(&residuals(&params));
            Some((params, weights))
        },
    );
    let Some((params, weights)) = solved else {
        return unknown();
    };
    let mut magnitudes: Vec<f64> = residuals(&params).iter().map(|r| r.abs()).collect();
    let mid = magnitudes.len() / 2;
    let (_, median, _) = magnitudes.select_nth_unstable_by(mid, f64::total_cmp);
    // Floor: noise-free data must not make an unobservable `q` look exact.
    let scale = (MAD_TO_SIGMA * *median).max(RESIDUAL_SCALE_FLOOR);
    (0..groups)
        .map(|g| {
            let (a, _) = normal(&weights);
            let unit = (0..m)
                .map(|d| f64::from(u8::from(d == frames + g)))
                .collect();
            let variance = solve_dense(a, unit).map_or(f64::INFINITY, |z| z[frames + g]);
            LinearFalloff {
                q: params[frames + g],
                sigma: scale * variance.max(0.0).sqrt(),
            }
        })
        .collect()
}
