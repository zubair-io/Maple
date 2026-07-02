//! Pure math for the #550 display-space Auto Profile fit: the EXACT
//! eval-then-box design matrix, the per-band targets, and the Chebyshev
//! (minimax) monotone curve solver. Split out of `fit_display.rs` to keep
//! that file under the 600-LOC hard budget; `fit_display` owns I/O,
//! orientation, cropping, and orchestration, and calls into here.
//!
//! No I/O — all functions are deterministic given the design matrix + targets.

use super::curve::ChannelCurve;

/// 32 evenly-spaced anchors per channel curve (mirrors `curve::ANCHORS`).
pub(super) const ANCHORS: usize = 32;

/// Gate's luma-band edges (`src/scripts/auto_profile_diff.py::LUMA_BANDS`).
/// Earlier bands are half-open `[lo, hi)`; the last is closed `[lo, hi]`.
pub(super) const LUMA_BANDS: [(f32, f32); 5] = [
    (0.00, 0.10),
    (0.10, 0.25),
    (0.25, 0.50),
    (0.50, 0.75),
    (0.75, 1.00),
];

/// Gate's minimum band population. Bands with fewer paired pixels are skipped
/// by the gate (`m.sum() < 100`) — they carry no graded target, so the fit
/// leaves their anchors at identity rather than chasing noise.
pub(super) const MIN_BAND_PIXELS: usize = 100;

/// Minimum slope between adjacent anchors to prevent flat plateaus and color banding.
/// 0.006 is ~18.6% of the identity curve's per-anchor slope (`1/(ANCHORS-1)` ≈ 0.0323
/// for `ANCHORS = 32`) — adjacent output anchors must rise by at least that much.
pub(super) const MIN_SLOPE: f32 = 0.006;

/// Band index for a JPEG luma value, replicating the gate's edge handling:
/// earlier bands are half-open `[lo, hi)`, the last band is closed `[lo, hi]`.
/// Returns `None` for luma outside `[0, 1]` (clamped inputs never hit this).
pub(super) fn band_index(luma: f32) -> Option<usize> {
    let n = LUMA_BANDS.len();
    for (i, &(lo, hi)) in LUMA_BANDS.iter().enumerate() {
        let in_band = if i == n - 1 {
            luma >= lo && luma <= hi
        } else {
            luma >= lo && luma < hi
        };
        if in_band {
            return Some(i);
        }
    }
    None
}

/// Footprint size of every JPEG pixel: the count of full-res source pixels
/// that the box downscale maps into it. Uses the SAME integer span mapping as
/// the gate's reference resample (`(o·crop)/out` .. `((o+1)·crop)/out`, each
/// span at least 1px). Indexed `[oy*out_w + ox]`.
pub(super) fn footprint_sizes(
    crop_w: usize,
    crop_h: usize,
    out_w: usize,
    out_h: usize,
) -> Vec<u32> {
    let mut row_w = vec![0u32; out_w];
    for (ox, w) in row_w.iter_mut().enumerate() {
        let x0 = (ox * crop_w) / out_w;
        let mut x1 = ((ox + 1) * crop_w) / out_w;
        if x1 <= x0 {
            x1 = x0 + 1;
        }
        *w = (x1 - x0) as u32;
    }
    let mut out = vec![0u32; out_w * out_h];
    for oy in 0..out_h {
        let y0 = (oy * crop_h) / out_h;
        let mut y1 = ((oy + 1) * crop_h) / out_h;
        if y1 <= y0 {
            y1 = y0 + 1;
        }
        let rows = (y1 - y0) as u32;
        let base = oy * out_w;
        for ox in 0..out_w {
            out[base + ox] = rows * row_w[ox];
        }
    }
    out
}

