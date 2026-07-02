//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
//!
//! In the render path this layers **after** the #550 per-channel curve: the fit
//! entry points are handed the already-curved display buffer, so the sampled
//! pairs are `(curve(maple), jpeg)` and the grid carries only the cross-channel
//! residual the separable curve can't (`fit_lut_from_pairs` seeds identity and
//! adds a confidence-weighted delta, so a tiny residual ⇒ near-identity LUT ⇒
//! `strength = 0` reproduces the pure #550 curve exactly).
use rayon::prelude::*;

use crate::image::ExifOrientation;

use super::pairs::DisplayPair;
use super::preview::JpegColorSpace;

/// Grid layout matches `bake.rs`: index = ((b*N + g)*N + r)*3 + c, values in [0,1].
#[derive(Clone, Debug, PartialEq)]
pub struct ColorLut {
    pub size: usize,
    pub data: Vec<f32>,
}

impl ColorLut {
    /// Identity LUT of `size` nodes per axis (clamped to ≥2).
    pub fn identity(size: usize) -> Self {
        let n = size.max(2);
        let mut data = vec![0.0f32; n * n * n * 3];
        let denom = (n - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        Self { size: n, data }
    }

    #[inline]
    fn node(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let n = self.size;
        let i = ((b * n + g) * n + r) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    /// Tetrahedral lookup of one RGB triplet (inputs clamped to [0,1]).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let last = (n - 1) as f32;
        let mut lo = [0usize; 3];
        let mut f = [0f32; 3];
        for c in 0..3 {
            let p = rgb[c].clamp(0.0, 1.0) * last;
            let l = p.floor().min(last - 1.0);
            lo[c] = l as usize;
            f[c] = p - l;
        }

        let fx = f[0];
        let fy = f[1];
        let fz = f[2];

        let mut out = [0.0f32; 3];
        let c000 = self.node(lo[0], lo[1], lo[2]);
        let c100 = self.node(lo[0] + 1, lo[1], lo[2]);
        let c010 = self.node(lo[0], lo[1] + 1, lo[2]);
        let c110 = self.node(lo[0] + 1, lo[1] + 1, lo[2]);
        let c001 = self.node(lo[0], lo[1], lo[2] + 1);
        let c101 = self.node(lo[0] + 1, lo[1], lo[2] + 1);
        let c011 = self.node(lo[0], lo[1] + 1, lo[2] + 1);
        let c111 = self.node(lo[0] + 1, lo[1] + 1, lo[2] + 1);

        for c in 0..3 {
            out[c] = if fx >= fy {
                if fy >= fz {
                    c000[c] * (1.0 - fx) + c100[c] * (fx - fy) + c110[c] * (fy - fz) + c111[c] * fz
                } else if fx >= fz {
                    c000[c] * (1.0 - fx) + c100[c] * (fx - fz) + c101[c] * (fz - fy) + c111[c] * fy
                } else {
                    c000[c] * (1.0 - fz) + c001[c] * (fz - fx) + c101[c] * (fx - fy) + c111[c] * fy
                }
            } else {
                if fx >= fz {
                    c000[c] * (1.0 - fy) + c010[c] * (fy - fx) + c110[c] * (fx - fz) + c111[c] * fz
                } else if fy >= fz {
                    c000[c] * (1.0 - fy) + c010[c] * (fy - fz) + c011[c] * (fz - fx) + c111[c] * fx
                } else {
                    c000[c] * (1.0 - fz) + c001[c] * (fz - fy) + c011[c] * (fy - fx) + c111[c] * fx
                }
            };
        }
        out
    }

    /// Apply in place to an interleaved RGB f32 buffer (DisplayEncodedSrgb, [0,1]).
    pub fn apply(&self, rgb: &mut [f32]) {
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] = o[0];
            p[1] = o[1];
            p[2] = o[2];
        });
    }

    /// Apply with a residual strength `k`: `p' = p + k·(sample(p) − p)`.
    ///
    /// Strength is an APPLY-time knob since #1085 — the fit always produces
    /// (and the cache stores) the full-strength LUT, so `MAPLE_AUTO_LUT_STRENGTH`
    /// can never be baked into a cached artifact. Because trilinear sampling is
    /// linear in the node values and the identity grid reproduces its input,
    /// this lerp equals sampling a `with_strength(k)`-scaled LUT (up to float
    /// rounding, and up to the node clamp at the gamut corners for `k < 1`).
    /// `k == 1.0` routes through [`ColorLut::apply`] (bit-identical to the
    /// pre-#1085 full-strength apply); `k == 0.0` is an exact no-op.
    pub fn apply_with_strength(&self, rgb: &mut [f32], k: f32) {
        if k == 0.0 {
            return;
        }
        if k == 1.0 {
            self.apply(rgb);
            return;
        }
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] += k * (o[0] - p[0]);
            p[1] += k * (o[1] - p[1]);
            p[2] += k * (o[2] - p[2]);
        });
    }

    /// A copy with the residual scaled toward identity by `k`:
    /// `node' = clamp01(id + k·(node − id))`. `k == 1.0` is a plain clone.
    /// Used by the GPU fit entries to honour `MAPLE_AUTO_LUT_STRENGTH` on the
    /// RETURNED artifact while the cache keeps the canonical full-strength LUT
    /// (#1085).
    pub fn with_strength(&self, k: f32) -> ColorLut {
        if k == 1.0 {
            return self.clone();
        }
        let id = ColorLut::identity(self.size);
        let mut out = self.clone();
        for (o, i) in out.data.iter_mut().zip(&id.data) {
            *o = (i + k * (*o - i)).clamp(0.0, 1.0);
        }
        out
    }
}

