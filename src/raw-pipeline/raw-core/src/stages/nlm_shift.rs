//! NLM shift accumulation; fused rows retain the original global strip
//! boundaries and horizontal reseeding arithmetic (#1472).
use super::{fast_neg_exp, radius::LocalRadiusPlane, NlmParams, RESEED_STRIDE, VSTRIP_ROWS};
use rayon::prelude::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn process_shift(
    plane: &[f32],
    w: usize,
    h: usize,
    p: usize,
    dx: isize,
    dy: isize,
    params: NlmParams,
    local_s_plane: &LocalRadiusPlane,
    local_inv_norm_plane: &[f32],
    use_dynamic: bool,
    acc: &mut [f32],
    wsum: &mut [f32],
    max_w: &mut [f32],
) {
    // Squared differences and horizontal box sums are fused into the
    // existing per-worker row/strip scratch below (#1472). No full-frame
    // difference plane is written or reread for any search shift.

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
                        // Reuse colsum as the squared-difference row until the
                        // horizontal sums are complete. Vertical seeding below
                        // overwrites every column that the accumulator reads.
                        let ys = src_y as isize + dy;
                        if ys < 0 || ys >= h as isize {
                            colsum.fill(0.0);
                        } else {
                            let src_row = &plane[src_y * w..(src_y + 1) * w];
                            let shift_y = ys as usize;
                            let shift_row = &plane[shift_y * w..(shift_y + 1) * w];
                            let (xs_lo, xs_hi) = if dx >= 0 {
                                (0usize, w.saturating_sub(dx as usize))
                            } else {
                                (((-dx) as usize).min(w), w)
                            };
                            colsum[..xs_lo].fill(0.0);
                            colsum[xs_hi..].fill(0.0);
                            for x in xs_lo..xs_hi {
                                let xs = (x as isize + dx) as usize;
                                let d = src_row[x] - shift_row[xs];
                                colsum[x] = d * d;
                            }
                        }
                        let src = &colsum[..];
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
                            let local_s = local_s_plane.get(idx);

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
