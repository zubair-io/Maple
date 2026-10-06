use super::{accumulate::accumulate, CancelToken, NlmParams};
use rayon::prelude::*;

pub(super) fn denoise(
    plane: &[f32],
    width: usize,
    height: usize,
    params: NlmParams,
    cancel: CancelToken<'_>,
) -> Vec<f32> {
    debug_assert_eq!(params.patch_radius, 2);
    if cancel.is_cancelled() {
        return plane.to_vec();
    }
    let mut output = plane.to_vec();
    let inv_norm = 1.0 / (params.h * params.h * 25.0);
    // At most one scratch set per pool worker, reused for all its tiles.
    // Scheduling changes ownership only; each pixel keeps the same reduction order.
    let bands_per_worker = height.div_ceil(32).div_ceil(rayon::current_num_threads());
    let worker_rows = bands_per_worker.max(1) * 32;
    output
        .par_chunks_mut(width * worker_rows)
        .enumerate()
        .for_each(|(worker, worker_out)| {
            if cancel.is_cancelled() {
                return;
            }
            let mut acc = vec![0.0; 256 * 32];
            let mut weights = vec![0.0; 256 * 32];
            let mut maxima = vec![0.0; 256 * 32];
            let mut horizontal = vec![0.0; 256 * 36];
            let mut differences = vec![0.0; 260];
            let mut sums = vec![0.0; 256];
            for (band, out) in worker_out.chunks_mut(width * 32).enumerate() {
                let y0 = worker * worker_rows + band * 32;
                let y1 = y0 + out.len() / width;
                for x0 in (0..width).step_by(256) {
                    let x1 = (x0 + 256).min(width);
                    let stride = x1 - x0;
                    let count = stride * (y1 - y0);
                    if cancel.is_cancelled() {
                        return;
                    }
                    acc[..count].fill(0.0);
                    weights[..count].fill(0.0);
                    maxima[..count].fill(0.0);
                    let search = params.search_radius as isize;
                    for dy in -search..=search {
                        for dx in -search..=search {
                            if cancel.is_cancelled() {
                                return;
                            }
                            if dx == 0 && dy == 0 {
                                continue;
                            }
                            let lo_x = (x0 as isize).max(2).max(2 - dx) as usize;
                            let hi_x = (x1 as isize)
                                .min(width as isize - 2)
                                .min(width as isize - 2 - dx);
                            let lo_y = (y0 as isize).max(2).max(2 - dy) as usize;
                            let hi_y = (y1 as isize)
                                .min(height as isize - 2)
                                .min(height as isize - 2 - dy);
                            if hi_x <= lo_x as isize || hi_y <= lo_y as isize {
                                continue;
                            }
                            let hi_x = hi_x as usize;
                            let hi_y = hi_y as usize;
                            let columns = hi_x - lo_x;
                            for y in lo_y - 2..hi_y + 2 {
                                let source = &plane[y * width + lo_x - 2..y * width + hi_x + 2];
                                let shifted_start =
                                    ((y as isize + dy) * width as isize + lo_x as isize - 2 + dx)
                                        as usize;
                                let shifted = &plane[shifted_start..shifted_start + columns + 4];
                                for ((d, &a), &b) in differences.iter_mut().zip(source).zip(shifted)
                                {
                                    let delta = a - b;
                                    *d = delta * delta;
                                }
                                let row = &mut horizontal
                                    [(y + 2 - lo_y) * stride..(y + 3 - lo_y) * stride];
                                for (x, value) in row[..columns].iter_mut().enumerate() {
                                    *value = (((differences[x] + differences[x + 1])
                                        + differences[x + 2])
                                        + differences[x + 3])
                                        + differences[x + 4];
                                }
                            }
                            for y in lo_y..hi_y {
                                let row = (y - lo_y) * stride;
                                for (x, value) in sums[..columns].iter_mut().enumerate() {
                                    *value = (((horizontal[row + x]
                                        + horizontal[row + stride + x])
                                        + horizontal[row + 2 * stride + x])
                                        + horizontal[row + 3 * stride + x])
                                        + horizontal[row + 4 * stride + x];
                                }
                                let shifted_start =
                                    ((y as isize + dy) * width as isize + lo_x as isize + dx)
                                        as usize;
                                let start = (y - y0) * stride + lo_x - x0;
                                accumulate(
                                    &sums[..columns],
                                    &plane[shifted_start..shifted_start + columns],
                                    &mut acc[start..start + columns],
                                    &mut weights[start..start + columns],
                                    &mut maxima[start..start + columns],
                                    inv_norm,
                                );
                            }
                        }
                    }
                    for y in y0..y1 {
                        for x in x0..x1 {
                            let i = (y - y0) * stride + x - x0;
                            let mw = maxima[i].max(1e-12);
                            out[(y - y0) * width + x] =
                                (acc[i] + mw * plane[y * width + x]) / (weights[i] + mw);
                        }
                    }
                }
            }
        });
    if cancel.is_cancelled() {
        plane.to_vec()
    } else {
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiled_matches_general_kernel_at_tile_and_image_edges() {
        for (w, h) in [(257, 65), (1025, 31), (7, 2401)] {
            let mut seed = 319u32;
            let plane: Vec<f32> = (0..w * h)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    0.4 + (seed as f32 / u32::MAX as f32) * 0.08
                })
                .collect();
            for search_radius in [1, 2, 3] {
                let params = NlmParams {
                    patch_radius: 2,
                    search_radius,
                    h: 0.02,
                };
                let n = plane.len();
                let mut diff = vec![0.0; n];
                let mut acc = vec![0.0; n];
                let mut weights = vec![0.0; n];
                let mut maxima = vec![0.0; n];
                let s = search_radius as isize;
                for dy in -s..=s {
                    for dx in -s..=s {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        super::super::process_shift(
                            &plane,
                            w,
                            h,
                            2,
                            dx,
                            dy,
                            params,
                            &[],
                            &[],
                            false,
                            &mut diff,
                            &mut acc,
                            &mut weights,
                            &mut maxima,
                        );
                    }
                }
                let got = denoise(&plane, w, h, params, CancelToken::never());
                for i in 0..n {
                    let mw = maxima[i].max(1e-12);
                    let expected = (acc[i] + mw * plane[i]) / (weights[i] + mw);
                    assert!(
                        (got[i] - expected).abs() < 1e-5,
                        "{w}x{h} s={s} pixel={i}: {} != {expected}",
                        got[i]
                    );
                }
            }
        }
    }
}
