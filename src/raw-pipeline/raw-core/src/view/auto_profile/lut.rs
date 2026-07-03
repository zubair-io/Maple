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

/// Feathering radius (grid steps) for [`feather_to_identity`]'s line-density
/// probe. Chosen against TWO competing signals, not the synthetic banding
/// probe alone: a wider radius tightens the banding margin on
/// `no_second_difference_spike_across_sparse_boundary` (a synthetic worst
/// case: a 10-cell-wide populated box against a hard empty shell), but on a
/// REAL fixture's naturally porous correspondence set (see
/// [`feather_to_identity`]'s doc comment) every extra radius step attenuates
/// more genuinely-supported interior cells, regressing `baseline_auto`
/// ΔE-vs-ACR. Swept both: at radius 2 a representative real fixture retains
/// 86% of its fitted residual magnitude (42% of populated cells touched,
/// mean weight 0.88) and `baseline_auto` grand-mean ΔE matches `main` to
/// within noise; radius >= 4 pushes real-fixture attenuation past 20% of the
/// fitted signal for a banding-margin gain the ticket's synthetic probe
/// doesn't need once line-density (not graph-distance) is the measure — see
/// `MAX_SECOND_DIFF_BUDGET`'s derivation for the resulting margin at radius 2.
const FEATHER_RADIUS: u32 = 2;

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

    // Out-of-gamut feathering (#1737b): cells with no JPEG fit support sit at
    // hard-zero delta right next to a populated boundary cell that can carry
    // its full fitted delta — a one-cell-wide step the trilinear/tetrahedral
    // interpolant reproduces as a curvature spike (visible as banding /
    // posterization once the residual is large, e.g. a backlit-bokeh highlight
    // outside the JPEG's 8-bit sRGB gamut). Ramp every POPULATED cell's delta
    // down by its graph-distance to the nearest EMPTY cell, so the correction
    // decays smoothly to identity over `FEATHER_RADIUS` cells instead of
    // dropping to zero in one step. Cells with no populated neighbour within
    // the radius are untouched (already zero).
    feather_to_identity(&mut delta, &populated, n);

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

