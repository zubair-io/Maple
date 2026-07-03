//! Fitting entry points for the per-image residual [`ColorLut`]: hard-bin
//! display-space `(maple, jpeg)` pairs, solve the confidence-damped +
//! smoothed + gamut-feathered delta grid, and compose onto identity. Split
//! out of `lut.rs` under the 600-LOC file-size budget; contents moved
//! verbatim (the `ColorLut` struct + apply path stay in `lut.rs`, which
//! re-exports these fits).
use rayon::prelude::*;

use crate::image::ExifOrientation;

use super::lut::ColorLut;
use super::pairs::DisplayPair;
use super::preview::JpegColorSpace;

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
    // down by a line-density weight — the best (over 13 lattice directions) of
    // how populated the `FEATHER_RADIUS`-cell line through the cell is — so the
    // correction decays smoothly to identity over `FEATHER_RADIUS` cells instead
    // of dropping to zero in one step. Cells with no populated neighbour within
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
