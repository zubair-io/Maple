//! Gain compensation: per-frame scalar (optionally per-channel)
//! multipliers solved as least squares over mean intensities in
//! pairwise overlap regions — Brown & Lowe 2007 §6, in **linear**
//! scene light where exposure really is a single multiplier (M2-CPU,
//! #1155; stitching spec §5.5).
//!
//! ## Formulation
//!
//! For every overlapping pair `(i, j)` with `N_ij` corresponding sample
//! points and overlap means `m_ij` (frame `i`'s mean over the shared
//! region) and `m_ji` (frame `j`'s mean over the same region):
//!
//! ```text
//! e(g) = Σ_pairs N_ij [ (g_i·m_ij − g_j·m_ji)² / σ_N²
//!                        + ((1 − g_i)² + (1 − g_j)²) / σ_g² ]
//!        + Σ_i (1 − g_i)² / σ_g²
//! ```
//!
//! The trailing per-frame anchor (weight of a single sample) keeps
//! frames with no overlap solvable — they come out at exactly 1.0.
//! The quadratic is minimized by one dense symmetric solve (in-tree
//! Gaussian elimination — no external linear-algebra dependency).
//!
//! Defaults deviate from Brown & Lowe's `σ_N = 10/255, σ_g = 0.1`
//! deliberately: their strong gain prior guards against overlap means
//! measured over *different* pixel sets. Here the means come from
//! geometrically corresponding samples (frame `i`'s grid reprojected
//! into frame `j` and vice versa), so the measurement noise is far
//! smaller and a weak prior (`σ_g = 1.0`) with a tight data term
//! (`σ_N = 0.01`) recovers relative gains to well under 1% (the #1155
//! gate) while still anchoring the global scale.
//!
//! ## Where it runs
//!
//! Before warp: overlap means are gathered in **source space** by
//! reprojecting strided sample grids between frames (no canvas-sized
//! buffer needed). The solved gains are folded into the warp
//! ([`crate::warp::warp_to_canvas`]'s `gain` parameter).

use rayon::prelude::*;

use crate::camera::Camera;
use crate::error::PanoError;
use crate::ingest::PlanarImage;

/// Gain model (spec §5.5: "per-image scalar gain (optionally
/// per-channel)").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GainMode {
    /// One multiplier per frame, solved on mean linear intensity
    /// `(R + G + B) / 3`.
    #[default]
    Scalar,
    /// Independent multipliers per channel (three independent solves
    /// over the same overlap samples).
    PerChannel,
}

/// Options for [`solve_gains`].
#[derive(Debug, Clone)]
pub struct GainOptions {
    pub mode: GainMode,
    /// Data-term sigma (linear intensity units). Smaller = trust the
    /// overlap means harder.
    pub sigma_n: f64,
    /// Gain-prior sigma. Larger = weaker pull toward 1.0.
    pub sigma_g: f64,
    /// Sample-grid stride in source pixels (both axes). 4 → 1/16 of
    /// the overlap pixels are sampled.
    pub sample_stride: u32,
    /// Pairs with fewer corresponding samples than this are ignored.
    pub min_overlap_samples: usize,
}

impl Default for GainOptions {
    fn default() -> Self {
        Self {
            mode: GainMode::Scalar,
            sigma_n: 0.01,
            sigma_g: 1.0,
            sample_stride: 4,
            min_overlap_samples: 64,
        }
    }
}

/// Per-pair overlap statistics (per-channel sums over corresponding
/// sample points).
struct PairStats {
    i: usize,
    j: usize,
    count: usize,
    sum_i: [f64; 3],
    sum_j: [f64; 3],
}

