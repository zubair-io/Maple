//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
//!
//! In the render path this layers **after** the #550 per-channel curve: the fit
//! entry points are handed the already-curved display buffer, so the sampled
//! pairs are `(curve(maple), jpeg)` and the grid carries only the cross-channel
//! residual the separable curve can't (`fit_lut_from_pairs` seeds identity and
//! adds a confidence-weighted delta, so a tiny residual ⇒ near-identity LUT ⇒
//! `strength = 0` reproduces the pure #550 curve exactly).
use std::path::Path;

use rayon::prelude::*;

use crate::image::ExifOrientation;

use super::pairs::DisplayPair;
use super::preview::{self, JpegColorSpace};

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

    /// Trilinear lookup of one RGB triplet (inputs clamped to [0,1]).
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
        let mut out = [0f32; 3];
        for c in 0..3 {
            let c000 = self.node(lo[0], lo[1], lo[2])[c];
            let c100 = self.node(lo[0] + 1, lo[1], lo[2])[c];
            let c010 = self.node(lo[0], lo[1] + 1, lo[2])[c];
            let c110 = self.node(lo[0] + 1, lo[1] + 1, lo[2])[c];
            let c001 = self.node(lo[0], lo[1], lo[2] + 1)[c];
            let c101 = self.node(lo[0] + 1, lo[1], lo[2] + 1)[c];
            let c011 = self.node(lo[0], lo[1] + 1, lo[2] + 1)[c];
            let c111 = self.node(lo[0] + 1, lo[1] + 1, lo[2] + 1)[c];
            let c00 = c000 * (1.0 - f[0]) + c100 * f[0];
            let c10 = c010 * (1.0 - f[0]) + c110 * f[0];
            let c01 = c001 * (1.0 - f[0]) + c101 * f[0];
            let c11 = c011 * (1.0 - f[0]) + c111 * f[0];
            let c0 = c00 * (1.0 - f[1]) + c10 * f[1];
            let c1 = c01 * (1.0 - f[1]) + c11 * f[1];
            out[c] = c0 * (1.0 - f[2]) + c1 * f[2];
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
}

const FIT_CONF_COUNT: f32 = 8.0; // confidence half-count: c = count / (count + FIT_CONF_COUNT)
const FIT_SMOOTH_PASSES: usize = 1; // separable 3D smoothing passes of the delta grid

/// Grid resolution of the fitted per-image LUT (nodes per axis). 17 is the de
/// facto interchange size (`.cube` default, ACR's HSM grid order) — fine enough
/// to carry a per-image color residual, coarse enough that the smooth fit stays
/// spatially coherent.
const LUT_SIZE: usize = 17;

/// Floor on surviving `(maple, jpeg)` pairs before a LUT fit is attempted. Below
/// this the correspondence set is too sparse to constrain a 17³ grid, so the
/// entry points return `None` and the caller falls back to identity (= the
/// AgX-Neutral render with no LUT layered on).
const MIN_LUT_PAIRS: usize = 256;

/// Dev-only env override for a tuning constant (sweep scaffolding; the chosen
/// value is baked back to the const before ship).
fn env_f32(key: &str, default: f32) -> f32 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}
fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

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
    // Confidence half-count knob (env = dev-only sweep scaffolding, baked to the
    // const before ship); SMOOTH passes likewise.
    let conf_count = env_f32("MAPLE_LUT_REG", FIT_CONF_COUNT);
    let smooth_passes = env_usize("MAPLE_LUT_SMOOTH", FIT_SMOOTH_PASSES);
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
            let c = cnt[i] as f32 / (cnt[i] as f32 + conf_count);
            for k in 0..3 {
                delta[i][k] = c * (acc[i][k] / cnt[i] as f64) as f32;
            }
        }
    }
    let populated: Vec<bool> = cnt.iter().map(|&c| c > 0).collect();

    if std::env::var_os("MAPLE_LUT_DEBUG").is_some() {
        let total: u64 = cnt.iter().map(|&c| c as u64).sum();
        let pop = cnt.iter().filter(|&&c| c > 0).count();
        let cmax = cnt.iter().copied().max().unwrap_or(0);
        let mut dmax = [0f32; 3];
        let mut wbias = [0f64; 3]; // pixel-weighted predicted applied shift (255)
        for i in 0..cells {
            for k in 0..3 {
                dmax[k] = dmax[k].max(delta[i][k].abs());
                wbias[k] += delta[i][k] as f64 * cnt[i] as f64;
            }
        }
        let inv = if total > 0 { 255.0 / total as f64 } else { 0.0 };
        eprintln!(
            "LUT_DEBUG bin N={n} pairs={} conf={conf_count} | cells pop={pop}/{cells} max_count={cmax} | |delta|max R/G/B={:.4}/{:.4}/{:.4} | pred applied shift R/G/B(255)={:.2}/{:.2}/{:.2}",
            pairs.len(), dmax[0], dmax[1], dmax[2],
            wbias[0] * inv, wbias[1] * inv, wbias[2] * inv,
        );
    }

    for _ in 0..smooth_passes {
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

/// Fit a per-image color [`ColorLut`] from the embedded JPEG of the RAW at
/// `raw_path`, against the developed display buffer.
///
/// Mirrors #550's [`super::fit_display::fit_curve_from_raw_display`]: extract the
/// embedded preview, detect its color space, then sample display-space
/// correspondences and fit the smooth grid. `source_rgb` is the caller's
/// interleaved RGB f32 buffer in **f32 sRGB-encoded display space**
/// ([`crate::image::ColorSpace::DisplayEncodedSrgb`], values nominally `[0, 1]`),
/// sensor-oriented (the render applies `orientation` after this stage).
///
/// Returns `None` (→ identity / Neutral fallback) when there's no embedded JPEG
/// or too few clean pairs survive ([`MIN_LUT_PAIRS`]).
pub fn fit_lut_from_raw_display<P: AsRef<Path>>(
    raw_path: P,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ColorLut> {
    let preview = preview::extract_preview(raw_path.as_ref())?;
    let cs = preview::detect_jpeg_color_space(raw_path.as_ref());
    fit_lut_from_preview(source_rgb, source_w, source_h, preview, cs, orientation)
}

/// Bytes/WASM variant of [`fit_lut_from_raw_display`]. Uses
/// [`preview::extract_preview_from_bytes`] (no exiftool fallback — WASM has no
/// subprocess access). `ext` is the file extension (e.g. `"dng"`) used as a
/// rawler format hint; pass `""` if unknown.
pub fn fit_lut_from_bytes_display(
    raw_bytes: &[u8],
    ext: &str,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ColorLut> {
    let preview = preview::extract_preview_from_bytes(raw_bytes, ext)?;
    let cs = preview::detect_jpeg_color_space_from_bytes(raw_bytes, ext);
    fit_lut_from_preview(source_rgb, source_w, source_h, preview, cs, orientation)
}

/// Shared tail of the two entry points: sample display-space pairs, gate on a
/// minimum pair count, then fit the LUT at [`LUT_SIZE`].
///
/// The strength env override mirrors #550's `MAPLE_CHROMA_STRENGTH_OVERRIDE` so
/// the verify step can render LUT-off (`k = 0` ⇒ identity) vs LUT-on (`k = 1`).
fn fit_lut_from_preview(
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
    let k = std::env::var("MAPLE_AUTO_LUT_STRENGTH")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(1.0);
    Some(fit_lut_from_pairs(&pairs, env_usize("MAPLE_LUT_SIZE", LUT_SIZE), k))
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
