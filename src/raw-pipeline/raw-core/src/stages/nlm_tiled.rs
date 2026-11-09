use super::{
    accumulate::{accumulate, Modulation},
    chroma::local_strength,
    CancelToken, NlmParams,
};
use rayon::prelude::*;

/// Per-pixel strength from a luminance guide and a `(slope, offset)` noise model.
#[derive(Clone, Copy)]
pub(super) struct NoiseModel<'a> {
    pub guide: &'a [f32],
    pub slope: f32,
    pub offset: f32,
}

pub(super) fn denoise(
    plane: &[f32],
    width: usize,
    height: usize,
    params: NlmParams,
    cancel: CancelToken<'_>,
    model: Option<NoiseModel<'_>>,
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
            let mut local = model.map(|_| (vec![0.0_f32; 256 * 32], vec![0_u32; 256 * 32]));
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
                    if let (Some(model), Some((norms, radii))) = (model, local.as_mut()) {
                        for y in y0..y1 {
                            for x in x0..x1 {
                                let (norm, reach) = local_strength(
                                    params,
                                    model.slope,
                                    model.offset,
                                    model.guide[y * width + x],
                                    25.0,
                                );
                                let i = (y - y0) * stride + x - x0;
                                norms[i] = norm;
                                radii[i] = reach as u32;
                            }
                        }
                    }
                    // A tile whose pixels all share one strength at full reach is
                    // the constant kernel at that strength, bit for bit.
                    let uniform = local.as_ref().and_then(|(norms, radii)| {
                        let first = norms[0];
                        (norms[..count]
                            .iter()
                            .all(|v| v.to_bits() == first.to_bits())
                            && radii[..count]
                                .iter()
                                .all(|&r| r == params.search_radius as u32))
                        .then_some(first)
                    });
                    let tile_norm = uniform.unwrap_or(inv_norm);
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
                                let modulation = local.as_ref().filter(|_| uniform.is_none()).map(
                                    |(norms, radii)| Modulation {
                                        inv_norm: &norms[start..start + columns],
                                        radii: &radii[start..start + columns],
                                        shift: dx.unsigned_abs().max(dy.unsigned_abs()) as u32,
                                    },
                                );
                                accumulate(
                                    &sums[..columns],
                                    &plane[shifted_start..shifted_start + columns],
                                    &mut acc[start..start + columns],
                                    &mut weights[start..start + columns],
                                    &mut maxima[start..start + columns],
                                    tile_norm,
                                    modulation,
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
                let got = denoise(&plane, w, h, params, CancelToken::never(), None);
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

    /// #4638: a RAW without a NoiseProfile but with a known ISO modulates
    /// strength and reach per pixel; the tiled kernel matches the general
    /// dynamic one at tile and image edges, including partial-reach pixels.
    #[test]
    fn iso_modulated_tiles_match_the_general_dynamic_kernel() {
        for (w, h) in [(257, 65), (1025, 31)] {
            let mut seed = 977u32;
            let plane: Vec<f32> = (0..w * h)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    0.2 + (seed as f32 / u32::MAX as f32) * 0.1
                })
                .collect();
            let guide: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / w as f32).collect();
            for (iso, is_chroma) in [(100, false), (400, true), (1600, false)] {
                for search_radius in [1, 2, 3] {
                    let params = NlmParams {
                        patch_radius: 2,
                        search_radius,
                        h: 0.02,
                    };
                    let n = plane.len();
                    let (reach, norms) = super::super::chroma::prepare_scaling(
                        n, params, &guide, None, iso, is_chroma,
                    );
                    if iso == 100 && search_radius == 3 {
                        assert!(reach.iter().any(|&r| r < 3), "partial reach exercised");
                        assert!(reach.iter().any(|&r| r == 3));
                    }
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
                                &reach,
                                &norms,
                                true,
                                &mut diff,
                                &mut acc,
                                &mut weights,
                                &mut maxima,
                            );
                        }
                    }
                    let (slope, offset) = super::super::get_noise_params(None, iso, is_chroma);
                    let model = NoiseModel {
                        guide: &guide,
                        slope,
                        offset,
                    };
                    let got = denoise(&plane, w, h, params, CancelToken::never(), Some(model));
                    for i in 0..n {
                        let mw = maxima[i].max(1e-12);
                        let expected = (acc[i] + mw * plane[i]) / (weights[i] + mw);
                        assert!(
                            (got[i] - expected).abs() < 1e-5,
                            "{w}x{h} iso={iso} s={s} pixel={i}: {} != {expected}",
                            got[i]
                        );
                    }
                }
            }
        }
    }
}