/// Build the EXACT eval-then-box per-channel design matrices `M[lane][b][a]`,
/// where the band mean of the rendered candidate equals `Σ_a M[b][a]·out[a]`.
///
/// One pass over the full-res source crop: each source pixel `p` is mapped to
/// the JPEG pixel `j` it downscales into (same integer span mapping the gate's
/// reference resample uses), weighted by `1/|F_j|` so every JPEG pixel
/// contributes total weight 1 (footprint-size-independent — the equal-per-
/// JPEG-pixel weighting the gate applies). Its channel value selects an anchor
/// bracket `(lo, frac)`; `eval = out[lo]·(1−frac) + out[lo+1]·frac`, so the
/// pixel adds `(1/|F_j|)(1−frac)` to `M[band(j)][lo]` and `(1/|F_j|)frac` to
/// `M[band(j)][lo+1]`. Finally each band row is divided by `N_b` (the JPEG-
/// pixel count in band `b`) to form the per-band MEAN operator.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_design_matrices(
    src: &[f32],
    src_stride_px: usize,
    crop_x0: usize,
    crop_y0: usize,
    crop_w: usize,
    crop_h: usize,
    out_w: usize,
    out_h: usize,
    band_of: &[usize],
    band_counts: &[usize; LUMA_BANDS.len()],
    footprint: &[u32],
) -> [[[f32; ANCHORS]; LUMA_BANDS.len()]; 3] {
    let nb = LUMA_BANDS.len();
    let mut m = [[[0.0f64; ANCHORS]; LUMA_BANDS.len()]; 3];

    // Iterate OUTPUT (JPEG) pixels and GATHER each one's source span — the same
    // structure the gate's resample uses. This composes correctly for BOTH
    // directions: on downscale a JPEG pixel gathers many source pixels; on
    // UPSCALE (e.g. test_0010: render 5040×3360 < JPEG 6720×4480) the span is a
    // single source pixel (footprint == 1 = nearest, matching Pillow BOX on
    // upscale). A source-iterating scatter would leave upscale JPEG pixels
    // empty, collapsing each band row sum to the source/JPEG area ratio.
    for oy in 0..out_h {
        let sy0 = (oy * crop_h) / out_h;
        let mut sy1 = ((oy + 1) * crop_h) / out_h;
        if sy1 <= sy0 {
            sy1 = sy0 + 1;
        }
        let jrow = oy * out_w;
        for ox in 0..out_w {
            let j = jrow + ox;
            let b = band_of[j];
            if b == usize::MAX {
                continue;
            }
            let fp = footprint[j];
            if fp == 0 {
                continue;
            }
            let inv_fp = 1.0 / fp as f64;
            let sx0 = (ox * crop_w) / out_w;
            let mut sx1 = ((ox + 1) * crop_w) / out_w;
            if sx1 <= sx0 {
                sx1 = sx0 + 1;
            }
            for sy in sy0..sy1 {
                let srow = (crop_y0 + sy) * src_stride_px + crop_x0;
                for sx in sx0..sx1 {
                    let idx = (srow + sx) * 3;
                    for lane in 0..3 {
                        let v = src[idx + lane].clamp(0.0, 1.0);
                        let scaled = v * (ANCHORS - 1) as f32;
                        let lo = (scaled.floor() as usize).min(ANCHORS - 2);
                        let frac = (scaled - lo as f32) as f64;
                        m[lane][b][lo] += inv_fp * (1.0 - frac);
                        m[lane][b][lo + 1] += inv_fp * frac;
                    }
                }
            }
        }
    }

    // Divide each band row by the JPEG-pixel count → per-band MEAN operator.
    let mut out = [[[0.0f32; ANCHORS]; LUMA_BANDS.len()]; 3];
    for lane in 0..3 {
        for b in 0..nb {
            let nbj = band_counts[b];
            if nbj == 0 {
                continue;
            }
            let inv = 1.0 / nbj as f64;
            for a in 0..ANCHORS {
                out[lane][b][a] = (m[lane][b][a] * inv) as f32;
            }
        }
    }
    out
}

