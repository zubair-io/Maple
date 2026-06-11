//! Fast non-local-means denoising via per-offset integral images
//! (Darbon, Cupillard, Sigelle, Tupin 2008 — "Fast nonlocal filtering
//! applied to electron cryomicroscopy"). Cost is O(N · S²) per channel
//! plane, independent of patch size — the patch sum-of-squared-
//! differences becomes an O(1) integral-image rect query.
//!
//! Reference algorithm (Buades, Coll, Morel 2005):
//!   out(p) = (1/Z(p)) · Σ_{q ∈ Ω}  w(p, q) · I(q)
//!   w(p, q) = exp( -‖I_Np - I_Nq‖² / h² )
//!
//! Np / Nq are patches of size (2P+1)² centred on p and q, Ω is a
//! search window (2S+1)² centred on p. Naive cost is O(N · S² · P²);
//! the fast variant collapses the P² inner loop:
//!
//!   For each shift d = (dx, dy) in the search window:
//!     SSD_d(p) = (I(p) - I(p + d))²            // pixel plane
//!     II_d     = integral_image(SSD_d)         // O(N) once
//!     For each pixel p:
//!         PatchSSD(p, p+d) = rect_sum(II_d, p, P)  // O(1)
//!         w = exp(-PatchSSD / (h² · patch_area))
//!         acc(p) += w · I(p+d); wsum(p) += w
//!   out(p) = acc(p) / wsum(p)
//!
//! Border handling: shifts where the patch around p+d would land
//! outside the image are skipped at that pixel. The central shift
//! d=(0,0) is added at the end with weight = running max weight
//! (Buades' self-similarity correction) so the output isn't biased
//! toward the noisy centre when all other patches disagree.
//!
//! Consequence — pixels within `patch_radius` of any edge have no
//! shift for which both their own patch and the shifted patch fit
//! the image, so `wsum` and `max_w` stay zero and the post-loop
//! `max(1e-12)` clamp returns the input value unchanged. The strict
//! patch-radius strip is therefore **passed through, not denoised**.
//! This is intentional — locked in by `border_strip_passes_through_unchanged`
//! — and acceptable because the raw-pipeline draws denoising over an
//! image at full resolution; the unprocessed strip is a few pixels
//! at the edge, dominated by demosaic edge artefacts already. If we
//! ever pad or mirror the buffer to denoise the strip, update the
//! test alongside the policy change.
//!
//! # Parallelism
//!
//! Shifts run sequentially in the outer loop; each shift parallelises
//! across rows for the sqdiff fill, the integral-image row sums, and
//! the accumulator update. Scratch buffers are allocated once per
//! `denoise_plane` call and reused across all shifts.

use crate::cancel::CancelToken;
use rayon::prelude::*;

/// Fast exp(-x) lookup. The NLM weight is `exp(-d²/(h²·area))` where the
/// argument is always ≥ 0. For x ≥ `FAST_EXP_RANGE` the weight is ≤ ~3.4e-4
/// — well below the noise floor of f32 accumulation across O(1000) pixels,
/// so we clamp to 0. The bound is `≥` (not `>`) so that the `i+1` table
/// lookup stays in range — at exactly `x = FAST_EXP_RANGE`, `i = TABLE_SIZE`
/// and `table[i+1]` would be out of bounds. Inside the range we linearly
/// interpolate a 512-entry table. Measured at ~0.6 ns per call on Apple
/// Silicon (vs ~5 ns for hardware `expf`) — at 81 shifts × 2 MP, the
/// saving is ~36 ms.
const FAST_EXP_RANGE: f32 = 8.0;
const FAST_EXP_TABLE_SIZE: usize = 512;

#[inline(always)]
fn fast_neg_exp(x: f32) -> f32 {
    // Negative-input guard — defense layer 2 of 2 for #1086. In exact math
    // x = ssd·inv_norm ≥ 0, and layer 1 (the `.max(0.0)` clamp on the
    // integral-image rect query in `process_shift`) restores that in f32.
    // Unguarded, a negative x is silently catastrophic here: `t as usize`
    // saturates to 0, `frac` goes negative, and the first table segment
    // EXTRAPOLATES to ≈ 1 + |x| — a weight growing linearly in |x| instead
    // of capping at 1, letting one shift dominate the average. exp(0) = 1
    // is the correct limit for ssd → 0⁻, so return exactly 1.0.
    if x < 0.0 {
        return 1.0;
    }
    // exp(-x) ranges from 1.0 at x=0 down to ~3.4e-4 at x=8.
    if x >= FAST_EXP_RANGE {
        return 0.0;
    }
    let t = x * (FAST_EXP_TABLE_SIZE as f32 / FAST_EXP_RANGE);
    let i = t as usize;
    let frac = t - i as f32;
    let table = fast_exp_table();
    // SAFETY: i < FAST_EXP_TABLE_SIZE because x < FAST_EXP_RANGE.
    // The table has FAST_EXP_TABLE_SIZE + 1 entries to make the
    // i+1 lookup safe at the upper bound.
    let a = table[i];
    let b = table[i + 1];
    a + (b - a) * frac
}

