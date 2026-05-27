//! Per-channel monotone piecewise-linear tone curve fit from source + target
//! distributions. Pure functions; no I/O.
//!
//! The fit method (CDF matching):
//!
//! 1. Build a 256-bin CDF of the source distribution and another of the
//!    target distribution. `cdf[i]` is the value at the `(i/255)`-th
//!    percentile of the input samples.
//! 2. At each of 32 evenly-spaced input anchors, look up the input's
//!    quantile in the source CDF (inverse CDF), then look up the target
//!    value at that quantile.
//! 3. Clamp tiny floating-point inversions back to monotone.
//!
//! Curves are stored as 32 evenly-spaced `(input, output)` anchor pairs so
//! evaluation is a single multiply + floor + linear interpolation between
//! adjacent anchors — no binary search.

const ANCHORS: usize = 32;
const CDF_BINS: usize = 256;

/// 32-anchor monotone piecewise-linear curve per channel.
///
/// Anchors are stored as `(input, output)` pairs sorted by input ascending.
/// Input values are evenly spaced in `[0, 1]` at construction time, which
/// lets `eval_channel` skip a binary search.
#[derive(Clone, Debug)]
pub struct ChannelCurve {
    pub anchors: [(f32, f32); ANCHORS],
}

impl ChannelCurve {
    /// Identity curve: `output = input` at all anchors.
    pub fn identity() -> Self {
        let mut anchors = [(0.0_f32, 0.0_f32); ANCHORS];
        for i in 0..ANCHORS {
            let v = i as f32 / (ANCHORS - 1) as f32;
            anchors[i] = (v, v);
        }
        Self { anchors }
    }
}

/// Per-RGB-channel tone curve bundle.
#[derive(Clone, Debug)]
pub struct ProfileCurve {
    pub r: ChannelCurve,
    pub g: ChannelCurve,
    pub b: ChannelCurve,
}

impl ProfileCurve {
    pub fn identity() -> Self {
        Self {
            r: ChannelCurve::identity(),
            g: ChannelCurve::identity(),
            b: ChannelCurve::identity(),
        }
    }
}

/// Build a `bins`-entry CDF from samples in `[0, 1]`. Returns
/// `cdf[i]` = the value at the `(i / (bins - 1))`-th percentile of the
/// input distribution.
///
/// Out-of-range samples are clamped to `[0, 1]` before sorting. Empty
/// inputs return an all-zero CDF.
///
/// # Panics
/// Panics if `bins < 2`.
pub fn build_cdf(samples: &[f32], bins: usize) -> Vec<f32> {
    assert!(bins >= 2, "build_cdf: bins must be >= 2 (got {bins})");
    if samples.is_empty() {
        return vec![0.0_f32; bins];
    }
    let mut sorted: Vec<f32> = samples.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let mut cdf = vec![0.0_f32; bins];
    for i in 0..bins {
        let q = i as f32 / (bins - 1) as f32;
        let idx = ((q * (n - 1) as f32).round() as usize).min(n - 1);
        cdf[i] = sorted[idx];
    }
    cdf
}

/// Fit a monotone piecewise-linear curve that maps the source distribution
/// onto the target distribution. Both slices contain samples in `[0, 1]`.
///
/// Returns the identity curve if either distribution is empty (no signal
/// to match against).
pub fn fit_channel_curve(source: &[f32], target: &[f32]) -> ChannelCurve {
    if source.is_empty() || target.is_empty() {
        return ChannelCurve::identity();
    }
    let src_cdf = build_cdf(source, CDF_BINS);
    let tgt_cdf = build_cdf(target, CDF_BINS);
    let mut anchors = [(0.0_f32, 0.0_f32); ANCHORS];
    for i in 0..ANCHORS {
        let in_v = i as f32 / (ANCHORS - 1) as f32;
        // Find the quantile of `in_v` in the source CDF (inverse CDF lookup).
        let q = quantile_of(&src_cdf, in_v);
        // Look up the target value at that quantile.
        let bin = ((q * (CDF_BINS - 1) as f32).round() as usize).min(CDF_BINS - 1);
        let out_v = tgt_cdf[bin];
        anchors[i] = (in_v, out_v);
    }
    // Enforce non-decreasing outputs. The CDF construction is monotone in
    // theory, but float rounding at anchor boundaries can introduce tiny
    // inversions that violate the contract.
    for i in 1..ANCHORS {
        if anchors[i].1 < anchors[i - 1].1 {
            anchors[i].1 = anchors[i - 1].1;
        }
    }
    ChannelCurve { anchors }
}

/// Quantile of value `v` within CDF `cdf`. Returns the fraction of input
/// pixels whose value is at or below `v`.
///
/// Implementation: linear scan for the smallest `i` with `cdf[i] >= v`.
/// At 256 bins a scan is faster than a binary-search dispatch on modern
/// hardware and keeps the code obviously correct.
fn quantile_of(cdf: &[f32], v: f32) -> f32 {
    let bins = cdf.len();
    if bins == 0 {
        return 0.0;
    }
    for i in 0..bins {
        if cdf[i] >= v {
            return i as f32 / (bins - 1) as f32;
        }
    }
    1.0
}

/// Evaluate a channel curve at `v` in `[0, 1]`. Linear interpolation
/// between the two anchors bracketing `v`. Out-of-range `v` is clamped.
pub fn eval_channel(curve: &ChannelCurve, v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    // Anchors are evenly spaced in input — multiplying by `ANCHORS - 1`
    // gives the fractional anchor index directly.
    let scaled = v * (ANCHORS - 1) as f32;
    let lo = scaled.floor() as usize;
    let hi = (lo + 1).min(ANCHORS - 1);
    let t = scaled - lo as f32;
    let lo_y = curve.anchors[lo].1;
    let hi_y = curve.anchors[hi].1;
    lo_y + (hi_y - lo_y) * t
}
