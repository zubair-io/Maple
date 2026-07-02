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

/// Flat f32 length of a serialized [`ProfileCurve`] (see
/// [`ProfileCurve::to_flat`]). Stable ABI shared by the FFI + WASM bake
/// entries — bump only in lockstep with the field layout in `to_flat` /
/// `from_flat`, and update every host that reconstructs the struct.
///
/// Layout (in order): r/g/b anchors (3 × 32 × 2 = 192), matrix (9),
/// chroma_boost (1), chroma_offset (2), lightness_offset (1),
/// lightness_band_offsets (5), ab_band_offsets (10) = 220.
pub const PROFILE_CURVE_FLAT_LEN: usize = 3 * ANCHORS * 2 + 9 + 1 + 2 + 1 + 5 + 10;

/// 32-anchor monotone piecewise-linear curve per channel.
///
/// Anchors are stored as `(input, output)` pairs sorted by input ascending.
/// Input values are evenly spaced in `[0, 1]` at construction time, which
/// lets `eval_channel` skip a binary search.
#[derive(Clone, Debug, PartialEq)]
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

/// Per-RGB-channel tone curve bundle plus an optional cross-channel
/// 3×3 matrix applied AFTER the curves.
///
/// The matrix corrects color casts and saturation deltas that 1D
/// per-channel curves cannot reach (cross-channel coupling — by
/// construction a 1D curve can't change channel ratios at equal
/// input). Fit by least squares from curve-corrected source pixels
/// against the embedded JPEG target. Identity = no matrix correction.
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileCurve {
    pub r: ChannelCurve,
    pub g: ChannelCurve,
    pub b: ChannelCurve,
    pub matrix: [[f32; 3]; 3],
    /// Per-image Oklab chroma multiplier applied AFTER curves + matrix.
    /// Closes the saturation deficit that 1D per-channel curves leave
    /// behind — per-channel curves on the source distribution preserve
    /// (or even reduce) chroma relative to the source, but the JPEG
    /// target may be more saturated than what curves alone produce.
    /// Fit by comparing post-curve mean chroma to target mean chroma.
    /// 1.0 = no boost (identity).
    pub chroma_boost: f32,
    /// Per-image Oklab (a, b) offset applied AFTER chroma_boost.
    /// Corrects residual hue casts left by the per-channel curves —
    /// test_0010 had a fixed −6.7 / +2.7 a/b shift (yellow-green
    /// cast) that no chroma scale could correct because chroma scale
    /// preserves hue. Fit from the mean (a, b) difference between
    /// curve-corrected source and target on the same paired cells.
    /// Bounded to ±5 Lab units to prevent pathological estimates.
    pub chroma_offset: [f32; 2],
    /// Per-image Oklab L offset. Corrects residual global brightness
    /// shift left by the per-channel curves — test_0009 had +2.3
    /// CIELab L bias uniformly across shadow and highlight bands
    /// (a constant additive lift, not a curve-shape problem). Fit
    /// from the mean L difference between curve-corrected source
    /// and target. Bounded to ±0.03 Oklab units (~3 CIELab L).
    pub lightness_offset: f32,
    /// Per-image L-band correction LUT (5 anchors at L=0.0/0.25/
    /// 0.50/0.75/1.0 in Oklab L space, each carrying an Oklab L
    /// offset). Applied AFTER `lightness_offset` via piecewise-
    /// linear interpolation on the pixel's Oklab L. Closes the
    /// "shadow-lift but highlight-not" pattern the global L
    /// offset can't reach — measured: test_0000 (CONTRAST_LOW:
    /// shadows +0.12, highlights −0.14) and test_0010 (CONTRAST_HIGH:
    /// shadows −0.07, highlights +0.06) need opposite per-band
    /// fixes. Each anchor bounded to ±0.03 Oklab L. Identity is
    /// all zeros.
    pub lightness_band_offsets: [f32; 5],
    /// Per-image (a, b) chromaticity correction LUT, same 5-anchor
    /// structure as `lightness_band_offsets`. Each anchor carries
    /// an Oklab (a, b) offset, applied AFTER `chroma_offset` via
    /// piecewise-linear interp on the pixel's Oklab L. Catches the
    /// localized hue casts the global `chroma_offset` averages
    /// away — measured: test_0003 had OPPOSITE tilts in shadows
    /// (yellow-green) vs highlights (MAGENTA) that cancel to a
    /// small global average. Each (a, b) bounded to ±0.02 Oklab
    /// (~2 Lab units). Identity = all zeros.
    pub ab_band_offsets: [[f32; 2]; 5],
}

