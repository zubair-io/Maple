//! The RCD steps themselves — see the module docs in `rcd/mod.rs` for what
//! each one does and why. Everything here is pure: it reads the shared
//! read-only CFA plane and writes only into buffers the caller owns.

use crate::image::CfaPattern;

/// Floor added to both sides of the directional weight ratio. The energies
/// are sums of squared sample differences on `[0, 1]`-normalised data, so
/// `1e-5` corresponds to differences around 0.3 % of full scale — roughly a
/// low-ISO noise floor. Below it both weights relax to ½, which averages
/// the two directions instead of latching onto noise.
const DIR_EPS: f32 = 1e-5;

/// Floor on both sides of the green transport ratio, so an all-black
/// neighbourhood yields a ratio of exactly 1 (plain averaging) rather than
/// `0/0`.
const RATIO_EPS: f32 = 1e-6;

/// Ceiling on the green transport ratio. `c₀ / mean(c₀, c±2)` with both
/// samples non-negative is bounded by 2 analytically (the extreme is
/// `c±2 = 0`); this clamp is what makes that bound hold for the negative
/// samples deep-shadow noise can leave behind after black subtraction.
const RATIO_MAX: f32 = 2.0;

/// The shared, read-only view every step works against.
pub(super) struct Frame<'a> {
    /// Dense single-channel CFA plane (`demosaic::flatten_mosaic`).
    pub c: &'a [f32],
    pub w: usize,
    pub cfa: CfaPattern,
}

/// Roughness of the CFA data along one axis, over the 7 taps at offsets
/// `-3s … +3s`. Offsets `0, ±2` share the centre's CFA colour and `±1, ±3`
/// the other one, so this mixes a same-colour curvature with the
/// opposite-colour curvature (taken at both ±1 taps) and the
/// opposite-colour gradient. Every term is a second difference or a
/// symmetric first difference of *one* colour, so constant chroma scores
/// exactly zero however far apart the channels sit.
#[inline]
fn axis_energy(c: &[f32], i: usize, s: usize) -> f32 {
    let a3 = c[i - 3 * s];
    let a2 = c[i - 2 * s];
    let a1 = c[i - s];
    let a0 = c[i];
    let b1 = c[i + s];
    let b2 = c[i + 2 * s];
    let b3 = c[i + 3 * s];
    let curv_centre = a2 - 2.0 * a0 + b2;
    let curv_near = a3 - 2.0 * a1 + b1;
    let curv_far = a1 - 2.0 * b1 + b3;
    let grad = b1 - a1;
    curv_centre * curv_centre + 0.5 * (curv_near * curv_near + curv_far * curv_far) + grad * grad
}

/// Vertical / horizontal blend weights at `i` (they sum to 1). A direction
/// is favoured when the data is *smooth* along it, so the vertical weight
/// is driven by the horizontal energy.
#[inline]
fn vh_weights(c: &[f32], i: usize, w: usize) -> (f32, f32) {
    let e_v = axis_energy(c, i, w);
    let e_h = axis_energy(c, i, 1);
    let w_v = (e_h + DIR_EPS) / (e_v + e_h + 2.0 * DIR_EPS);
    (w_v, 1.0 - w_v)
}

/// Roughness along one ±45° diagonal, `d` being `w + 1` ("\") or `w − 1`
/// ("/"). Offsets `±2d` share the centre's colour, `±d` carry the opposite
/// chroma — the diagonal counterpart of [`axis_energy`].
#[inline]
fn diag_energy(c: &[f32], i: usize, d: usize) -> f32 {
    let grad = c[i + d] - c[i - d];
    let curv = c[i - 2 * d] - 2.0 * c[i] + c[i + 2 * d];
    grad * grad + curv * curv
}

/// The ratio correction: how much the centre channel changes between the
/// centre and the half-step where a green neighbour sits.
#[inline]
fn transfer(centre: f32, half_step_mean: f32) -> f32 {
    ((centre.max(0.0) + RATIO_EPS) / (half_step_mean.max(0.0) + RATIO_EPS)).min(RATIO_MAX)
}

/// Green at an R/B site, interpolated along one axis by ratio-corrected
/// transport of the two green neighbours at `±s`.
#[inline]
fn green_along(c: &[f32], i: usize, s: usize) -> f32 {
    let centre = c[i];
    let near = c[i - s];
    let far = c[i + s];
    let mean_near = 0.5 * (centre + c[i - 2 * s]);
    let mean_far = 0.5 * (centre + c[i + 2 * s]);
    0.5 * (near * transfer(centre, mean_near) + far * transfer(centre, mean_far))
}

/// Bound an interpolated chroma value to the range its own contributing
/// neighbours span.
///
/// Both chroma steps interpolate a colour *difference* `C − G` and add it
/// back to the site's green. That is only well behaved where green is
/// smooth; across a hard edge into a patch whose green is near zero the
/// difference extrapolates, and the reconstruction shoots past every value
/// it was built from — on a synthetic colour chart the raw form reached
/// −0.21 on data that is non-negative everywhere, and the develop chain's
/// pre-DCP stages then clip that to a flat zero.
///
/// Chroma on a Bayer sensor is sampled at half the green rate, so it
/// carries no detail that needs to exceed its own samples; requiring the
/// reconstruction to introduce no new extremum costs nothing where the
/// interpolation was already sane (a flat field, a ramp, any smooth region
/// lands strictly inside the range) and removes the overshoot exactly where
/// it happens. It is also what keeps the reconstruction inside the sensor's
/// non-negative range without a blanket clamp the scene-referred pipeline
/// would object to.
#[inline]
fn no_new_extrema(value: f32, neighbours: [f32; 4]) -> f32 {
    let lo = neighbours.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = neighbours.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    value.clamp(lo, hi)
}

