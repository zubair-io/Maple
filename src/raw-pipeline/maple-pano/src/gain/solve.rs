//! Global photometric solve from pairwise fits: log-gains first, then a
//! small, strongly shrunk additive bias under those gains.
//!
//! With `I_j ≈ a_ij·I_i + d_ij`, matching corrected values
//! `g_i·I_i + b_i = g_j·I_j + b_j` gives `ln g_i − ln g_j = ln a_ij`
//! and `b_i − b_j = g_j·d_ij`. Both are weighted least squares over the
//! pair graph with edge weight `W_ij = min(n, 3000) / (σ² + ε)`.

use super::fit::{AffineFit, PairFit};
use super::overlap::OverlapSet;
use super::{solve_dense, FramePhotometry, GainMode};
use crate::error::PanoError;

const EDGE_SAMPLE_CAP: usize = 3000;
/// `ε` in the edge weight: a 2%-of-white noise allowance, so a fit whose
/// MAD collapses on synthetic or flat data cannot dominate the graph.
const NOISE_EPS: f64 = 0.0004;
const MAX_EDGE_WEIGHT: f64 = EDGE_SAMPLE_CAP as f64 / NOISE_EPS;

/// `λ_g`: weak pull of every log-gain toward 0. Only decides the level
/// of frames (or components) the data leaves free; the gauge below
/// fixes the global level.
const LOG_GAIN_PRIOR: f64 = 1.0;

/// `λ_b ≫ λ_g`: a zero-shrinkage prior worth a quarter of the strongest
/// possible overlap, so bias moves only where overlaps agree on it.
const BIAS_PRIOR: f64 = 0.25 * MAX_EDGE_WEIGHT;

/// Bias limit as a fraction of reference white: enough for black-level
/// error and veiling flare, never enough to stand in for a gain.
pub(crate) const MAX_BIAS_FRACTION: f64 = 0.01;

struct Edge {
    i: usize,
    j: usize,
    fit: AffineFit,
    weight: f64,
}

fn edge_weight(fit: &AffineFit) -> f64 {
    fit.samples.min(EDGE_SAMPLE_CAP) as f64 / (fit.sigma * fit.sigma + NOISE_EPS)
}

/// Per-frame gain and bias from the pairwise fits. Gains are gauged to
/// geometric mean 1 per slot; biases are in the frames' linear units.
pub(crate) fn solve_from_fits(
    set: &OverlapSet,
    fits: &[PairFit],
    mode: GainMode,
) -> Result<Vec<FramePhotometry>, PanoError> {
    let n = set.windows.len();
    let scale = set.reference_white();
    mode.slots().iter().enumerate().try_fold(
        vec![FramePhotometry::IDENTITY; n],
        |mut out, (slot, channels)| {
            let edges: Vec<Edge> = fits
                .iter()
                .filter_map(|p| {
                    let fit = p.fits[slot]?;
                    Some(Edge {
                        i: p.i,
                        j: p.j,
                        fit,
                        weight: edge_weight(&fit),
                    })
                })
                .collect();
            let gains = solve_log_gains(n, &edges)?;
            let biases = solve_biases(n, &edges, &gains)?;
            for (frame, (g, b)) in out.iter_mut().zip(gains.iter().zip(&biases)) {
                for &c in *channels {
                    frame.gain[c] = *g as f32;
                    frame.bias[c] = (b * scale) as f32;
                }
            }
            Ok(out)
        },
    )
}

/// Weighted graph least squares `Σ W (x_i − x_j − t)² + λ Σ x²`.
fn solve_graph(
    n: usize,
    edges: impl Iterator<Item = (usize, usize, f64, f64)>,
    prior: f64,
) -> Result<Vec<f64>, PanoError> {
    let mut a = vec![vec![0.0_f64; n]; n];
    let mut b = vec![0.0_f64; n];
    for (k, row) in a.iter_mut().enumerate() {
        row[k] = prior;
    }
    for (i, j, target, w) in edges {
        a[i][i] += w;
        a[j][j] += w;
        a[i][j] -= w;
        a[j][i] -= w;
        b[i] += w * target;
        b[j] -= w * target;
    }
    solve_dense(a, b)
        .ok_or_else(|| PanoError::InvalidOptions("photometry: singular normal equations".into()))
}

fn solve_log_gains(n: usize, edges: &[Edge]) -> Result<Vec<f64>, PanoError> {
    let log_gains = solve_graph(
        n,
        edges.iter().map(|e| (e.i, e.j, e.fit.slope.ln(), e.weight)),
        LOG_GAIN_PRIOR,
    )?;
    let gauge = log_gains.iter().sum::<f64>() / n.max(1) as f64;
    Ok(log_gains.iter().map(|l| (l - gauge).exp()).collect())
}

fn solve_biases(n: usize, edges: &[Edge], gains: &[f64]) -> Result<Vec<f64>, PanoError> {
    let biases = solve_graph(
        n,
        edges
            .iter()
            .map(|e| (e.i, e.j, gains[e.j] * e.fit.offset, e.weight)),
        BIAS_PRIOR,
    )?;
    Ok(biases
        .into_iter()
        .map(|b| b.clamp(-MAX_BIAS_FRACTION, MAX_BIAS_FRACTION))
        .collect())
}