/// Per-band, per-channel mean of the JPEG target. `band_target[lane][b]` is the
/// gate's target `T_{b}` for that channel. Bands below `MIN_BAND_PIXELS` carry
/// `NaN` (no target) — the solver leaves their anchors free.
pub(super) fn band_targets(
    target: &[f32],
    band_of: &[usize],
    band_counts: &[usize; LUMA_BANDS.len()],
) -> [[f32; LUMA_BANDS.len()]; 3] {
    let nb = LUMA_BANDS.len();
    let mut sum = [[0.0f64; LUMA_BANDS.len()]; 3];
    for (j, &b) in band_of.iter().enumerate() {
        if b == usize::MAX {
            continue;
        }
        for lane in 0..3 {
            sum[lane][b] += target[j * 3 + lane] as f64;
        }
    }
    let mut out = [[f32::NAN; LUMA_BANDS.len()]; 3];
    for lane in 0..3 {
        for b in 0..nb {
            if band_counts[b] >= MIN_BAND_PIXELS {
                out[lane][b] = (sum[lane][b] / band_counts[b] as f64) as f32;
            }
        }
    }
    out
}

/// Solve the per-channel Chebyshev (minimax) fit: find the monotone non-
/// decreasing 32-anchor output vector that minimises the worst per-band mean
/// bias `max_b |Σ_a M[b][a]·out[a] − T_b|`, over bands with a target.
///
/// This is a small linear program. We solve it without an external LP crate
/// (raw-core must stay WASM- and Apple-static-lib-safe) via a binary search on
/// the achievable error `t`, with an inner monotone-feasibility solve: for a
/// candidate `t`, does a monotone `out ∈ [0,1]^32` exist with every band mean
/// in `[T_b − t, T_b + t]`? The inner solve is the iterative measured-residual
/// projection — but, unlike the earlier least-squares averaging, it only needs
/// to land each band's mean INSIDE its interval (a feasibility target, not a
/// point), which is exactly what minimax requires and what the averaging
/// scheme could not express. The returned curve is the tightest feasible one.
pub(super) fn solve_minimax_monotone(
    design: &[[f32; ANCHORS]; LUMA_BANDS.len()],
    band_target: &[f32; LUMA_BANDS.len()],
    band_counts: &[usize; LUMA_BANDS.len()],
) -> ChannelCurve {
    let nb = LUMA_BANDS.len();
    let have: Vec<bool> = (0..nb).map(|b| band_counts[b] >= MIN_BAND_PIXELS).collect();
    let touched = touched_anchors(design, &have);

    // Binary search the smallest feasible half-width `t`.
    let mut lo = 0.0f32;
    let mut hi = 1.0f32;
    let mut best = identity_out();
    // 40 bisections → ~1e-12 resolution, far below the 8-bit gate quantum.
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        if let Some(out) = feasible_monotone(design, band_target, &have, mid) {
            best = out;
            hi = mid;
        } else {
            lo = mid;
        }
    }

    // Smooth-fill anchors no band touched, then assemble + monotone-guard.
    fill_untouched_monotone(&mut best, &touched);

    // Laplacian smoothing to round off sharp edges/plateaus and break color banding
    let mut next = best;
    for i in 1..ANCHORS - 1 {
        let lap = best[i - 1] - 2.0 * best[i] + best[i + 1];
        next[i] = (best[i] + 0.05 * lap).clamp(0.0, 1.0);
    }
    // Restore monotonicity with global minimum slope constraint
    pava_project(&mut next, MIN_SLOPE);
    best = next;

    let mut anchors = [(0.0f32, 0.0f32); ANCHORS];
    for (i, a) in anchors.iter_mut().enumerate() {
        a.0 = i as f32 / (ANCHORS - 1) as f32;
        a.1 = best[i];
    }
    for i in 1..ANCHORS {
        if anchors[i].1 < anchors[i - 1].1 {
            anchors[i].1 = anchors[i - 1].1;
        }
    }
    ChannelCurve { anchors }
}

