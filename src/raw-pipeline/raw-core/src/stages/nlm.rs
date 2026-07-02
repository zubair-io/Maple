//! Fast non-local-means denoising via a per-offset SEPARABLE SLIDING BOX-SUM
//! of the squared-difference plane. Cost is O(N · S²) per channel plane,
//! independent of patch size — the patch sum-of-squared-differences becomes a
//! horizontal running-window sum followed by a vertical (2P+1)-tap sum, both
//! O(1)/O(P) per pixel with no auxiliary prefix buffer.
//!
//! This replaces the original per-offset integral image (Darbon, Cupillard,
//! Sigelle, Tupin 2008) — see #1195. The integral image collapsed the P² inner
//! loop into a four-corner rect query, but it streamed a full (w+1)×(h+1) f32
//! prefix buffer per shift (~404 MB/shift at 100 MP — memory-bandwidth-bound,
//! the proven reason threading couldn't speed it up), and the four-corner
//! difference of two large global prefixes could cancel to a negative residue
//! at 100 MP-scale offsets (#1086). The sliding box-sum keeps only a LOCAL
//! window, so it removes that buffer traffic AND the cancellation in one move.
//!
//! Reference algorithm (Buades, Coll, Morel 2005):
//!   out(p) = (1/Z(p)) · Σ_{q ∈ Ω}  w(p, q) · I(q)
//!   w(p, q) = exp( -‖I_Np - I_Nq‖² / h² )
//!
//! Np / Nq are patches of size (2P+1)² centred on p and q, Ω is a
//! search window (2S+1)² centred on p. Naive cost is O(N · S² · P²);
//! the box-sum collapses the P² inner loop:
//!
//!   For each shift d = (dx, dy) in the search window:
//!     SSD_d(p) = (I(p) - I(p + d))²            // pixel plane
//!     H_d(p)   = Σ_{ox=-P}^{P} SSD_d(p + ox)   // running window, O(1)/px
//!     For each pixel p:
//!         PatchSSD(p, p+d) = Σ_{oy=-P}^{P} H_d(p + oy·row)  // (2P+1) taps
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
//! Shifts run sequentially in the outer loop. Within a shift, the sqdiff fill
//! parallelises across rows; the box-sum + accumulate parallelises across
//! horizontal STRIPS of output rows — each strip computes its own halo'd
//! horizontal sums into a thread-local buffer (recycled across strips, so no
//! full-frame box-sum plane round-trips through DRAM) and slides the vertical
//! window down out of it. The persistent sqdiff/acc/wsum/max_w buffers are
//! allocated once per `denoise_plane` call and reused across all shifts.

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

/// Re-seed stride for the running box-sum windows (#1195). Both box-sum passes
/// maintain a sliding window (`s += leading − trailing`) for O(1)-per-pixel
/// cost, but an f32 running accumulator inherits one rounding step per slide,
/// so across a 100MP-scale row/column the drift would grow without bound (it
/// reached ~1e-3 on an 11600-wide row — enough to breach the GPU `< 1e-4`
/// parity gate). Every `RESEED_STRIDE` steps we recompute the window directly
/// from its (2p+1) taps, re-anchoring the accumulator. This caps the worst-case
/// drift at ~`RESEED_STRIDE · eps · |window|` ≈ 256 · 6e-8 · 0.1 ≈ 1.5e-6 — three
/// orders under the gate — while keeping the amortized cost at ~2 ops/pixel plus
/// one direct re-sum per stride. 256 keeps the re-anchor overhead negligible
/// (≈ (2p+1)/256 extra adds/pixel) and the drift comfortably bounded.
const RESEED_STRIDE: usize = 256;

/// MAXIMUM output-row strip height for the parallel vertical box-sum (#1195).
/// The vertical running window is sequential down a column, so the accumulate
/// pass parallelises over STRIPS of consecutive output rows; each strip seeds
/// its own column-window directly at its first row, which re-anchors vertical
/// drift at every strip boundary. The actual strip height is chosen adaptively
/// (~1 strip per worker, i.e. `band_rows / threads`, clamped to
/// `[MIN_STRIP_ROWS, VSTRIP_ROWS]`) so that every core gets roughly one strip
/// without over-fragmenting the cache-resident 2MP tick. This value caps strip
/// height so that (a) vertical drift inside a strip stays ≤ RESEED_STRIDE
/// steps and (b) locality stays high on the 100MP refine. 256 keeps an 8700-row
/// refine at ~34 strips while bounding drift to ~256·eps·|colsum| ≈ 4e-6.
const VSTRIP_ROWS: usize = 256;