/// `MAPLE_AUTO_LUT_STRENGTH` (default `1.0`) — the verify-harness knob that
/// blends the residual toward identity (`0` ⇒ exactly the #550 curve, the
/// accuracy floor). Read at APPLY/RETURN time, never at fit time (#1085).
///
/// Invalid values (non-finite, or outside `[0.0, 2.0]`) are rejected with a
/// warning and replaced by the default `1.0`.
pub fn lut_strength_from_env() -> f32 {
    let Some(env_val) = std::env::var("MAPLE_AUTO_LUT_STRENGTH").ok() else {
        return 1.0;
    };
    let strength = env_val.parse::<f32>().unwrap_or(1.0);
    if strength.is_finite() && (0.0..=2.0).contains(&strength) {
        strength
    } else {
        eprintln!(
            "MAPLE_AUTO_LUT_STRENGTH={env_val} out of range [0,2] or non-finite — using 1.0"
        );
        1.0
    }
}

/// `MAPLE_DISABLE_AUTO_LUT` — when set, the residual-LUT stage is skipped
/// ENTIRELY: no pair sampling, no fit, no cache insert, nothing applied or
/// returned (#1085; pre-fix only the apply was gated, so the fit still ran
/// and its result was cached).
pub fn lut_disabled_by_env() -> bool {
    std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_some()
}

const FIT_CONF_COUNT: f32 = 8.0; // confidence half-count: c = count / (count + FIT_CONF_COUNT)
const FIT_SMOOTH_PASSES: usize = 1; // separable 3D smoothing passes of the delta grid

/// Grid resolution of the fitted per-image LUT (nodes per axis) — the single
/// fidelity knob, chosen by cross-fixture sweep on the 17-fixture Auto gate
/// (`test_color_pipeline.sh` baseline_auto): grand-mean ΔE-vs-ACR fell 9.6 (#550
/// only) → 8.0 (N=25) → 7.8 (N=49). 49 recovers the most grid-era-budget fixtures
/// (e.g. test_0011 passes at 49 but not 33/25) and posts the best grand mean, with
/// no observed overfitting — the per-cell fit stays confidence-damped + masked-
/// smoothed, so blotch is flat (~0.6) and no body regresses vs #550. A 49³ LUT is
/// 1.4 MB; the apply is O(1)/pixel and the fit O(pixels), both N-independent.
const LUT_SIZE: usize = 49;