/// Identity anchor outputs (input == output).
pub(super) fn identity_out() -> [f32; ANCHORS] {
    let mut out = [0.0f32; ANCHORS];
    for (i, o) in out.iter_mut().enumerate() {
        *o = i as f32 / (ANCHORS - 1) as f32;
    }
    out
}

/// Anchors touched by any band with a target (non-zero design weight).
pub(super) fn touched_anchors(
    design: &[[f32; ANCHORS]; LUMA_BANDS.len()],
    have: &[bool],
) -> Vec<bool> {
    let mut t = vec![false; ANCHORS];
    for (b, row) in design.iter().enumerate() {
        if !have[b] {
            continue;
        }
        for (a, &w) in row.iter().enumerate() {
            if w > 0.0 {
                t[a] = true;
            }
        }
    }
    t
}

fn pava_project(out: &mut [f32; ANCHORS], min_slope: f32) {
    let mut y = [0.0f32; ANCHORS];
    let max_y = 1.0 - (ANCHORS - 1) as f32 * min_slope;
    for i in 0..ANCHORS {
        let val = out[i] - i as f32 * min_slope;
        y[i] = val.clamp(0.0, max_y);
    }

    #[derive(Clone, Copy)]
    struct Block {
        value: f32,
        weight: f32,
    }
    let mut blocks = [Block {
        value: 0.0,
        weight: 0.0,
    }; ANCHORS];
    for i in 0..ANCHORS {
        blocks[i] = Block {
            value: y[i],
            weight: 1.0,
        };
    }
    let mut len = ANCHORS;

    let mut i = 0;
    while i < len - 1 {
        if blocks[i].value > blocks[i + 1].value {
            // Pool block i and block i+1
            let w_i = blocks[i].weight;
            let w_next = blocks[i + 1].weight;
            let total_w = w_i + w_next;
            let new_val = (blocks[i].value * w_i + blocks[i + 1].value * w_next) / total_w;
            blocks[i].value = new_val;
            blocks[i].weight = total_w;
            // Shift remaining blocks left
            for j in (i + 1)..(len - 1) {
                blocks[j] = blocks[j + 1];
            }
            len -= 1;
            // Backtrack to check if the new pooled block violates with the previous block
            if i > 0 {
                i -= 1;
            }
        } else {
            i += 1;
        }
    }

    // Unpack blocks back into out
    let mut idx = 0;
    for i in 0..len {
        let n = blocks[i].weight.round() as usize;
        for _ in 0..n {
            if idx < ANCHORS {
                y[idx] = blocks[i].value;
                idx += 1;
            }
        }
    }

    for i in 0..ANCHORS {
        out[i] = (y[i] + i as f32 * min_slope).clamp(0.0, 1.0);
    }
}