#[inline(always)]
fn fast_neg_exp(x: f32) -> f32 {
    // Negative-input guard — defense layer 2 of 2 for #1086. Post-#1195 the
    // box-sum patch SSD is a sum of squares over a LOCAL window and is ≥ 0 by
    // construction (no global-prefix cancellation), so x = ssd·inv_norm ≥ 0 and
    // layer 1 (the `.max(0.0)` clamp in `process_shift`) is belt-and-braces.
    // This guard is kept as cheap insurance: unguarded, a negative x is silently
    // catastrophic here — `t as usize` saturates to 0, `frac` goes negative, and
    // the first table segment EXTRAPOLATES to ≈ 1 + |x|, a weight growing
    // linearly in |x| instead of capping at 1, letting one shift dominate the
    // average. exp(0) = 1
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
    denoise_plane_cancellable(
        plane,
        w,
        h,
        params,
        CancelToken::never(),
        plane,
        None,
        0,
        false,
    )
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
    l_plane: &[f32],
    noise_profile: Option<&[f32]>,
    iso: u32,
    is_chroma: bool,
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

    let use_dynamic = noise_profile.is_some();
    let (s_coeff, o_coeff) = if use_dynamic {
        get_noise_params(noise_profile, iso, is_chroma)
    } else {
        (0.0, 0.0)
    };

    let mut local_s_plane = Vec::new();
    let mut local_inv_norm_plane = Vec::new();
    if use_dynamic {
        let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
        local_s_plane = vec![0isize; n];
        local_inv_norm_plane = vec![0.0f32; n];
        local_s_plane
            .par_iter_mut()
            .zip(local_inv_norm_plane.par_iter_mut())
            .zip(l_plane.par_iter())
            .for_each(|((s_out, inv_norm_out), &l_val)| {
                let local_l = l_val.clamp(0.0, 10.0);
                let var = s_coeff * local_l + o_coeff;
                let sigma = var.max(0.0).sqrt();
                let scale = (sigma / 0.002366).clamp(0.1, 10.0);

                let local_h = params.h * scale;
                let local_h_sq = local_h * local_h;
                *inv_norm_out = 1.0 / (local_h_sq * patch_area);

                let local_s = (params.search_radius as f32 * scale).round() as isize;
                *s_out = local_s.clamp(1, params.search_radius as isize);
            });
    }

    // Persistent scratch — allocated once, reused across all shifts. (#1195
    // replaced the per-shift (w+1)×(h+1) f32 integral image with a FUSED
    // separable sliding box-sum: the horizontal sums are computed per strip into
    // thread-local scratch inside `process_shift`, so no full-frame prefix or
    // box-sum plane is allocated here — only the sqdiff plane and the three
    // accumulators. The box-sum forms the patch SSD from a LOCAL window, so the
    // #1086 global-prefix f32 cancellation cannot arise and the `ssd.max(0.0)`
    // in `process_shift` is now belt-and-braces.)
    let mut sqdiff = vec![0.0f32; n];
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
                params,
                &local_s_plane,
                &local_inv_norm_plane,
                use_dynamic,
                &mut sqdiff,
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

#[inline(always)]
fn get_noise_params(profile: Option<&[f32]>, iso: u32, is_chroma: bool) -> (f32, f32) {
    if iso == 0 {
        return (0.0, 0.0);
    }
    if let Some(prof) = profile {
        if prof.len() >= 6 {
            let (sr, or, sg, og, sb, ob) = if prof.len() >= 8 {
                let sg = 0.5 * (prof[2] + prof[4]);
                let og = 0.5 * (prof[3] + prof[5]);
                (prof[0], prof[1], sg, og, prof[6], prof[7])
            } else {
                (prof[0], prof[1], prof[2], prof[3], prof[4], prof[5])
            };
            if is_chroma {
                (0.5 * (sr + sb), 0.5 * (or + ob))
            } else {
                let s_luma = 0.2627 * sr + 0.6780 * sg + 0.0593 * sb;
                let o_luma = 0.2627 * 0.2627 * or + 0.6780 * 0.6780 * og + 0.0593 * 0.0593 * ob;
                (s_luma, o_luma)
            }
        } else if prof.len() >= 2 {
            (prof[0], prof[1])
        } else {
            fallback_noise_params(iso)
        }
    } else {
        fallback_noise_params(iso)
    }
}

#[inline(always)]
fn fallback_noise_params(iso: u32) -> (f32, f32) {
    let ratio = iso as f32 / 100.0;
    (0.00002 * ratio, 0.000002 * ratio * ratio)
}

#[allow(clippy::too_many_arguments)]
fn process_shift(
    plane: &[f32],
    w: usize,
    h: usize,
    p: usize,
    dx: isize,
    dy: isize,
    params: NlmParams,
    local_s_plane: &[isize],
    local_inv_norm_plane: &[f32],
    use_dynamic: bool,
    sqdiff: &mut [f32],
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

    // 2) The horizontal box-sum (inner half of the separable patch sum) is FUSED
    //    into the accumulate strips below — each strip computes the horizontal
    //    sums for just its halo'd rows into a thread-local buffer, so the
    //    full-frame `hsum` plane never round-trips through DRAM. See step 3.

    // 3) Update accumulators over the valid pixel range. The patch around p must
    //    fit AND the patch around p+(dx,dy) must fit. The patch-SSD is the
    //    separable vertical sum of the horizontal box-sums:
    //        ssd(x,y) = Σ_{oy=-p}^{p} hsum[(y+oy)*w + x]
    //    i.e. Σ_oy (Σ_ox sqdiff). The vertical sum is itself a RUNNING WINDOW
    //    down each column (`colsum[x] += hsum[(y+p)] − hsum[(y−p−1)]`), so each
    //    horizontal-sum element is touched once per output row — contiguous,
    //    cache-friendly reads, no (2p+1)× strided re-reads. The column window is
    //    sequential, so we parallelise over STRIPS of consecutive output rows
    //    (height chosen adaptively below); each strip seeds its own colsum
    //    directly at its first row (a direct (2p+1)-row sum), which also
    //    re-anchors vertical drift at every strip boundary.
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

    // Chunk acc/wsum/max_w into strips of consecutive output rows over
    // [y_lo, y_hi] and process each strip as a FUSED separable box-sum: the
    // horizontal sums for the strip's rows (plus the p-row halo above and below
    // the vertical window needs) are computed into a small THREAD-LOCAL buffer,
    // and the vertical running window slides down the strip out of that buffer.
    // No full-frame horizontal-sum plane is therefore written to or read from
    // DRAM — that is the bandwidth win over the integral image (which streamed
    // its (w+1)×(h+1) prefix buffer twice). The horizontal sums live only in the
    // per-thread `hloc` strip scratch, recycled across strips via `for_each_init`
    // (one alloc per worker, not per strip), so the render loop adds no
    // per-pixel/per-tick allocation.
    //
    // Strip height trades parallelism against per-strip seed/locality overhead:
    // target ~`threads` strips so every core gets work without over-fragmenting
    // (over-fine strips regress the cache-resident 2MP tick), a MIN to amortise
    // the seed, and a MAX of VSTRIP_ROWS to bound vertical drift (≤ RESEED_STRIDE)
    // and keep the strip scratch small on the 100MP refine.
    let band_rows = y_hi - y_lo + 1;
    let threads = rayon::current_num_threads().max(1);
    const MIN_STRIP_ROWS: usize = 32;
    let vstrip = (band_rows / threads)
        .clamp(MIN_STRIP_ROWS, VSTRIP_ROWS)
        .max(1);
    let strip_len = vstrip * w;
    // Thread-local horizontal-sum scratch: at most (VSTRIP_ROWS + 2p) rows ×
    // w cols. Sized for the cap so it is allocated once per worker and reused.
    let hloc_rows = VSTRIP_ROWS + 2 * p;

    let acc_band = &mut acc[y_lo * w..(y_hi + 1) * w];
    let wsum_band = &mut wsum[y_lo * w..(y_hi + 1) * w];
    let max_w_band = &mut max_w[y_lo * w..(y_hi + 1) * w];
    let x_last = w.saturating_sub(1 + p);

    acc_band
        .par_chunks_mut(strip_len)
        .zip(wsum_band.par_chunks_mut(strip_len))
        .zip(max_w_band.par_chunks_mut(strip_len))
        .enumerate()
        .for_each_init(
            // One scratch buffer per worker thread, reused across its strips:
            // (hloc horizontal-sum strip, colsum vertical-window row).
            || (vec![0.0f32; hloc_rows * w], vec![0.0f32; w]),
            |(hloc, colsum), (strip_idx, ((acc_strip, wsum_strip), max_w_strip))| {
                let strip_y0 = y_lo + strip_idx * vstrip;
                let rows_in_strip = acc_strip.len() / w;
                // Halo: the vertical window over output rows [strip_y0, strip_last]
                // reads horizontal sums for source rows [strip_y0-p, strip_last+p].
                let strip_last = strip_y0 + rows_in_strip - 1;
                let src_lo = strip_y0 - p;
                let src_hi = strip_last + p;

                // (a) Horizontal box-sum for the halo'd strip into `hloc`, indexed
                //     by local row (src_row - src_lo). Sliding window + periodic
                //     re-seed, exactly as the full-frame pass — but cache-resident.
                if w > 2 * p {
                    for src_y in src_lo..=src_hi {
                        let li = src_y - src_lo;
                        let src = &sqdiff[src_y * w..(src_y + 1) * w];
                        let hrow = &mut hloc[li * w..(li + 1) * w];
                        let mut s = 0.0f32;
                        let mut next_reseed = p;
                        for x in p..=x_last {
                            if x == next_reseed {
                                s = 0.0;
                                for ox in (x - p)..=(x + p) {
                                    s += src[ox];
                                }
                                next_reseed = x + RESEED_STRIDE;
                            } else {
                                s += src[x + p] - src[x - p - 1];
                            }
                            hrow[x] = s;
                        }
                    }
                }

                // (b) Vertical running window down the strip out of `hloc`. Seed
                //     the column sum at the first output row (local rows [0, 2p]).
                for (x, cs) in colsum.iter_mut().enumerate().take(x_hi + 1).skip(x_lo) {
                    let mut s = 0.0f32;
                    for oy in 0..=(2 * p) {
                        s += hloc[oy * w + x];
                    }
                    *cs = s;
                }
                for r in 0..rows_in_strip {
                    let y = strip_y0 + r;
                    if r > 0 {
                        // Slide one row: +bottom halo row, −top halo row. In local
                        // (hloc) coords the bottom of the window for output row y is
                        // local row (y + p - src_lo), the trailing is (y - p - 1 - src_lo).
                        let bot = (y + p - src_lo) * w;
                        let top = (y - p - 1 - src_lo) * w;
                        for x in x_lo..=x_hi {
                            colsum[x] += hloc[bot + x] - hloc[top + x];
                        }
                    }
                    let sy = (y as isize + dy) as usize;
                    let shift_row = &plane[sy * w..(sy + 1) * w];
                    let acc_row = &mut acc_strip[r * w..(r + 1) * w];
                    let wsum_row = &mut wsum_strip[r * w..(r + 1) * w];
                    let max_w_row = &mut max_w_strip[r * w..(r + 1) * w];
                    for x in x_lo..=x_hi {
                        if !use_dynamic {
                            // Classic constant-h NLM: no dynamic scaling, no pruning
                            let ssd = colsum[x].max(0.0);
                            let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
                            let inv_norm = 1.0 / (params.h * params.h * patch_area);
                            let weight = fast_neg_exp(ssd * inv_norm);
                            let sx = (x as isize + dx) as usize;
                            acc_row[x] += weight * shift_row[sx];
                            wsum_row[x] += weight;
                            if weight > max_w_row[x] {
                                max_w_row[x] = weight;
                            }
                        } else {
                            // Dynamic variance-scaled NLM
                            let idx = y * w + x;
                            let local_s = local_s_plane[idx];

                            if dx.abs() > local_s || dy.abs() > local_s {
                                continue;
                            }

                            let ssd = colsum[x].max(0.0);
                            let weight = fast_neg_exp(ssd * local_inv_norm_plane[idx]);
                            let sx = (x as isize + dx) as usize;
                            acc_row[x] += weight * shift_row[sx];
                            wsum_row[x] += weight;
                            if weight > max_w_row[x] {
                                max_w_row[x] = weight;
                            }
                        }
                    }
                }
            },
        );
}

// Tests live in the sibling `nlm_tests.rs` so this file stays under the
// 600-LOC budget (#951 — the in-kernel cancellation proof pushed the inline
// module over). Same `#[path]` split pattern the FFI + render modules use.
#[cfg(test)]
#[path = "nlm_tests.rs"]
mod tests;
