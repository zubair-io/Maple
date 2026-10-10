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
                let output_hi = strip_y0 + acc_strip.len() / w;
                process_strip(
                    plane,
                    w,
                    h,
                    p,
                    dx,
                    dy,
                    params,
                    local_s_plane,
                    local_inv_norm_plane,
                    use_dynamic,
                    x_lo,
                    x_hi,
                    strip_y0,
                    strip_y0,
                    output_hi,
                    0,
                    0,
                    w,
                    acc_strip,
                    wsum_strip,
                    max_w_strip,
                    hloc,
                    colsum,
                );
            },
        );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn process_shift_region(
    plane: &[f32],
    w: usize,
    h: usize,
    params: NlmParams,
    dx: isize,
    dy: isize,
    local_s_plane: &LocalRadiusPlane,
    local_inv_norm_plane: &[f32],
    use_dynamic: bool,
    row_start: usize,
    col_start: usize,
    tile_width: usize,
    acc: &mut [f32],
    wsum: &mut [f32],
    max_w: &mut [f32],
    hloc: &mut [f32],
    colsum: &mut [f32],
) {
    let p = params.patch_radius;
    let pi = p as isize;
    let x_lo = pi.max(pi - dx).max(col_start as isize);
    let x_hi = (w as isize - 1 - pi)
        .min(w as isize - 1 - dx - pi)
        .min((col_start + tile_width - 1) as isize);
    let y_lo = pi.max(pi - dy);
    let y_hi = (h as isize - 1 - pi).min(h as isize - 1 - dy - pi);
    if x_lo > x_hi || y_lo > y_hi {
        return;
    }
    let global_lo = y_lo as usize;
    let global_end = y_hi as usize + 1;
    let output_lo = row_start.max(global_lo);
    let output_end = (row_start + acc.len() / tile_width).min(global_end);
    if output_lo >= output_end {
        return;
    }
    // Same adaptive height as process_shift: never use cropped tile height.
    let vstrip = ((global_end - global_lo) / rayon::current_num_threads().max(1))
        .clamp(32, VSTRIP_ROWS)
        .max(1);
    let first = global_lo + (output_lo - global_lo) / vstrip * vstrip;
    for strip_y0 in (first..output_end).step_by(vstrip) {
        let lo = strip_y0.max(output_lo);
        let hi = (strip_y0 + vstrip).min(output_end);
        let range = (lo - row_start) * tile_width..(hi - row_start) * tile_width;
        process_strip(
            plane,
            w,
            h,
            p,
            dx,
            dy,
            params,
            local_s_plane,
            local_inv_norm_plane,
            use_dynamic,
            x_lo as usize,
            x_hi as usize,
            strip_y0,
            lo,
            hi,
            row_start,
            col_start,
            tile_width,
            &mut acc[range.clone()],
            &mut wsum[range.clone()],
            &mut max_w[range],
            hloc,
            colsum,
        );
    }
}