/// Run the interior of one band. `band` is this task's slice of the output,
/// starting at row `y0`; rows `[iy0, iy1)` are the ones inside the RCD
/// interior, and `border` is the ring width the caller already filled.
pub(super) fn interior(
    f: &Frame<'_>,
    band: &mut [[f32; 3]],
    y0: usize,
    iy0: usize,
    iy1: usize,
    border: usize,
) {
    // Step 4 reads chroma one row out; step 3 reads green one row out of
    // that. Both also read one column out, and their own stencils reach a
    // further 3 / 2 — all of which the `border` ring guarantees is in frame.
    let (gy0, gy1) = (iy0 - 2, iy1 + 2);
    let (cy0, cy1) = (iy0 - 1, iy1 + 1);
    let green = green_plane(f, gy0, gy1, border);
    let chroma = chroma_plane(f, &green, gy0, cy0, cy1, border);
    assemble(f, band, y0, iy0, iy1, border, &green, &chroma, gy0, cy0);
}

/// Steps 1 + 2 — green everywhere in rows `[gy0, gy1)`. Indexed
/// `(y − gy0) * w + x`; columns outside `[border − 2, w − border + 2)` are
/// never read and stay zero.
fn green_plane(f: &Frame<'_>, gy0: usize, gy1: usize, border: usize) -> Vec<f32> {
    let w = f.w;
    let mut green = vec![0.0f32; (gy1 - gy0) * w];
    for y in gy0..gy1 {
        for x in (border - 2)..(w - border + 2) {
            let i = y * w + x;
            green[(y - gy0) * w + x] = if f.cfa.color_at(x as u32, y as u32) == 1 {
                f.c[i]
            } else {
                let (w_v, w_h) = vh_weights(f.c, i, w);
                w_v * green_along(f.c, i, w) + w_h * green_along(f.c, i, 1)
            };
        }
    }
    green
}

/// Step 3 — the full `[R, B]` pair at every non-green site in rows
/// `[cy0, cy1)`: the site's own sample plus the opposite chroma
/// interpolated on the diagonals. Green sites are left zero; nothing reads
/// them. Indexed `(y − cy0) * w + x`.
fn chroma_plane(
    f: &Frame<'_>,
    green: &[f32],
    gy0: usize,
    cy0: usize,
    cy1: usize,
    border: usize,
) -> Vec<[f32; 2]> {
    let w = f.w;
    let (d_back, d_fwd) = (w + 1, w - 1);
    let mut chroma = vec![[0.0f32; 2]; (cy1 - cy0) * w];
    for y in cy0..cy1 {
        for x in (border - 1)..(w - border + 1) {
            let colour = f.cfa.color_at(x as u32, y as u32);
            if colour == 1 {
                continue;
            }
            let i = y * w + x;
            let g_here = green[(y - gy0) * w + x];
            // Colour difference along each diagonal, blended by the
            // diagonal discrimination.
            let e_back = diag_energy(f.c, i, d_back);
            let e_fwd = diag_energy(f.c, i, d_fwd);
            let w_back = (e_fwd + DIR_EPS) / (e_back + e_fwd + 2.0 * DIR_EPS);
            let diff = |d: usize| -> f32 {
                let g_at = |j: usize| green[j - gy0 * w];
                0.5 * ((f.c[i - d] - g_at(i - d)) + (f.c[i + d] - g_at(i + d)))
            };
            let raw = g_here + w_back * diff(d_back) + (1.0 - w_back) * diff(d_fwd);
            let other = no_new_extrema(
                raw,
                [
                    f.c[i - d_back],
                    f.c[i + d_back],
                    f.c[i - d_fwd],
                    f.c[i + d_fwd],
                ],
            );
            let cell = &mut chroma[(y - cy0) * w + x];
            // colour is 0 (R) or 2 (B); index 0 holds R, index 1 holds B.
            *cell = if colour == 0 {
                [f.c[i], other]
            } else {
                [other, f.c[i]]
            };
        }
    }
    chroma
}

/// Step 4 plus the write-out: red and blue at green sites from the four
/// orthogonal neighbours' colour differences, and the already-known triple
/// at every other site.
#[allow(clippy::too_many_arguments)]
fn assemble(
    f: &Frame<'_>,
    band: &mut [[f32; 3]],
    y0: usize,
    iy0: usize,
    iy1: usize,
    border: usize,
    green: &[f32],
    chroma: &[[f32; 2]],
    gy0: usize,
    cy0: usize,
) {
    let w = f.w;
    for y in iy0..iy1 {
        for x in border..(w - border) {
            let i = y * w + x;
            let g_here = green[(y - gy0) * w + x];
            let out = &mut band[(y - y0) * w + x];
            if f.cfa.color_at(x as u32, y as u32) != 1 {
                let rb = chroma[(y - cy0) * w + x];
                *out = [rb[0], g_here, rb[1]];
                continue;
            }
            let (w_v, w_h) = vh_weights(f.c, i, w);
            // `ch` indexes the chroma pair: 0 is red, 1 is blue.
            let diff = |j: usize, ch: usize| chroma[j - cy0 * w][ch] - green[j - gy0 * w];
            let est = |ch: usize| {
                let v = 0.5 * (diff(i - w, ch) + diff(i + w, ch));
                let h = 0.5 * (diff(i - 1, ch) + diff(i + 1, ch));
                let at = |j: usize| chroma[j - cy0 * w][ch];
                no_new_extrema(
                    g_here + w_v * v + w_h * h,
                    [at(i - w), at(i + w), at(i - 1), at(i + 1)],
                )
            };
            *out = [est(0), g_here, est(1)];
        }
    }
}