/// Solve per-frame gains. Always returns per-channel triples
/// (`[g, g, g]` in scalar mode) so the warp's gain input is uniform.
///
/// Frames and cameras correspond by index; every frame's dimensions
/// must match its camera's.
pub fn solve_gains(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<Vec<[f32; 3]>, PanoError> {
    if frames.len() != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "solve_gains: {} frames vs {} cameras",
            frames.len(),
            cameras.len()
        )));
    }
    for (k, (f, c)) in frames.iter().zip(cameras).enumerate() {
        if (f.width(), f.height()) != (c.width, c.height) {
            return Err(PanoError::InvalidOptions(format!(
                "solve_gains: frame {k} is {}x{} but its camera is {}x{}",
                f.width(),
                f.height(),
                c.width,
                c.height
            )));
        }
    }
    if !(opts.sigma_n > 0.0 && opts.sigma_g > 0.0) || opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_gains: sigma_n, sigma_g and sample_stride must be positive".into(),
        ));
    }
    let n = frames.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![[1.0; 3]]);
    }

    // Candidate pairs: prune by optical-axis separation vs. summed
    // half-diagonal FOVs (with slack for distortion) before sampling.
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            if frames_may_overlap(&cameras[i], &cameras[j]) {
                candidates.push((i, j));
            }
        }
    }

    let stats: Vec<PairStats> = candidates
        .par_iter()
        .filter_map(|&(i, j)| {
            let s = pair_overlap_stats(
                &frames[i],
                &cameras[i],
                &frames[j],
                &cameras[j],
                opts.sample_stride,
            );
            (s.count >= opts.min_overlap_samples.max(1)).then_some(PairStats {
                i,
                j,
                count: s.count,
                sum_i: s.sum_i,
                sum_j: s.sum_j,
            })
        })
        .collect();

    // Channel index sets per mode: scalar solves once on the channel
    // mean; per-channel solves R, G, B independently.
    let solves: &[&[usize]] = match opts.mode {
        GainMode::Scalar => &[&[0, 1, 2]],
        GainMode::PerChannel => &[&[0], &[1], &[2]],
    };

    let mut gains = vec![[1.0_f32; 3]; n];
    for channels in solves {
        let mut a = vec![vec![0.0_f64; n]; n];
        let mut b = vec![0.0_f64; n];
        // Per-frame anchor (one sample's worth of prior): keeps
        // overlap-free frames at exactly 1.0 and the system SPD.
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
                continue; // black/degenerate overlap constrains nothing
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
        let x = solve_dense(a, b).ok_or_else(|| {
            PanoError::InvalidOptions("solve_gains: singular normal equations".into())
        })?;
        // Gauge normalization: the overlap data constrains only gain
        // *ratios*; the unity prior anchors the absolute level weakly and
        // drags it toward 1 whenever the planted exposures are one-sided
        // (a scene-referred composite must not pick up a global exposure
        // shift from the solver's prior). Fix the gauge to geometric
        // mean = 1: locked-AE sets stay at ~1.0, bracketed sets keep
        // exact relative scaling, and the set's mean scene level is
        // preserved.
        //
        // Divide only by the COUNT OF POSITIVE entries: dividing by
        // x.len() biases log_mean low whenever any solver output is ≤ 0
        // (which moves the log sum but not the count). When ALL outputs
        // are non-positive the log sum is 0 and no normalization is
        // meaningful — leave gains at the solver's output (already
        // ~1 from the prior) rather than forcing a misleading norm.
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
        // If all solver outputs are non-positive the gains array stays at
        // the default 1.0 initialised above — correct fallback (the prior
        // already pins degenerate frames near 1.0).
    }
    Ok(gains)
}

/// Cheap overlap pre-test: optical-axis separation must not exceed the
/// summed half-diagonal FOVs (with 10% slack for distortion).
fn frames_may_overlap(a: &Camera, b: &Camera) -> bool {
    let axis = |c: &Camera| c.rotation.mul_vec(crate::math::Vec3::new(0.0, 0.0, 1.0));
    let half_diag = |c: &Camera| {
        let rx = c.width as f64 * 0.5;
        let ry = c.height as f64 * 0.5;
        ((rx * rx + ry * ry).sqrt() / c.focal_px).atan() * 1.1
    };
    let ang = axis(a).dot(axis(b)).clamp(-1.0, 1.0).acos();
    ang <= half_diag(a) + half_diag(b)
}

struct OverlapSums {
    count: usize,
    sum_i: [f64; 3],
    sum_j: [f64; 3],
}

/// Gather per-channel sums over corresponding points of the (i, j)
/// overlap, sampling a strided grid of each frame and reprojecting into
/// the other (both directions, accumulated symmetrically).
fn pair_overlap_stats(
    fi: &PlanarImage,
    ci: &Camera,
    fj: &PlanarImage,
    cj: &Camera,
    stride: u32,
) -> OverlapSums {
    let mut out = OverlapSums {
        count: 0,
        sum_i: [0.0; 3],
        sum_j: [0.0; 3],
    };
    accumulate_direction(fi, ci, fj, cj, stride, false, &mut out);
    accumulate_direction(fj, cj, fi, ci, stride, true, &mut out);
    out
}

/// Walk `src`'s strided grid; for samples that land validly in `dst`,
/// accumulate `src`'s texel value and `dst`'s bilinear value. With
/// `swapped`, `src` plays the role of frame `j`.
fn accumulate_direction(
    src: &PlanarImage,
    c_src: &Camera,
    dst: &PlanarImage,
    c_dst: &Camera,
    stride: u32,
    swapped: bool,
    out: &mut OverlapSums,
) {
    let stride = stride.max(1);
    let w = src.width();
    let h = src.height();
    let mut y = stride / 2;
    while y < h {
        let mut x = stride / 2;
        while x < w {
            if src.validity.get(x, y) {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                if let Some(dir) = c_src.pixel_to_world_dir(px, py) {
                    if let Some((qx, qy)) = c_dst.world_dir_to_pixel(dir) {
                        if qx >= 0.0
                            && qx <= dst.width() as f64
                            && qy >= 0.0
                            && qy <= dst.height() as f64
                        {
                            if let Some(d) = bilinear_valid(dst, qx, qy) {
                                let i = (y * w + x) as usize;
                                let s = [src.r[i] as f64, src.g[i] as f64, src.b[i] as f64];
                                let (si, sj) = if swapped {
                                    (&mut out.sum_j, &mut out.sum_i)
                                } else {
                                    (&mut out.sum_i, &mut out.sum_j)
                                };
                                for c in 0..3 {
                                    si[c] += s[c];
                                    sj[c] += d[c] as f64;
                                }
                                out.count += 1;
                            }
                        }
                    }
                }
            }
            x += stride;
        }
        y += stride;
    }
}