// All tiles seed at the ORIGINAL global strip boundary. The prologue slides
// the same vertical accumulator to output_lo without writing outside the tile;
// restarting at a cropped tile boundary would change f32 rounding (#1472).
#[allow(clippy::too_many_arguments)]
fn process_strip(
    plane: &[f32],
    w: usize,
    _h: usize,
    p: usize,
    dx: isize,
    dy: isize,
    params: NlmParams,
    local_s_plane: &LocalRadiusPlane,
    local_inv_norm_plane: &[f32],
    use_dynamic: bool,
    x_lo: usize,
    x_hi: usize,
    strip_y0: usize,
    output_lo: usize,
    output_hi: usize,
    metadata_y0: usize,
    col_start: usize,
    tile_width: usize,
    acc_strip: &mut [f32],
    wsum_strip: &mut [f32],
    max_w_strip: &mut [f32],
    hloc: &mut [f32],
    colsum: &mut [f32],
) {
    let seed_x = p + (x_lo - p) / RESEED_STRIDE * RESEED_STRIDE;
    let diff_start = seed_x - p;
    // Halo: the vertical window over output rows [strip_y0, strip_last]
    // reads horizontal sums for source rows [strip_y0-p, strip_last+p].
    let strip_last = output_hi - 1;
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
            let ys = (src_y as isize + dy) as usize;
            let diff_end = x_hi + p + 1;
            let lo = diff_start.max((-dx).max(0) as usize);
            let hi = diff_end.min((w as isize - dx).min(w as isize) as usize);
            colsum[..lo - diff_start].fill(0.0);
            colsum[hi - diff_start..diff_end - diff_start].fill(0.0);
            for x in lo..hi {
                let xs = (x as isize + dx) as usize;
                let d = plane[src_y * w + x] - plane[ys * w + xs];
                colsum[x - diff_start] = d * d;
            }
            let src = &colsum[..];
            let hrow = &mut hloc[li * tile_width..(li + 1) * tile_width];
            let mut s = 0.0f32;
            let mut next_reseed = seed_x;
            for x in seed_x..=x_hi {
                if x == next_reseed {
                    s = 0.0;
                    for ox in (x - p)..=(x + p) {
                        s += src[ox - diff_start];
                    }
                    next_reseed = x + RESEED_STRIDE;
                } else {
                    s += src[x + p - diff_start] - src[x - p - 1 - diff_start];
                }
                if x >= x_lo {
                    hrow[x - col_start] = s;
                }
            }
        }
    }

    // (b) Vertical running window down the strip out of `hloc`. Seed
    //     the column sum at the first output row (local rows [0, 2p]).
    for x in x_lo..=x_hi {
        let mut s = 0.0f32;
        for oy in 0..=(2 * p) {
            s += hloc[oy * tile_width + x - col_start];
        }
        colsum[x - col_start] = s;
    }
    for r in 0..(output_hi - strip_y0) {
        let y = strip_y0 + r;
        if r > 0 {
            // Slide one row: +bottom halo row, −top halo row. In local
            // (hloc) coords the bottom of the window for output row y is
            // local row (y + p - src_lo), the trailing is (y - p - 1 - src_lo).
            let bot = (y + p - src_lo) * tile_width;
            let top = (y - p - 1 - src_lo) * tile_width;
            for x in x_lo..=x_hi {
                colsum[x - col_start] += hloc[bot + x - col_start] - hloc[top + x - col_start];
            }
        }
        if y < output_lo {
            continue;
        }
        let r = y - output_lo;
        let sy = (y as isize + dy) as usize;
        let shift_row = &plane[sy * w..(sy + 1) * w];
        let acc_row = &mut acc_strip[r * tile_width..(r + 1) * tile_width];
        let wsum_row = &mut wsum_strip[r * tile_width..(r + 1) * tile_width];
        let max_w_row = &mut max_w_strip[r * tile_width..(r + 1) * tile_width];
        for x in x_lo..=x_hi {
            if !use_dynamic {
                // Classic constant-h NLM: no dynamic scaling, no pruning
                let ssd = colsum[x - col_start].max(0.0);
                let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
                let inv_norm = 1.0 / (params.h * params.h * patch_area);
                let weight = fast_neg_exp(ssd * inv_norm);
                let sx = (x as isize + dx) as usize;
                acc_row[x - col_start] += weight * shift_row[sx];
                wsum_row[x - col_start] += weight;
                if weight > max_w_row[x - col_start] {
                    max_w_row[x - col_start] = weight;
                }
            } else {
                // Dynamic variance-scaled NLM
                let idx = (y - metadata_y0) * tile_width + x - col_start;
                let local_s = local_s_plane.get(idx);

                if dx.abs() > local_s || dy.abs() > local_s {
                    continue;
                }

                let ssd = colsum[x - col_start].max(0.0);
                let weight = fast_neg_exp(ssd * local_inv_norm_plane[idx]);
                let sx = (x as isize + dx) as usize;
                acc_row[x - col_start] += weight * shift_row[sx];
                wsum_row[x - col_start] += weight;
                if weight > max_w_row[x - col_start] {
                    max_w_row[x - col_start] = weight;
                }
            }
        }
    }
}