/// Inner feasibility solve for [`solve_minimax_monotone`]: is there a monotone
/// `out ∈ [0,1]^32` with `|Σ_a M[b][a]·out[a] − T_b| ≤ t` for every band with a
/// target? Returns such an `out` (the projection's fixed point) or `None`.
///
/// Method — projected Gauss-Seidel-style relaxation. Start at identity; each
/// sweep: measure each band's mean, and if it lies OUTSIDE `[T_b−t, T_b+t]`,
/// push its anchors toward the nearest interval edge (residual to the edge,
/// distributed by each anchor's fractional coverage of the band so bands count
/// equally). Re-project to monotone + `[0,1]` after each sweep. Converges to a
/// feasible point when one exists; declared infeasible if the worst-band error
/// stalls above `t`.
pub(super) fn feasible_monotone(
    design: &[[f32; ANCHORS]; LUMA_BANDS.len()],
    band_target: &[f32; LUMA_BANDS.len()],
    have: &[bool],
    t: f32,
) -> Option<[f32; ANCHORS]> {
    let nb = LUMA_BANDS.len();
    // Per-band anchor coverage (column sums) and total coverage, for the
    // equal-band normalisation of the update.
    let mut band_total = [0.0f64; LUMA_BANDS.len()];
    for b in 0..nb {
        if have[b] {
            band_total[b] = design[b].iter().map(|&w| w as f64).sum();
        }
    }

    let mut out = identity_out();
    const SWEEPS: usize = 800;
    for _ in 0..SWEEPS {
        let mut delta_num = [0.0f64; ANCHORS];
        let mut delta_den = [0.0f64; ANCHORS];
        let mut worst = 0.0f32;
        for b in 0..nb {
            if !have[b] {
                continue;
            }
            let mean: f32 = (0..ANCHORS).map(|a| design[b][a] * out[a]).sum();
            let t_b = band_target[b];
            // Signed distance OUTSIDE the [T_b − t, T_b + t] interval.
            let resid = if mean > t_b + t {
                (t_b + t) - mean // negative: pull down
            } else if mean < t_b - t {
                (t_b - t) - mean // positive: push up
            } else {
                0.0
            };
            worst = worst.max((mean - t_b).abs());
            if resid != 0.0 {
                let tot = band_total[b];
                if tot > 0.0 {
                    for a in 0..ANCHORS {
                        let bw = design[b][a] as f64 / tot; // fractional coverage
                        if bw > 0.0 {
                            delta_num[a] += bw * resid as f64;
                            delta_den[a] += bw;
                        }
                    }
                }
            }
        }
        // Already feasible?
        if worst <= t {
            return Some(out);
        }
        for a in 0..ANCHORS {
            if delta_den[a] > 0.0 {
                out[a] += (delta_num[a] / delta_den[a]) as f32;
            }
        }
        pava_project(&mut out, MIN_SLOPE);
    }

    // Final feasibility check after the sweep budget.
    let mut worst = 0.0f32;
    for b in 0..nb {
        if !have[b] {
            continue;
        }
        let mean: f32 = (0..ANCHORS).map(|a| design[b][a] * out[a]).sum();
        worst = worst.max((mean - band_target[b]).abs());
    }
    if worst <= t + 1e-5 {
        Some(out)
    } else {
        None
    }
}

/// Linearly interpolate untouched anchor outputs between their nearest touched
/// neighbours. Untouched anchors before the first / after the last touched
/// anchor extrapolate flat from that neighbour (clamped to display range).
pub(super) fn fill_untouched_monotone(out: &mut [f32; ANCHORS], touched: &[bool]) {
    let first = (0..ANCHORS).find(|&i| touched[i]);
    let last = (0..ANCHORS).rev().find(|&i| touched[i]);
    let (Some(first), Some(last)) = (first, last) else {
        // No anchor touched — leave the identity seed untouched.
        return;
    };
    // Leading run: linear interpolate from 0.0 to the first touched value.
    let first_val = out[first].clamp(0.0, 1.0);
    if first > 0 {
        let span = first as f32;
        for a in 0..first {
            out[a] = first_val * (a as f32 / span);
        }
    }
    // Trailing run: linear interpolate from the last touched value to 1.0.
    let last_val = out[last].clamp(0.0, 1.0);
    if last < ANCHORS - 1 {
        let span = (ANCHORS - 1 - last) as f32;
        for a in (last + 1)..ANCHORS {
            out[a] = last_val + (1.0 - last_val) * ((a - last) as f32 / span);
        }
    }
    // Interior gaps: linear interp between bracketing touched anchors.
    let mut prev = first;
    for a in (first + 1)..=last {
        if touched[a] {
            if a > prev + 1 {
                let lo = out[prev];
                let hi = out[a];
                let span = (a - prev) as f32;
                for (k, g) in ((prev + 1)..a).enumerate() {
                    let t = (k + 1) as f32 / span;
                    out[g] = lo + (hi - lo) * t;
                }
            }
            prev = a;
        }
    }
}

#[cfg(test)]
mod solver_tests {
    use super::*;