/// Ramp populated cells' deltas toward zero (identity) as they approach the
/// edge of the fit's JPEG-gamut coverage, by LINE DENSITY: the best (over 13
/// independent lattice directions) fraction of populated cells along a
/// `2·FEATHER_RADIUS`-cell line through the cell.
///
/// Two designs were tried and rejected before this one:
///
/// 1. Graph-distance to the nearest empty cell along the best of the 13
///    lines (`min` of the two signed-ray distances, `max` over the lines) —
///    correct on the synthetic `box_fit_with_out_of_gamut_shell` fixture (a
///    clean, solid, axis-aligned box) and on a purely-diagonal thin-line fit
///    (`recovers_uniform_shift`), but on a REAL fixture it flagged ~75% of
///    all populated cells as "near a boundary" (mean weight 0.45, retaining
///    only 42% of the fitted residual magnitude). A real photo's
///    `(maple, jpeg)` correspondence set is NOT a solid, voluminous blob in
///    the 49³ grid — hard-binning ~10⁷ pixels into ~10⁵ cells leaves most of
///    the volume never visited (measured ~5% cell occupancy on a
///    representative fixture), so ordinary sampling gaps scattered through an
///    otherwise well-covered region register as "empty" just as readily as a
///    true gamut-edge void — a strict unbroken-run probe hits one within a
///    few steps almost everywhere in a naturally porous set.
/// 2. Local volumetric density (fraction of ALL cells, not just those along a
///    line, populated in a `(2r+1)³` window) — tolerant of scattered holes,
///    but a real fit's correspondence set is inherently thin/sheet-like in
///    RGB space (not solid), so even deep interior cells sit at only a few
///    percent window density — indistinguishable from a genuinely thin,
///    isolated manifold (the SAME false positive `recovers_uniform_shift`
///    exists to catch), just from a different cause.
///
/// Line density combines both lessons: like (1) it only requires ONE
/// favourable direction to read "interior" (so a thin manifold's own local
/// direction, or a real fit's locally-planar/sheet orientation, reads as
/// dense without needing volumetric coverage off that direction/plane); like
/// (2) it's a FRACTION rather than a strict unbroken run, so a handful of
/// sampling-gap cells along the best line barely move the score. The result
/// tolerates real-fit porosity while still correctly reading a thin
/// synthetic line's interior as fully supported and a true isolated edge
/// cell (the ticket's backlit-bokeh highlight, with no populated neighbours
/// in any direction) as unsupported.
fn feather_to_identity(delta: &mut [[f32; 3]], populated: &[bool], n: usize) {
    let radius = FEATHER_RADIUS as isize;
    if radius == 0 {
        return;
    }
    let ni = n as isize;
    let at = |r: isize, g: isize, b: isize| ((b * ni + g) * ni + r) as usize;

    // The 13 independent directions through a cubic lattice: 3 face axes,
    // 6 face diagonals, 4 body diagonals (their negations are covered by the
    // +/- walk below, so only one representative per line is listed).
    const DIRECTIONS: [(isize, isize, isize); 13] = [
        (1, 0, 0),
        (0, 1, 0),
        (0, 0, 1),
        (1, 1, 0),
        (1, -1, 0),
        (1, 0, 1),
        (1, 0, -1),
        (0, 1, 1),
        (0, 1, -1),
        (1, 1, 1),
        (1, 1, -1),
        (1, -1, 1),
        (1, -1, -1),
    ];

    // Fraction of populated cells along one line (both signed directions,
    // up to `radius` steps each way) through `(r, g, b)`. Out-of-bounds steps
    // are excluded from both the numerator and denominator (a cell near the
    // grid edge is judged only by the portion of the line that actually
    // exists, not penalised for the grid simply ending).
    let line_density = |r: isize, g: isize, b: isize, dr: isize, dg: isize, db: isize| -> f32 {
        let mut hits = 0.0f32;
        let mut total = 0.0f32;
        for sign in [1isize, -1isize] {
            for step in 1..=radius {
                let rr = r + dr * sign * step;
                let gg = g + dg * sign * step;
                let bb = b + db * sign * step;
                if rr < 0 || rr >= ni || gg < 0 || gg >= ni || bb < 0 || bb >= ni {
                    continue;
                }
                total += 1.0;
                if populated[at(rr, gg, bb)] {
                    hits += 1.0;
                }
            }
        }
        if total > 0.0 {
            hits / total
        } else {
            0.0
        }
    };

    // Best (max) over the 13 lines — a cell only needs ONE favourable
    // direction to read as interior.
    let best_line_density = |r: isize, g: isize, b: isize| -> f32 {
        DIRECTIONS
            .iter()
            .map(|&(dr, dg, db)| line_density(r, g, b, dr, dg, db))
            .fold(0.0f32, f32::max)
    };

    // Ken Perlin's "smootherstep": the quintic ease with zero FIRST *and*
    // SECOND derivative at both t=0 and t=1, so both the empty-side join
    // (t=0) and the full-strength-interior join (t=1) are curvature-free —
    // see `MAX_SECOND_DIFF_BUDGET`'s derivation comment for the measured RED
    // number this shape produces on the synthetic banding probe.
    let smootherstep = |t: f32| {
        let t = t.clamp(0.0, 1.0);
        t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
    };

    let original = delta.to_vec();
    for b in 0..ni {
        for g in 0..ni {
            for r in 0..ni {
                let cu = at(r, g, b);
                if !populated[cu] {
                    continue;
                }
                let weight = smootherstep(best_line_density(r, g, b));
                for c in 0..3 {
                    delta[cu][c] = original[cu][c] * weight;
                }
            }
        }
    }
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

    /// #1737 (b): out-of-gamut feathering + smoothness regularization.
    ///
    /// Builds a fake JPEG fit whose `(maple, jpeg)` pairs only cover a
    /// bounded, voluminous sub-region of the RGB cube — a "backlit bokeh"
    /// stand-in: a real photograph's in-gamut midtones and shadows populate
    /// a broad swath of the cube (like `sample_display_pairs` produces for a
    /// real image), but its brightest, most saturated highlights fall outside
    /// the embedded 8-bit sRGB JPEG's gamut and leave that corner of the
    /// lattice with NO correspondence data at all. Then asserts:
    ///   1. no second-difference (curvature) spike across adjacent grid cells
    ///      along a smooth scene-linear gradient probe exceeds the derived
    ///      budget — this is the posterization/banding metric: a smooth
    ///      continuous scene must not produce a lattice kink.
    ///   2. far-out-of-gamut cells (no fit support at all) carry ZERO
    ///      residual correction, not an extrapolated / clamped copy of the
    ///      nearest fitted value.
    mod gamut_feathering {
        use super::*;

        const SIZE: usize = 17;

        /// Pairs covering a voluminous IN-GAMUT box `[0, 0.6]³` of the cube
        /// (dense random sampling, matching the shape `sample_display_pairs`
        /// produces for a real photo's midtones/shadows), each carrying a
        /// strong, roughly-uniform +0.2 lift (the backlit-bokeh stand-in: the
        /// JPEG clips/tone-maps brighter than Maple's scene-linear render).
        /// The `(0.6, 1.0]` shell of the cube — the brightest, most saturated
        /// highlights — gets NO pairs at all: no JPEG correspondence, exactly
        /// the ticket's out-of-gamut backlit-bokeh scenario.
        fn box_fit_with_out_of_gamut_shell() -> Vec<DisplayPair> {
            const IN_GAMUT_MAX: f32 = 0.6;
            let mut pairs = Vec::new();
            let mut state = 0x243f6a8885a308d3u64; // fixed seed, deterministic
            let mut next_unit = || {
                // xorshift64*, cheap deterministic PRNG — no external dep.
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 11) as f32 / (1u64 << 53) as f32
            };
            for _ in 0..20_000 {
                let r = next_unit() * IN_GAMUT_MAX;
                let g = next_unit() * IN_GAMUT_MAX;
                let b = next_unit() * IN_GAMUT_MAX;
                let lifted = |v: f32| (v + 0.2).clamp(0.0, 1.0);
                pairs.push(DisplayPair {
                    maple: [r, g, b],
                    jpeg: [lifted(r), lifted(g), lifted(b)],
                });
            }
            pairs
        }

        /// Max |second difference| of the red-channel residual delta
        /// (`sample(node) - node`) along a smooth scene-linear gradient probe
        /// that sweeps the grey diagonal from black to white — crossing
        /// straight through the populated-box / empty-shell boundary at
        /// `v ~= 0.6`. This is the discrete curvature the interpolant carries
        /// into the rendered image — a smooth continuous scene must not show
        /// a spike here, or the render bands.
        fn max_second_diff_on_diagonal(lut: &ColorLut) -> f32 {
            let n = lut.size;
            let denom = (n - 1) as f32;
            let residual = |i: usize| -> f32 {
                let v = i as f32 / denom;
                let out = lut.sample([v, v, v]);
                out[0] - v
            };
            (1..n - 1)
                .map(|i| (residual(i + 1) - 2.0 * residual(i) + residual(i - 1)).abs())
                .fold(0.0f32, f32::max)
        }

        /// RED-run derivation (#1737b): on `main` (pre-fix, no feathering),
        /// this fixture's confidence-masked smoothing leaves the last-
        /// populated cells at their full fitted delta while their untouched
        /// neighbours one step into the empty shell are hard-zero, measuring
        /// a max second difference of **0.08710** on the grey diagonal probe
        /// — a one-cell-wide kink at the populated/empty boundary. After
        /// [`feather_to_identity`] (best-of-13-lines DENSITY, smootherstep-
        /// ramped so both the empty-side and full-strength-side joins have
        /// matching zero curvature) the same fixture measures **0.07808** at
        /// [`FEATHER_RADIUS`] = 2. This budget is that post-fix number plus
        /// ~8% headroom (per repo convention: derive on RED, then add slack).
        ///
        /// [`FEATHER_RADIUS`] is deliberately NOT tuned wider to chase a
        /// bigger margin here: this fixture is a synthetic worst case (a
        /// hard-edged, deliberately unrealistic box/shell cut with a uniform
        /// +0.2 residual), and widening the radius to shrink its spike
        /// measurably regresses `baseline_auto` ΔE-vs-ACR on real fixtures
        /// (see [`FEATHER_RADIUS`]'s derivation comment) by over-feathering
        /// the naturally porous correspondence sets real photos produce. The
        /// modest margin here reflects a deliberate trade favouring real-
        /// fixture accuracy over this synthetic probe's headroom.
        const MAX_SECOND_DIFF_BUDGET: f32 = 0.0843;

        #[test]
        fn no_second_difference_spike_across_sparse_boundary() {
            let pairs = box_fit_with_out_of_gamut_shell();
            let lut = fit_lut_from_pairs(&pairs, SIZE, 1.0);
            let spike = max_second_diff_on_diagonal(&lut);
            eprintln!("DIAG spike={spike}");
            let denom = (lut.size - 1) as f32;
            for i in 0..lut.size {
                let v = i as f32 / denom;
                let out = lut.sample([v, v, v]);
                eprintln!("  i={i} v={v:.4} delta_r={:.5}", out[0] - v);
            }
            assert!(
                spike < MAX_SECOND_DIFF_BUDGET,
                "second-difference spike {spike} exceeds budget {MAX_SECOND_DIFF_BUDGET} \
                 (lattice kink at the sparse-fit boundary -> banding)"
            );
        }

        /// Far-out-of-gamut cells (no fit support, and far from the populated
        /// box) must carry ZERO residual correction — decay to identity, not
        /// an extrapolated/clamped copy of the last fitted value. Probes the
        /// brightest, most saturated corner (`r=1,g=1,b=1` and `r=1,g=0,b=0`),
        /// which the `[0, 0.6]³` box fit never reaches.
        #[test]
        fn far_out_of_gamut_corner_has_zero_correction() {
            let pairs = box_fit_with_out_of_gamut_shell();
            let lut = fit_lut_from_pairs(&pairs, SIZE, 1.0);
            let id = ColorLut::identity(SIZE);
            for (r, g, b) in [(SIZE - 1, SIZE - 1, SIZE - 1), (SIZE - 1, 0, 0)] {
                let corner = lut.node(r, g, b);
                let id_corner = id.node(r, g, b);
                for c in 0..3 {
                    assert!(
                        (corner[c] - id_corner[c]).abs() < 1e-4,
                        "far out-of-gamut corner ({r},{g},{b}) channel {c} carries \
                         correction: {} vs identity {}",
                        corner[c],
                        id_corner[c]
                    );
                }
            }
        }
    }
}