/// Floor on surviving `(maple, jpeg)` pairs before a LUT fit is attempted. Below
/// this the correspondence set is too sparse to constrain the LUT grid, so the
/// entry points return `None` and the caller falls back to identity (= the
/// AgX-Neutral render with no LUT layered on).
const MIN_LUT_PAIRS: usize = 256;

/// Fit a smooth Nᶟ RGB→RGB residual LUT from display-space `(maple, jpeg)` pairs.
///
/// Hard-bins every pair into its nearest grid cell, takes the per-cell mean shift
/// toward the JPEG, damps sparse cells toward identity by a count confidence
/// (`c = count / (count + FIT_CONF_COUNT)`), smooths the delta grid for cell-to-cell
/// coherence (confidence-masked — populated cells aren't diluted by empty
/// neighbours; trilinear interpolation fills empty cells at apply time), and
/// composes onto identity with `strength`. This is the O(pixels) limit of the
/// former Gaussian RBF gather — at the resolved σ the kernel had collapsed to
/// nearest-cell — so it uses ALL pairs for free in ms (no subsample, no σ). Grid
/// SIZE is the only fidelity knob. Value-keyed + smoothed ⇒ spatially coherent
/// (cannot blotch).
pub fn fit_lut_from_pairs(pairs: &[DisplayPair], size: usize, strength: f32) -> ColorLut {
    let n = size.max(2);
    let id = ColorLut::identity(n);
    if pairs.is_empty() {
        return id;
    }
    let last = (n - 1) as f32;
    let cells = n * n * n;

    // Hard-bin all pairs into nearest cells, accumulating residual + count. Rayon
    // fold/reduce keeps it O(pairs) and parallel (per-thread cell arrays merged).
    let (acc, cnt) = pairs
        .par_iter()
        .fold(
            || (vec![[0f64; 3]; cells], vec![0u32; cells]),
            |(mut acc, mut cnt), pr| {
                let cr = ((pr.maple[0].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let cg = ((pr.maple[1].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let cb = ((pr.maple[2].clamp(0.0, 1.0) * last) + 0.5) as usize;
                let idx = (cb.min(n - 1) * n + cg.min(n - 1)) * n + cr.min(n - 1);
                for c in 0..3 {
                    acc[idx][c] += (pr.jpeg[c] - pr.maple[c]) as f64;
                }
                cnt[idx] += 1;
                (acc, cnt)
            },
        )
        .reduce(
            || (vec![[0f64; 3]; cells], vec![0u32; cells]),
            |(mut a1, mut c1), (a2, c2)| {
                for i in 0..cells {
                    for k in 0..3 {
                        a1[i][k] += a2[i][k];
                    }
                    c1[i] += c2[i];
                }
                (a1, c1)
            },
        );

    // Per-cell confidence-weighted mean residual (sparse cells → identity).
    let mut delta = vec![[0f32; 3]; cells];
    for i in 0..cells {
        if cnt[i] > 0 {
            let c = cnt[i] as f32 / (cnt[i] as f32 + FIT_CONF_COUNT);
            for k in 0..3 {
                delta[i][k] = c * (acc[i][k] / cnt[i] as f64) as f32;
            }
        }
    }
    let populated: Vec<bool> = cnt.iter().map(|&c| c > 0).collect();

    for _ in 0..FIT_SMOOTH_PASSES {
        smooth3(&mut delta, &populated, n);
    }

    let mut lut = id.clone();
    for i in 0..n * n * n {
        for c in 0..3 {
            lut.data[i * 3 + c] = (lut.data[i * 3 + c] + strength * delta[i][c]).clamp(0.0, 1.0);
        }
    }
    lut
}

/// Fit a per-image color [`ColorLut`] from an ALREADY-extracted embedded
/// preview, against the developed display buffer (#1085 — the caller extracts
/// the preview once and threads it through both fits).
///
/// Mirrors #550's [`super::fit_display::fit_curve_from_preview_display`]:
/// sample display-space correspondences, gate on a minimum pair count, then
/// fit the smooth grid at [`LUT_SIZE`]. `source_rgb` is the caller's
/// interleaved RGB f32 buffer in **f32 sRGB-encoded display space**
/// ([`crate::image::ColorSpace::DisplayEncodedSrgb`], values nominally `[0, 1]`),
/// sensor-oriented (the render applies `orientation` after this stage);
/// `preview` is the SENSOR-oriented embedded JPEG.
///
/// Always fits at FULL strength — `MAPLE_AUTO_LUT_STRENGTH` is an apply-time
/// knob ([`ColorLut::apply_with_strength`] / [`ColorLut::with_strength`]), so
/// the env value can never be baked into a cached LUT (#1085; pre-fix the env
/// was read here and the scaled grid landed in the shared cache).
///
/// Returns `None` (→ identity / Neutral fallback) when too few clean pairs
/// survive ([`MIN_LUT_PAIRS`]).
pub fn fit_lut_from_preview(
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    preview: image::DynamicImage,
    cs: JpegColorSpace,
    orientation: ExifOrientation,
) -> Option<ColorLut> {
    let pairs =
        super::pairs::sample_display_pairs(source_rgb, source_w, source_h, preview, cs, orientation);
    if pairs.len() < MIN_LUT_PAIRS {
        return None;
    }
    Some(fit_lut_from_pairs(&pairs, LUT_SIZE, 1.0))
}

/// In-place separable 1-2-1 smoothing of the per-cell delta grid over each RGB
/// axis, **confidence-masked**: empty cells (no pairs) are left at identity-delta
/// (trilinear interpolation fills them at apply time) and are excluded from their
/// neighbours' blends with renormalisation, so a populated cell at the colour-
/// volume boundary isn't dragged toward identity by the empty cells outside the
/// gamut. Borders replicate (clamp).
fn smooth3(delta: &mut [[f32; 3]], populated: &[bool], n: usize) {
    let at = |r: usize, g: usize, b: usize| (b * n + g) * n + r;
    let mut tmp = delta.to_vec();
    // R axis
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let cu = at(r, g, b);
                if !populated[cu] {
                    continue;
                }
                let lo = at(r.saturating_sub(1), g, b);
                let hi = at((r + 1).min(n - 1), g, b);
                let wlo = if populated[lo] { 0.25 } else { 0.0 };
                let whi = if populated[hi] { 0.25 } else { 0.0 };
                let wsum = wlo + 0.5 + whi;
                for c in 0..3 {
                    tmp[cu][c] = (wlo * delta[lo][c] + 0.5 * delta[cu][c] + whi * delta[hi][c]) / wsum;
                }
            }
        }
    }
    delta.copy_from_slice(&tmp);
    // G axis
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let cu = at(r, g, b);
                if !populated[cu] {
                    continue;
                }
                let lo = at(r, g.saturating_sub(1), b);
                let hi = at(r, (g + 1).min(n - 1), b);
                let wlo = if populated[lo] { 0.25 } else { 0.0 };
                let whi = if populated[hi] { 0.25 } else { 0.0 };
                let wsum = wlo + 0.5 + whi;
                for c in 0..3 {
                    tmp[cu][c] = (wlo * delta[lo][c] + 0.5 * delta[cu][c] + whi * delta[hi][c]) / wsum;
                }
            }
        }
    }
    delta.copy_from_slice(&tmp);
    // B axis
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let cu = at(r, g, b);
                if !populated[cu] {
                    continue;
                }
                let lo = at(r, g, b.saturating_sub(1));
                let hi = at(r, g, (b + 1).min(n - 1));
                let wlo = if populated[lo] { 0.25 } else { 0.0 };
                let whi = if populated[hi] { 0.25 } else { 0.0 };
                let wsum = wlo + 0.5 + whi;
                for c in 0..3 {
                    tmp[cu][c] = (wlo * delta[lo][c] + 0.5 * delta[cu][c] + whi * delta[hi][c]) / wsum;
                }
            }
        }
    }
    delta.copy_from_slice(&tmp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lut_is_noop() {
        let lut = ColorLut::identity(17);
        let mut px = vec![0.2f32, 0.5, 0.8, 0.0, 1.0, 0.33];
        let before = px.clone();
        lut.apply(&mut px);
        for (a, b) in px.iter().zip(&before) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn trilinear_recovers_node_values() {
        // A LUT that adds +0.1 to red everywhere: sampling returns node+shift.
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.1).min(1.0);
        }
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!((px[0] - 0.6).abs() < 1e-3, "got {}", px[0]);
        assert!((px[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn sparse_pairs_stay_identity() {
        // A lone neutral pair leaves distant corner nodes at identity.
        let pairs = vec![DisplayPair { maple: [0.5, 0.5, 0.5], jpeg: [0.5, 0.5, 0.5] }];
        let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
        let id = ColorLut::identity(9);
        assert!((lut.node(0, 0, 0)[0] - id.node(0, 0, 0)[0]).abs() < 1e-3);
        assert!((lut.node(0, 0, 0)[2] - id.node(0, 0, 0)[2]).abs() < 1e-3);
    }

    /// #1085 strength contract: the cache stores the full-strength LUT and
    /// strength is applied at apply/return time. `apply_with_strength(_, 1.0)`
    /// must be BIT-identical to `apply` (the default path the harness gates);
    /// `0.0` must be an exact no-op; a mid `k` must lerp input → sample.
    #[test]
    fn apply_with_strength_matches_contract() {
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.2).min(1.0); // +0.2 red everywhere
        }
        let src = vec![0.4f32, 0.5, 0.6];

        let mut full = src.clone();
        lut.apply(&mut full);
        let mut k1 = src.clone();
        lut.apply_with_strength(&mut k1, 1.0);
        assert_eq!(k1, full, "k=1.0 must be bit-identical to plain apply");

        let mut k0 = src.clone();
        lut.apply_with_strength(&mut k0, 0.0);
        assert_eq!(k0, src, "k=0.0 must be an exact no-op");

        let mut half = src.clone();
        lut.apply_with_strength(&mut half, 0.5);
        for c in 0..3 {
            let expect = src[c] + 0.5 * (full[c] - src[c]);
            assert!(
                (half[c] - expect).abs() < 1e-6,
                "k=0.5 channel {c}: got {} want {expect}",
                half[c]
            );
        }
    }

    /// `with_strength` (the GPU-return scaling) agrees with the apply-time
    /// lerp away from the node clamp, and `1.0` is a plain clone.
    #[test]
    fn with_strength_scales_nodes_toward_identity() {
        let mut lut = ColorLut::identity(9);
        for n in lut.data.chunks_mut(3) {
            n[0] = (n[0] + 0.2).min(1.0);
        }
        assert_eq!(lut.with_strength(1.0), lut, "k=1.0 is a plain clone");
        let half = lut.with_strength(0.5);
        // Mid-grey is far from the clamp: scaled-LUT sample == lerped apply.
        let mut via_scaled = vec![0.4f32, 0.5, 0.6];
        half.apply(&mut via_scaled);
        let mut via_lerp = vec![0.4f32, 0.5, 0.6];
        lut.apply_with_strength(&mut via_lerp, 0.5);
        for c in 0..3 {
            assert!(
                (via_scaled[c] - via_lerp[c]).abs() < 1e-6,
                "channel {c}: scaled {} vs lerp {}",
                via_scaled[c],
                via_lerp[c]
            );
        }
    }

    #[test]
    fn recovers_uniform_shift() {
        // Pairs along the grey diagonal that all add +0.1 red → LUT boosts mid-grey red.
        let pairs: Vec<_> = (0..200)
            .map(|i| {
                let v = i as f32 / 199.0;
                DisplayPair { maple: [v, v, v], jpeg: [(v + 0.1).min(1.0), v, v] }
            })
            .collect();
        let lut = fit_lut_from_pairs(&pairs, 9, 1.0);
        let mut px = vec![0.5f32, 0.5, 0.5];
        lut.apply(&mut px);
        assert!(px[0] > 0.55, "red not boosted: {}", px[0]);
        assert!((px[1] - 0.5).abs() < 0.03 && (px[2] - 0.5).abs() < 0.03, "green/blue drifted");
    }
}