    /// Evaluate a band's mean output `Σ_a M[b][a]·curve(a_input)` for a fitted
    /// curve, mirroring the design-matrix contract.
    fn band_mean(design_row: &[f32; ANCHORS], curve: &ChannelCurve) -> f32 {
        // The design row weights anchor OUTPUTS directly; `curve.anchors[a].1`
        // is `out[a]`. Re-derive the output vector from the curve.
        (0..ANCHORS)
            .map(|a| design_row[a] * curve.anchors[a].1)
            .sum()
    }

    fn counts(all: usize) -> [usize; LUMA_BANDS.len()] {
        [all; LUMA_BANDS.len()]
    }

    /// A feasible, clearly monotone target set: each band's design row puts all
    /// weight on a single distinct anchor, with strictly increasing targets.
    /// The solver must hit every target near-exactly and stay monotone.
    #[test]
    fn hits_feasible_isolated_anchor_targets() {
        let anchors_used = [2usize, 9, 15, 22, 29];
        let targets = [0.10f32, 0.30, 0.50, 0.70, 0.90];
        let mut design = [[0.0f32; ANCHORS]; LUMA_BANDS.len()];
        for b in 0..LUMA_BANDS.len() {
            design[b][anchors_used[b]] = 1.0; // band mean == out[anchor]
        }
        let curve = solve_minimax_monotone(&design, &targets, &counts(1000));
        for b in 0..LUMA_BANDS.len() {
            let got = band_mean(&design[b], &curve);
            assert!(
                (got - targets[b]).abs() < 0.02,
                "band {b}: got {got}, want {}",
                targets[b]
            );
        }
        // Monotone non-decreasing anchors.
        for a in 1..ANCHORS {
            assert!(curve.anchors[a].1 >= curve.anchors[a - 1].1 - 1e-6);
        }
    }

    /// An infeasible target set: two bands share the SAME single anchor but
    /// demand outputs 0.2 apart. No monotone curve can satisfy both; the
    /// minimax solver must split the error to ~0.1 each (the LP optimum) rather
    /// than letting one band absorb all of it.
    #[test]
    fn splits_error_on_shared_anchor_conflict() {
        let mut design = [[0.0f32; ANCHORS]; LUMA_BANDS.len()];
        // Only bands 0 and 1 have targets; both read anchor 10.
        design[0][10] = 1.0;
        design[1][10] = 1.0;
        let mut targets = [f32::NAN; LUMA_BANDS.len()];
        targets[0] = 0.40;
        targets[1] = 0.60;
        let mut c = counts(0);
        c[0] = 1000;
        c[1] = 1000;
        let curve = solve_minimax_monotone(&design, &targets, &c);
        let e0 = (band_mean(&design[0], &curve) - 0.40).abs();
        let e1 = (band_mean(&design[1], &curve) - 0.60).abs();
        let worst = e0.max(e1);
        assert!(
            (0.08..=0.12).contains(&worst),
            "expected ~0.1 minimax split, got e0={e0} e1={e1}"
        );
    }

    /// `footprint_sizes` returns 1 for an upscale (out larger than crop) — the
    /// nearest-neighbour span that matches Pillow BOX on upscale — and the
    /// integer area for a clean integer downscale.
    #[test]
    fn footprint_handles_up_and_downscale() {
        // Upscale 2×2 crop → 4×4 out: every footprint is 1.
        let up = footprint_sizes(2, 2, 4, 4);
        assert!(up.iter().all(|&f| f == 1), "upscale footprints must be 1");
        // Downscale 4×4 crop → 2×2 out: every footprint is 2×2 = 4.
        let down = footprint_sizes(4, 4, 2, 2);
        assert!(
            down.iter().all(|&f| f == 4),
            "downscale footprints must be 4"
        );
    }

    /// `band_index` replicates the gate's edge handling: half-open earlier
    /// bands, closed final band (pure white stays in highlights).
    #[test]
    fn band_index_edges_match_gate() {
        assert_eq!(band_index(0.0), Some(0));
        assert_eq!(band_index(0.10), Some(1)); // boundary belongs to upper band
        assert_eq!(band_index(0.75), Some(4));
        assert_eq!(band_index(1.0), Some(4)); // last band closed
    }
}