fn fast_exp_table() -> &'static [f32; FAST_EXP_TABLE_SIZE + 1] {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[f32; FAST_EXP_TABLE_SIZE + 1]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = [0.0f32; FAST_EXP_TABLE_SIZE + 1];
        for (i, v) in t.iter_mut().enumerate() {
            let x = i as f32 * FAST_EXP_RANGE / FAST_EXP_TABLE_SIZE as f32;
            *v = (-x).exp();
        }
        t
    })
}

/// Filter parameters for a single NLM pass on one channel plane.
#[derive(Clone, Copy, Debug)]
pub struct NlmParams {
    /// Patch half-size. Patch is (2P+1)². Typical P=3 (7×7 patch).
    pub patch_radius: usize,
    /// Search half-size. Search window is (2S+1)². Typical S=4 (9×9).
    pub search_radius: usize,
    /// Filtering strength. Larger `h` = stronger smoothing. Output of
    /// the exp() weight is `exp(-d² / (h² · patch_area))`, so `h` is
    /// in the same units as the input plane (Oklab L is in [0, ~1]).
    pub h: f32,
}

/// Apply fast-NLM to a single channel plane. Out-of-place: returns a
/// new `Vec<f32>` of the same length. Caller passes `width * height`
/// row-major data.
///
/// Non-cancellable wrapper — forwards to [`denoise_plane_cancellable`]
/// with a never-cancel token, so its output is bit-identical to the
/// pre-#951 implementation. Existing callers and tests use this entry.
#[inline]
pub fn denoise_plane(plane: &[f32], w: usize, h: usize, params: NlmParams) -> Vec<f32> {
    denoise_plane_cancellable(plane, w, h, params, CancelToken::never())
}

/// Cancellable variant of [`denoise_plane`]. Identical math; additionally
/// observes `cancel` **between NLM shifts** (once per `(dx, dy)` pair) and
/// returns the untouched input (`plane.to_vec()`) the moment cancellation
/// is requested.
///
/// Checking once per shift (inside the inner `dx` loop) means worst-case
/// cancel latency is one `process_shift` call (~one-(2S+1)²-th of total
/// work) rather than one full `dy` row of shifts. The ~49 extra relaxed
/// atomic loads per pass (S=3 ⇒ 49 shifts) are negligible. The per-pixel
/// work inside `process_shift` runs through rayon and is *not* instrumented
/// — a rayon parallel iterator can't `break`, and a per-pixel atomic load
/// would add contention for no latency win.
///
/// On cancel the develop chain bails immediately after this stage (it checks
/// the same token and returns `Err(Cancelled)`), so the returned passthrough
/// buffer is discarded — it is never packed into a result. A never-cancel
/// token makes [`is_cancelled`] a no-op branch, so the completed-render path
/// is byte-for-byte unchanged.
///
/// [`is_cancelled`]: CancelToken::is_cancelled
pub fn denoise_plane_cancellable(
    plane: &[f32],
    w: usize,
    h: usize,
    params: NlmParams,
    cancel: CancelToken<'_>,
) -> Vec<f32> {
    let n = w * h;
    if plane.len() != n {
        panic!("denoise_plane: len {} != w*h = {}", plane.len(), n);
    }
    if params.h <= 0.0 || params.search_radius == 0 {
        return plane.to_vec();
    }
    let p = params.patch_radius;
    let s = params.search_radius as isize;
    let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
    let h_sq = params.h * params.h;
    let inv_norm = 1.0 / (h_sq * patch_area);

    let iw = w + 1;
    let ih = h + 1;

    // Persistent scratch — allocated once, reused across all shifts.
    let mut sqdiff = vec![0.0f32; n];
    // f32 integral-image precision at 100MP-scale offsets — structural fix
    // (sliding box-sum) tracked in #1089. Until then the rect query clamps
    // negative cancellation residue and `fast_neg_exp` guards negative
    // input (both #1086), so weights stay ≤ 1.
    let mut ii = vec![0.0f32; iw * ih];
    let mut acc = vec![0.0f32; n];
    let mut wsum = vec![0.0f32; n];
    let mut max_w = vec![0.0f32; n];

    for dy in -s..=s {
        for dx in -s..=s {
            if dx == 0 && dy == 0 {
                continue;
            }
            // Cancellation is checked once per (dx, dy) shift — inside the
            // inner loop — so worst-case cancel latency is at most one
            // process_shift call. On a never-cancel token this is a no-op
            // branch (Option::None short-circuits). Return the untouched
            // input; the develop chain discards it and returns Err(Cancelled).
            if cancel.is_cancelled() {
                return plane.to_vec();
            }
            process_shift(
                plane,
                w,
                h,
                p,
                dx,
                dy,
                inv_norm,
                &mut sqdiff,
                &mut ii,
                &mut acc,
                &mut wsum,
                &mut max_w,
            );
        }
    }

    // Add central pixel with weight = running max weight (Buades'
    // self-similarity correction), then divide.
    let mut out = vec![0.0f32; n];
    out.par_iter_mut().enumerate().for_each(|(i, dst)| {
        let mw_i = max_w[i].max(1e-12);
        let total_w = wsum[i] + mw_i;
        let total_acc = acc[i] + mw_i * plane[i];
        *dst = total_acc / total_w;
    });
    out
}