pub const IDENTITY_MATRIX: [[f32; 3]; 3] = [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
];

impl ProfileCurve {
    pub fn identity() -> Self {
        Self {
            r: ChannelCurve::identity(),
            g: ChannelCurve::identity(),
            b: ChannelCurve::identity(),
            matrix: IDENTITY_MATRIX,
            chroma_boost: 1.0,
            chroma_offset: [0.0, 0.0],
            lightness_offset: 0.0,
            lightness_band_offsets: [0.0; 5],
            ab_band_offsets: [[0.0, 0.0]; 5],
        }
    }

    /// Flatten the full struct to a `PROFILE_CURVE_FLAT_LEN`-element f32
    /// vector. This is the single serialization source of truth for the
    /// FFI + WASM bake boundary — the host passes these floats back through
    /// [`from_flat`](Self::from_flat) so `bake_profile_lut` baked the EXACT
    /// curve the render path fit (no field drops, so a later matrix/Oklab
    /// fix crosses the boundary for free).
    ///
    /// Layout matches [`PROFILE_CURVE_FLAT_LEN`]'s doc comment exactly.
    pub fn to_flat(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(PROFILE_CURVE_FLAT_LEN);
        for ch in [&self.r, &self.g, &self.b] {
            for (i, o) in ch.anchors.iter() {
                out.push(*i);
                out.push(*o);
            }
        }
        for row in &self.matrix {
            out.extend_from_slice(row);
        }
        out.push(self.chroma_boost);
        out.extend_from_slice(&self.chroma_offset);
        out.push(self.lightness_offset);
        out.extend_from_slice(&self.lightness_band_offsets);
        for ab in &self.ab_band_offsets {
            out.extend_from_slice(ab);
        }
        debug_assert_eq!(out.len(), PROFILE_CURVE_FLAT_LEN);
        out
    }

    /// Reconstruct a `ProfileCurve` from the flat layout produced by
    /// [`to_flat`](Self::to_flat). Returns `None` when `flat.len()` is not
    /// exactly [`PROFILE_CURVE_FLAT_LEN`] — the FFI/WASM entries surface that
    /// as an error rather than reading past the buffer.
    pub fn from_flat(flat: &[f32]) -> Option<Self> {
        if flat.len() != PROFILE_CURVE_FLAT_LEN {
            return None;
        }
        let mut it = flat.iter().copied();
        let mut read_channel = || {
            let mut anchors = [(0.0_f32, 0.0_f32); ANCHORS];
            for a in anchors.iter_mut() {
                a.0 = it.next().unwrap();
                a.1 = it.next().unwrap();
            }
            ChannelCurve { anchors }
        };
        let r = read_channel();
        let g = read_channel();
        let b = read_channel();
        let mut matrix = IDENTITY_MATRIX;
        for row in matrix.iter_mut() {
            for v in row.iter_mut() {
                *v = it.next().unwrap();
            }
        }
        let chroma_boost = it.next().unwrap();
        let chroma_offset = [it.next().unwrap(), it.next().unwrap()];
        let lightness_offset = it.next().unwrap();
        let mut lightness_band_offsets = [0.0_f32; 5];
        for v in lightness_band_offsets.iter_mut() {
            *v = it.next().unwrap();
        }
        let mut ab_band_offsets = [[0.0_f32; 2]; 5];
        for ab in ab_band_offsets.iter_mut() {
            ab[0] = it.next().unwrap();
            ab[1] = it.next().unwrap();
        }
        Some(Self {
            r,
            g,
            b,
            matrix,
            chroma_boost,
            chroma_offset,
            lightness_offset,
            lightness_band_offsets,
            ab_band_offsets,
        })
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
