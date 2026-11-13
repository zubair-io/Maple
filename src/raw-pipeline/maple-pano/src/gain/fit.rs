//! Robust pairwise photometric fit `I_j ≈ a·I_i + d` per overlap and
//! channel slot (IRLS with Huber weights and a MAD noise scale).
//!
//! Values are normalized by the set's reference white before fitting,
//! so `offset` and `sigma` are fractions of white and the noise floor
//! and Huber limits mean the same thing in every scene.

use rayon::prelude::*;

use super::overlap::{OverlapSet, PairSamples, SignalWindow};
use super::GainMode;

pub(crate) const MIN_EDGE_SAMPLES: usize = 24;
const IRLS_ITERATIONS: usize = 5;
const HUBER_K: f64 = 1.5;
const MAD_TO_SIGMA: f64 = 1.4826;
const SIGMA_FLOOR: f64 = 0.001;

/// Below this coefficient of variation the overlap spans too little
/// intensity range for slope and offset to separate; the fit falls back
/// to a pure gain through the origin (scene-linear exposure is a
/// multiplier, so that is the physically primary model).
const MIN_AFFINE_SPREAD: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AffineFit {
    pub slope: f64,
    pub offset: f64,
    pub sigma: f64,
    pub samples: usize,
}

/// Robust fits of one pair, one entry per [`GainMode::slots`] slot.
#[derive(Debug, Clone)]
pub(crate) struct PairFit {
    pub i: usize,
    pub j: usize,
    pub fits: Vec<Option<AffineFit>>,
}

impl GainMode {
    /// Channel sets solved independently: the channel mean in scalar
    /// mode, each channel alone in per-channel mode.
    pub(crate) fn slots(self) -> &'static [&'static [usize]] {
        match self {
            GainMode::Scalar => &[&[0, 1, 2]],
            GainMode::PerChannel => &[&[0], &[1], &[2]],
        }
    }
}

pub(crate) fn fit_pairs(set: &OverlapSet, mode: GainMode) -> Vec<PairFit> {
    let scale = set.reference_white();
    set.pairs
        .par_iter()
        .map(|pair| PairFit {
            i: pair.i,
            j: pair.j,
            fits: mode
                .slots()
                .iter()
                .map(|channels| {
                    let points = slot_points(
                        pair,
                        set.windows[pair.i],
                        set.windows[pair.j],
                        channels,
                        scale,
                    );
                    robust_affine_fit(&points)
                })
                .collect(),
        })
        .collect()
}

/// Samples inside both frames' signal windows, as white-normalized
/// `(I_i, I_j)` slot values.
fn slot_points(
    pair: &PairSamples,
    wi: SignalWindow,
    wj: SignalWindow,
    channels: &[usize],
    scale: f64,
) -> Vec<(f64, f64)> {
    let slot = |v: [f32; 3]| channels.iter().map(|&c| v[c]).sum::<f32>() / channels.len() as f32;
    pair.samples
        .iter()
        .filter(|s| wi.unclipped(s.value_i) && wj.unclipped(s.value_j))
        .map(|s| (slot(s.value_i), slot(s.value_j)))
        .filter(|&(a, b)| a >= wi.floor() && b >= wj.floor() && a > 0.0 && b > 0.0)
        .map(|(a, b)| (a as f64 / scale, b as f64 / scale))
        .collect()
}

pub(crate) fn robust_affine_fit(points: &[(f64, f64)]) -> Option<AffineFit> {
    if points.len() < MIN_EDGE_SAMPLES {
        return None;
    }
    // Seed from the median ratio, not least squares: a moving object or
    // misregistration produces high-leverage points that a Huber IRLS
    // started from OLS cannot shed.
    let seed_slope = median(&mut points.iter().map(|(x, y)| y / x).collect::<Vec<_>>());
    let (seed_weights, seed_sigma) = huber_weights(points, seed_slope, 0.0);
    let affine = coefficient_of_variation(points, &seed_weights) >= MIN_AFFINE_SPREAD;
    let (_, (slope, offset, sigma)) = (0..IRLS_ITERATIONS).try_fold(
        (seed_weights, (seed_slope, 0.0, seed_sigma)),
        |(weights, _), _| {
            let (slope, offset) = weighted_line(points, &weights, affine)?;
            let (weights, sigma) = huber_weights(points, slope, offset);
            Some((weights, (slope, offset, sigma)))
        },
    )?;
    (slope > 0.0 && slope.is_finite() && offset.is_finite() && sigma.is_finite()).then_some(
        AffineFit {
            slope,
            offset,
            sigma,
            samples: points.len(),
        },
    )
}

fn huber_weights(points: &[(f64, f64)], slope: f64, offset: f64) -> (Vec<f64>, f64) {
    let residuals: Vec<f64> = points.iter().map(|(x, y)| y - slope * x - offset).collect();
    let sigma = (MAD_TO_SIGMA * median_abs_deviation(&residuals)).max(SIGMA_FLOOR);
    let limit = HUBER_K * sigma;
    let weights = residuals
        .iter()
        .map(|r| {
            if r.abs() <= limit {
                1.0
            } else {
                limit / r.abs()
            }
        })
        .collect();
    (weights, sigma)
}

fn coefficient_of_variation(points: &[(f64, f64)], weights: &[f64]) -> f64 {
    let wsum: f64 = weights.iter().sum();
    let mean = points
        .iter()
        .zip(weights)
        .map(|(p, w)| w * p.0)
        .sum::<f64>()
        / wsum;
    let var = points
        .iter()
        .zip(weights)
        .map(|(p, w)| w * (p.0 - mean).powi(2))
        .sum::<f64>()
        / wsum;
    if mean > 0.0 {
        var.sqrt() / mean
    } else {
        0.0
    }
}

fn weighted_line(points: &[(f64, f64)], weights: &[f64], affine: bool) -> Option<(f64, f64)> {
    let wsum: f64 = weights.iter().sum();
    if wsum <= 1e-12 {
        return None;
    }
    let weighted = || points.iter().zip(weights);
    if !affine {
        let sxy: f64 = weighted().map(|((x, y), w)| w * x * y).sum();
        let sxx: f64 = weighted().map(|((x, _), w)| w * x * x).sum();
        return (sxx > 1e-18).then(|| (sxy / sxx, 0.0));
    }
    let mx = weighted().map(|((x, _), w)| w * x).sum::<f64>() / wsum;
    let my = weighted().map(|((_, y), w)| w * y).sum::<f64>() / wsum;
    let cov: f64 = weighted().map(|((x, y), w)| w * (x - mx) * (y - my)).sum();
    let var: f64 = weighted().map(|((x, _), w)| w * (x - mx).powi(2)).sum();
    (var > 1e-18).then(|| {
        let slope = cov / var;
        (slope, my - slope * mx)
    })
}

fn median(values: &mut [f64]) -> f64 {
    let mid = values.len() / 2;
    let (_, m, _) = values.select_nth_unstable_by(mid, f64::total_cmp);
    *m
}

fn median_abs_deviation(residuals: &[f64]) -> f64 {
    let center = median(&mut residuals.to_vec());
    let mut deviations: Vec<f64> = residuals.iter().map(|r| (r - center).abs()).collect();
    median(&mut deviations)
}