#[allow(clippy::too_many_arguments)]
fn process_shift(
    plane: &[f32],
    w: usize,
    h: usize,
    p: usize,
    dx: isize,
    dy: isize,
    inv_norm: f32,
    sqdiff: &mut [f32],
    ii: &mut [f32],
    acc: &mut [f32],
    wsum: &mut [f32],
    max_w: &mut [f32],
) {
    // 1) Build the squared-difference plane for this shift. Parallel
    //    over rows. Rows where the shifted sample lands outside the
    //    image are zeroed.
    sqdiff
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, out_row)| {
            let ys = y as isize + dy;
            if ys < 0 || ys >= h as isize {
                for v in out_row.iter_mut() {
                    *v = 0.0;
                }
                return;
            }
            let ys = ys as usize;
            let src_row = &plane[y * w..(y + 1) * w];
            let shift_row = &plane[ys * w..(ys + 1) * w];
            // Clamp both bounds to `w`. When `|dx| >= w` (which can
            // happen if `search_radius > w-1`) the naive formulas
            // produce `xs_lo > w` or `xs_hi > w` and the zero-fill
            // loops below index past the end of `out_row` — panic.
            // Clamping turns over-wide shifts into a fully-zero
            // sqdiff row, which the patch-fit guard later early-
            // returns on, so the math is unchanged for valid shifts.
            let (xs_lo, xs_hi) = if dx >= 0 {
                (0usize, w.saturating_sub(dx as usize))
            } else {
                (((-dx) as usize).min(w), w)
            };
            // Out-of-bounds region: zero.
            for x in 0..xs_lo {
                out_row[x] = 0.0;
            }
            for x in xs_hi..w {
                out_row[x] = 0.0;
            }
            for x in xs_lo..xs_hi {
                let xs = (x as isize + dx) as usize;
                let d = src_row[x] - shift_row[xs];
                out_row[x] = d * d;
            }
        });

    // 2) Integral image of sqdiff. Two passes:
    //    a) Row-wise prefix sum into ii[1..iw, 1..ih] — independent
    //       across rows, parallel.
    //    b) Column-wise prefix sum — the inter-column work is
    //       independent in principle, but a stride-iw column walk is
    //       cache-unfriendly, so we sweep sequentially over rows and
    //       vectorise across x within each row (see the inline note at
    //       the column pass). O(N) total, same asymptotic, better
    //       cache behaviour than naive per-column parallelism.
    let iw = w + 1;
    let ih = h + 1;
    // Zero the first row + first column.
    for x in 0..iw {
        ii[x] = 0.0;
    }
    for y in 0..ih {
        ii[y * iw] = 0.0;
    }

    // Row-wise: each row in ii[y, 1..iw] becomes prefix sum of
    // sqdiff[y-1, 0..w]. Parallel across rows. Each ii row is a
    // contiguous iw-element slice.
    //
    // We need mutable access to ii[1..ih, :] in chunks of iw. The
    // first row was already zeroed. Use chunks_mut so each thread
    // gets a disjoint row.
    let ii_rows = &mut ii[iw..];
    ii_rows.par_chunks_mut(iw).enumerate().for_each(|(y, row)| {
        // y is 0-based among ii_rows so corresponds to ii row (y+1)
        // and sqdiff row y.
        let src = &sqdiff[y * w..(y + 1) * w];
        row[0] = 0.0;
        let mut s = 0.0f32;
        for x in 0..w {
            s += src[x];
            row[x + 1] = s;
        }
    });
    // Column-wise: walk down each column adding the previous row's
    // value. Sequential within column — but each column is a stride-iw
    // walk, which is cache-unfriendly. Instead do the column sweep
    // sequentially over rows but inside each row vectorise across x.
    // That gives O(N) total with good cache behaviour.
    for y in 1..ih {
        let (prev_rows, cur_row) = ii.split_at_mut(y * iw);
        let prev = &prev_rows[(y - 1) * iw..y * iw];
        let row = &mut cur_row[..iw];
        for x in 0..iw {
            row[x] += prev[x];
        }
    }

    // 3) Update accumulators over the valid pixel range. The patch
    //    around p must fit AND the patch around p+(dx,dy) must fit.
    let p_isz = p as isize;
    let x_lo = p_isz.max(p_isz - dx);
    let x_hi = (w as isize - 1 - p_isz).min(w as isize - 1 - dx - p_isz);
    let y_lo = p_isz.max(p_isz - dy);
    let y_hi = (h as isize - 1 - p_isz).min(h as isize - 1 - dy - p_isz);
    if x_lo > x_hi || y_lo > y_hi {
        return;
    }
    let x_lo = x_lo as usize;
    let x_hi = x_hi as usize;
    let y_lo = y_lo as usize;
    let y_hi = y_hi as usize;

    // Parallel over rows in [y_lo..=y_hi]. We need mutable disjoint
    // slices of `acc`, `wsum`, `max_w` per row — use `par_chunks_mut`
    // on subslices of length w.
    //
    // To handle the same range across three buffers in one parallel
    // loop, zip three par_chunks_mut iterators.
    let acc_rows = &mut acc[y_lo * w..(y_hi + 1) * w];
    let wsum_rows = &mut wsum[y_lo * w..(y_hi + 1) * w];
    let max_w_rows = &mut max_w[y_lo * w..(y_hi + 1) * w];

    acc_rows
        .par_chunks_mut(w)
        .zip(wsum_rows.par_chunks_mut(w))
        .zip(max_w_rows.par_chunks_mut(w))
        .enumerate()
        .for_each(|(row_idx, ((acc_row, wsum_row), max_w_row))| {
            let y = y_lo + row_idx;
            let y0 = y - p;
            let y1 = y + p + 1;
            let sy = (y as isize + dy) as usize;
            let ii_top = &ii[y0 * iw..y0 * iw + iw];
            let ii_bot = &ii[y1 * iw..y1 * iw + iw];
            let shift_row = &plane[sy * w..(sy + 1) * w];
            for x in x_lo..=x_hi {
                let x0 = x - p;
                let x1 = x + p + 1;
                let ssd = ii_bot[x1] - ii_top[x1] - ii_bot[x0] + ii_top[x0];
                // True patch-SSD is ≥ 0, but this four-term f32 query can
                // cancel to a NEGATIVE residue when the true patch mass is
                // near zero and the integral values are large (far from the
                // origin, straddling a binade boundary). Clamp — defense
                // layer 1 of 2 for #1086; `fast_neg_exp` independently
                // guards negative input.
                let ssd = ssd.max(0.0);
                let weight = fast_neg_exp(ssd * inv_norm);
                let sx = (x as isize + dx) as usize;
                acc_row[x] += weight * shift_row[sx];
                wsum_row[x] += weight;
                if weight > max_w_row[x] {
                    max_w_row[x] = weight;
                }
            }
        });
}

// Tests live in the sibling `nlm_tests.rs` so this file stays under the
// 600-LOC budget (#951 — the in-kernel cancellation proof pushed the inline
// module over). Same `#[path]` split pattern the FFI + render modules use.
#[cfg(test)]
#[path = "nlm_tests.rs"]
mod tests;
