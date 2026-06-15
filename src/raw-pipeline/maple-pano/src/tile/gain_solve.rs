//! Canvas-space gain solve for the tiled multiband composite (#1291).
//!
//! [`solve_gains_canvas_space`] computes per-frame gains by sampling the
//! canvas at a strided grid and projecting each grid point back into the
//! source frames — **no full-canvas warp allocation needed**.
//!
//! The sample set and arithmetic are identical to [`crate::gain::solve_gains_tile`]
//! operating on pre-warped full-canvas layers: for each strided canvas point
//! `(rx, ry)` where both frames `i` and `j` are valid, the bicubic value at
//! the corresponding source coordinate is accumulated. The resulting statistics
//! feed the same linear solver.

use rayon::prelude::*;

use crate::error::PanoError;
use crate::gain::{solve_dense, GainMode, GainOptions, PairStats};
use crate::ingest::PlanarImage;

use super::placement::{TileCanvasSpec, TilePose};
use super::warp::{inverse_similarity_with_offset, sample_bicubic};

/// Solve per-frame gains without materializing full-canvas warp buffers.
///
/// Iterates the same strided canvas grid as [`crate::gain::solve_gains_tile`].
/// For each canvas grid point `(rx, ry)` where both frame `i` and frame `j`
/// are valid, the canvas-space pixel values (computed via inverse-similarity
/// reprojection + bicubic sample) are accumulated into per-pair sums.
///
/// Returns `Vec<[f32; 3]>` of per-channel gains, parallel to `frames`/`poses`.
pub(super) fn solve_gains_canvas_space(
    frames: &[PlanarImage],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &GainOptions,
) -> Result<Vec<[f32; 3]>, PanoError> {
    let n = frames.len();
    debug_assert_eq!(n, poses.len());

    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![[1.0, 1.0, 1.0]]);
    }
    if !(opts.sigma_n > 0.0 && opts.sigma_g > 0.0) || opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_gains_canvas_space: sigma_n, sigma_g and sample_stride must be positive".into(),
        ));
    }

    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let stride = opts.sample_stride as usize;

    // Pre-compute inverse similarities (canvas → source) for each pose.
    let inv_sims: Vec<_> = poses
        .iter()
        .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
        .collect();

    // Pre-compute source frame dimensions for the in-bounds gate that
    // `warp_to_tile_canvas` applies before calling `sample_bicubic`.
    let frame_dims: Vec<(f64, f64)> = frames
        .iter()
        .map(|f| (f.width() as f64, f.height() as f64))
        .collect();

    let pairs: Vec<(usize, usize)> = (0..n)
        .flat_map(|i| ((i + 1)..n).map(move |j| (i, j)))
        .collect();

    let pair_stats: Vec<Option<PairStats>> = pairs
        .par_iter()
        .map(|&(i, j)| {
            let fi = &frames[i];
            let fj = &frames[j];
            let inv_i = &inv_sims[i];
            let inv_j = &inv_sims[j];
            let (fw_i, fh_i) = frame_dims[i];
            let (fw_j, fh_j) = frame_dims[j];

            let mut count = 0usize;
            let mut sum_i = [0.0_f64; 3];
            let mut sum_j = [0.0_f64; 3];

            // Walk the canvas at stride — same grid as `solve_gains_tile`.
            for ry in (0..ch).step_by(stride) {
                for rx in (0..cw).step_by(stride) {
                    let cx = rx as f64 + 0.5;
                    let cy = ry as f64 + 0.5;

                    // Map canvas → source frame i (same in-bounds gate as warp).
                    let (fix, fiy) = inv_i.apply(cx, cy);
                    if fix < 0.0 || fix > fw_i || fiy < 0.0 || fiy > fh_i {
                        continue;
                    }
                    let Some(vi) = sample_bicubic(fi, fix - 0.5, fiy - 0.5) else {
                        continue;
                    };

                    // Map canvas → source frame j.
                    let (fjx, fjy) = inv_j.apply(cx, cy);
                    if fjx < 0.0 || fjx > fw_j || fjy < 0.0 || fjy > fh_j {
                        continue;
                    }
                    let Some(vj) = sample_bicubic(fj, fjx - 0.5, fjy - 0.5) else {
                        continue;
                    };

                    // Clamp to 0, matching `warp_to_tile_canvas`'s `.max(0.0)`.
                    sum_i[0] += vi[0].max(0.0) as f64;
                    sum_i[1] += vi[1].max(0.0) as f64;
                    sum_i[2] += vi[2].max(0.0) as f64;
                    sum_j[0] += vj[0].max(0.0) as f64;
                    sum_j[1] += vj[1].max(0.0) as f64;
                    sum_j[2] += vj[2].max(0.0) as f64;
                    count += 1;
                }
            }

            if count >= opts.min_overlap_samples.max(1) {
                Some(PairStats {
                    i,
                    j,
                    count,
                    sum_i,
                    sum_j,
                })
            } else {
                None
            }
        })
        .collect();

    let stats: Vec<PairStats> = pair_stats.into_iter().flatten().collect();

    // Build and solve the same linear system as `solve_gains_tile`.
    let solves: &[&[usize]] = match opts.mode {
        GainMode::Scalar => &[&[0, 1, 2]],
        GainMode::PerChannel => &[&[0], &[1], &[2]],
    };
    let mut gains = vec![[1.0_f32; 3]; n];
    for channels in solves {
        let mut a = vec![vec![0.0_f64; n]; n];
        let mut b = vec![0.0_f64; n];
        let w_anchor = 1.0 / (opts.sigma_g * opts.sigma_g);
        for i in 0..n {
            a[i][i] += w_anchor;
            b[i] += w_anchor;
        }
        for s in &stats {
            let inv = 1.0 / (s.count as f64 * channels.len() as f64);
            let mi: f64 = channels.iter().map(|&c| s.sum_i[c]).sum::<f64>() * inv;
            let mj: f64 = channels.iter().map(|&c| s.sum_j[c]).sum::<f64>() * inv;
            if !(mi.is_finite() && mj.is_finite()) || mi.abs() < 1e-9 || mj.abs() < 1e-9 {
                continue;
            }
            let nf = s.count as f64;
            let wd = nf / (opts.sigma_n * opts.sigma_n);
            let wp = nf / (opts.sigma_g * opts.sigma_g);
            a[s.i][s.i] += wd * mi * mi + wp;
            a[s.j][s.j] += wd * mj * mj + wp;
            a[s.i][s.j] -= wd * mi * mj;
            a[s.j][s.i] -= wd * mi * mj;
            b[s.i] += wp;
            b[s.j] += wp;
        }
        let x = solve_dense(a, b).unwrap_or_else(|| vec![1.0; n]);
        let positive_gains: Vec<f64> = x.iter().filter(|g| **g > 0.0).map(|g| g.ln()).collect();
        if !positive_gains.is_empty() {
            let log_mean = positive_gains.iter().sum::<f64>() / positive_gains.len() as f64;
            let norm = (-log_mean).exp();
            for (i, gi) in x.iter().enumerate() {
                for &c in *channels {
                    gains[i][c] = (*gi * norm) as f32;
                }
            }
        }
    }
    Ok(gains)
}