/// Validity-weighted bilinear tap (texel centers at half-integers).
/// `None` when no valid in-bounds tap carries weight.
fn bilinear_valid(src: &PlanarImage, x_px: f64, y_px: f64) -> Option<[f32; 3]> {
    let w = src.width() as i64;
    let h = src.height() as i64;
    let x = x_px - 0.5;
    let y = y_px - 0.5;
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let (x0, y0) = (x0 as i64, y0 as i64);
    let taps = [
        (x0, y0, (1.0 - fx) * (1.0 - fy)),
        (x0 + 1, y0, fx * (1.0 - fy)),
        (x0, y0 + 1, (1.0 - fx) * fy),
        (x0 + 1, y0 + 1, fx * fy),
    ];
    let mut acc = [0.0_f64; 3];
    let mut wsum = 0.0_f64;
    for (tx, ty, wgt) in taps {
        if tx < 0 || tx >= w || ty < 0 || ty >= h || wgt == 0.0 {
            continue;
        }
        if !src.validity.get(tx as u32, ty as u32) {
            continue;
        }
        let i = (ty * w + tx) as usize;
        acc[0] += wgt * src.r[i] as f64;
        acc[1] += wgt * src.g[i] as f64;
        acc[2] += wgt * src.b[i] as f64;
        wsum += wgt;
    }
    if wsum < 1e-9 {
        return None;
    }
    let inv = 1.0 / wsum;
    Some([
        (acc[0] * inv) as f32,
        (acc[1] * inv) as f32,
        (acc[2] * inv) as f32,
    ])
}

/// Dense linear solve via Gaussian elimination with partial pivoting
/// (the gain systems are tiny — one row per frame). `None` when the
/// matrix is numerically singular.
fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        // Pivot.
        let mut piv = col;
        for row in (col + 1)..n {
            if a[row][col].abs() > a[piv][col].abs() {
                piv = row;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        // Eliminate below.
        let pivot = a[col][col];
        for row in (col + 1)..n {
            let factor = a[row][col] / pivot;
            if factor == 0.0 {
                continue;
            }
            for k in col..n {
                let v = a[col][k];
                a[row][k] -= factor * v;
            }
            b[row] -= factor * b[col];
        }
    }
    // Back substitution.
    let mut x = vec![0.0_f64; n];
    for col in (0..n).rev() {
        let mut s = b[col];
        for k in (col + 1)..n {
            s -= a[col][k] * x[k];
        }
        x[col] = s / a[col][col];
    }
    Some(x)
}

/// Solve per-frame gains from already-warped canvas-space layers.
///
/// For the tile strategy: frames are already on the canvas (warped),
/// so overlap means are measured directly by comparing corresponding
/// canvas pixels across frames. This avoids the camera → source
/// reprojection that [`solve_gains`] performs in source space.
///
/// Returns a `Vec<[f32; 3]>` of per-channel gains parallel to `layers`.
pub fn solve_gains_tile(
    layers: &[PlanarImage],
    opts: &GainOptions,
) -> Result<Vec<[f32; 3]>, PanoError> {
    let n = layers.len();
    if n == 0 {
        return Ok(vec![]);
    }
    if n == 1 {
        return Ok(vec![[1.0, 1.0, 1.0]]);
    }
    if !(opts.sigma_n > 0.0 && opts.sigma_g > 0.0) || opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_gains_tile: sigma_n, sigma_g and sample_stride must be positive".into(),
        ));
    }

    let cw = layers[0].width() as usize;
    let ch = layers[0].height() as usize;
    let stride = opts.sample_stride as usize;

    // Gather pairwise overlap stats in canvas space.
    let stats: Vec<PairStats> = {
        let mut v = Vec::new();
        for i in 0..n {
            for j in (i + 1)..n {
                let mut count = 0usize;
                let mut sum_i = [0.0_f64; 3];
                let mut sum_j = [0.0_f64; 3];
                for ry in (0..ch).step_by(stride) {
                    for rx in (0..cw).step_by(stride) {
                        let idx = ry * cw + rx;
                        if layers[i].validity.get(rx as u32, ry as u32)
                            && layers[j].validity.get(rx as u32, ry as u32)
                        {
                            sum_i[0] += layers[i].r[idx] as f64;
                            sum_i[1] += layers[i].g[idx] as f64;
                            sum_i[2] += layers[i].b[idx] as f64;
                            sum_j[0] += layers[j].r[idx] as f64;
                            sum_j[1] += layers[j].g[idx] as f64;
                            sum_j[2] += layers[j].b[idx] as f64;
                            count += 1;
                        }
                    }
                }
                if count >= opts.min_overlap_samples.max(1) {
                    v.push(PairStats {
                        i,
                        j,
                        count,
                        sum_i,
                        sum_j,
                    });
                }
            }
        }
        v
    };

    // Reuse the same linear-system build + solver as solve_gains.
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
        // Same divisor fix as solve_gains: divide by positive-count only.
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

#[cfg(test)]
mod tests;
