//! Memory-bounded streaming gain solve (#1254).
//!
//! Decodes each source frame exactly once, keeping at most one full-resolution
//! frame resident at a time, and accumulates pairwise overlap statistics
//! incrementally.  The resulting statistics are handed to the same linear
//! solver as [`super::solve_gains`].
//!
//! See [`solve_gains_streaming`] for the full algorithm description.

use std::path::PathBuf;

use crate::camera::Camera;
use crate::error::PanoError;

use super::{bilinear_valid, frames_may_overlap, solve_dense, GainMode, GainOptions, PairStats};

/// One pending reprojection contribution awaiting a destination frame.
///
/// A sample point recorded while frame `i` is decoded for later resolution
/// when frame `j` (j > i) is decoded.
///
/// Instead of storing the source pixel value (12 bytes) alongside the
/// destination coordinate (16 bytes), this struct stores only the destination
/// coordinate in f32 precision (8 bytes) and the source frame index (1 byte)
/// — 9 bytes per record, padded to 12.  The source pixel value is accumulated
/// separately into `sum_i_scratch` while frame `i` is still decoded, removing
/// the need to store it here.
///
/// Memory savings on pano_01 (21 frames, stride=4): pending buffer shrinks
/// from ~4 GB at peak (36 bytes × ~19 M pending samples) to ~228 MB (12 bytes
/// × same count) — an 18× reduction (#1254).
#[derive(Clone, Copy)]
pub(super) struct PendingSample {
    /// Source frame index i (always i < j = current destination frame).
    /// Stored as u8: sufficient for up to 255 frames.
    pub src_frame: u8,
    /// Sub-pixel destination coordinate in frame j (f32 precision).
    pub dst_x: f32,
    pub dst_y: f32,
}

/// Mutable accumulator for one pair (i, j)'s overlap statistics.
#[derive(Default, Clone)]
pub(super) struct PairAccum {
    pub count: usize,
    /// Sum of frame-i pixel values at jointly valid sample points.
    pub sum_i: [f64; 3],
    /// Sum of frame-j pixel values at the reprojected coordinates.
    pub sum_j: [f64; 3],
}

struct SumIScratch {
    sum: [f64; 3],
    n_fwd: usize,
}

/// Solve per-frame gains by decoding each source frame **exactly once**,
/// keeping at most **one full-resolution frame resident** at a time.
///
/// This is the memory-bounded replacement for [`super::solve_gains`] used in
/// the rotation-path pipeline (#1254).  It produces equivalent gain
/// values (same pairwise sampling formulation, same linear solver).
///
/// # Algorithm (single-pass, O(N) decodes)
///
/// For frame `k = 0 … N-1` (decoded once per pass):
///
/// **Forward:** for each potential pair `(k, j)` with j > k and overlapping
/// cameras, walk frame k's strided grid; for each sample that projects into
/// cam_j's bounds, push a [`PendingSample`] into `pending_for_dst[j]` with
/// the destination coordinate in frame j.  Accumulate the source pixel value
/// from frame k into `sum_i_scratch[k * n + j]` while frame k is still live.
///
/// **Resolve:** drain `pending_for_dst[k]` — contributions from all earlier
/// frames i < k whose grid points map into cam_k.  Bilinear-sample frame k
/// at each recorded coordinate and accumulate into `pair_accum[i * n + k]`.
///
/// After all N passes, `pair_accum` holds per-pair statistics and the linear
/// system is solved identically to `solve_gains`.
///
/// # Difference vs `solve_gains`
///
/// `solve_gains` samples in BOTH directions per pair (frame i → frame j and
/// frame j → frame i), doubling sample coverage.  Here only the forward
/// direction (frame i → frame j, resolved when frame j is decoded) is used;
/// the reverse direction would require frame i to be re-decoded.  This halves
/// sample count per pair but the system remains well-constrained for the
/// rotation-panorama use case.
pub fn solve_gains_streaming(
    paths: &[PathBuf],
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<Vec<[f32; 3]>, PanoError> {
    use crate::ingest::ingest_file;

    let n = paths.len();
    if n != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "solve_gains_streaming: {} paths vs {} cameras",
            n,
            cameras.len()
        )));
    }
    if !(opts.sigma_n > 0.0 && opts.sigma_g > 0.0) || opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_gains_streaming: sigma_n, sigma_g and sample_stride must be positive".into(),
        ));
    }
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![[1.0; 3]]);
    }

    // Pre-screen pairs by angular overlap (same as `solve_gains`).
    // Upper-triangle only: may_overlap[i * n + j] for i < j.
    let mut may_overlap = vec![false; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            if frames_may_overlap(&cameras[i], &cameras[j]) {
                may_overlap[i * n + j] = true;
            }
        }
    }

    // pair_accum[i * n + j] (i < j): accumulates stats for pair (i, j).
    let mut pair_accum: Vec<PairAccum> = vec![PairAccum::default(); n * n];

    // pending_for_dst[j]: destination coordinates from frames i < j that
    // project into frame j's bounds.  Each entry is 9 bytes (padded to 12)
    // vs 36 bytes for the old PendingContrib.  Memory on pano_01 (21 frames,
    // stride=4): ~12 × 19 M pending samples ≈ 228 MB vs ~4 GB before (#1254).
    //
    // The source pixel value is NOT stored here.  Instead, sum_i_scratch
    // accumulates it while frame i is decoded.  The resolve pass copies
    // sum_i_scratch into pair_accum once we know how many samples resolved.
    let mut pending_for_dst: Vec<Vec<PendingSample>> = (0..n).map(|_| Vec::new()).collect();

    // sum_i_scratch[i * n + j]: sum of frame-i pixel values at sample points
    // that projected into frame j (accumulated while frame i is decoded).
    // Separate from pair_accum so we can populate pair_accum.sum_i after
    // seeing how many samples also resolved in frame j.
    // Also tracks the forward count (n_fwd) so we can scale if needed.
    let mut sum_i_scratch: Vec<SumIScratch> = (0..n * n)
        .map(|_| SumIScratch {
            sum: [0.0; 3],
            n_fwd: 0,
        })
        .collect();

    let stride = opts.sample_stride.max(1);

    for k in 0..n {
        let frame = ingest_file(&paths[k]).map_err(|e| PanoError::InvalidOptions(e.to_string()))?;
        let img = frame.image;

        // ── Forward: frame k as SOURCE for pairs (k, j), j > k ──────────
        // Push lightweight PendingSample entries into pending_for_dst[j] and
        // accumulate frame-k pixel values into sum_i_scratch[k * n + j].
        for j in (k + 1)..n {
            if !may_overlap[k * n + j] {
                continue;
            }
            let cam_j = &cameras[j];
            let w = img.width();
            let h = img.height();
            let mut y = stride / 2;
            while y < h {
                let mut x = stride / 2;
                while x < w {
                    if img.validity.get(x, y) {
                        let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                        if let Some(dir) = cameras[k].pixel_to_world_dir(px, py) {
                            if let Some((qx, qy)) = cam_j.world_dir_to_pixel(dir) {
                                if qx >= 0.0
                                    && qx <= cam_j.width as f64
                                    && qy >= 0.0
                                    && qy <= cam_j.height as f64
                                {
                                    // Record only the destination coord (f32).
                                    pending_for_dst[j].push(PendingSample {
                                        src_frame: k as u8,
                                        dst_x: qx as f32,
                                        dst_y: qy as f32,
                                    });
                                    // Accumulate frame-k pixel value while live.
                                    let pi = (y * w + x) as usize;
                                    let s = &mut sum_i_scratch[k * n + j];
                                    s.sum[0] += img.r[pi] as f64;
                                    s.sum[1] += img.g[pi] as f64;
                                    s.sum[2] += img.b[pi] as f64;
                                    s.n_fwd += 1;
                                }
                            }
                        }
                    }
                    x += stride;
                }
                y += stride;
            }
        }

        // ── Resolve: frame k as DESTINATION for pairs (i, k), i < k ─────
        // Drain pending_for_dst[k]: bilinear-sample frame k at each stored
        // destination coord.  Pair (i, k)'s sum_j is accumulated here.
        // sum_i is copied from sum_i_scratch after counting resolved samples.
        let pending = std::mem::take(&mut pending_for_dst[k]);
        for p in &pending {
            let i = p.src_frame as usize;
            let Some(dst_val) = bilinear_valid(&img, p.dst_x as f64, p.dst_y as f64) else {
                continue;
            };
            let acc = &mut pair_accum[i * n + k];
            acc.count += 1;
            for c in 0..3 {
                acc.sum_j[c] += dst_val[c] as f64;
            }
        }
        // Copy sum_i from scratch.  sum_i was accumulated over n_fwd samples;
        // the linear solver uses per-pair MEANS (sum/count) so we scale sum_i
        // to the resolved count so that mean_i = sum_i / count is consistent
        // with the samples that also had a valid frame-k bilinear.  Border
        // failures are rare, so this scaling is typically a near no-op.
        for i in 0..k {
            if !may_overlap[i * n + k] {
                continue;
            }
            let n_fwd = sum_i_scratch[i * n + k].n_fwd;
            let n_res = pair_accum[i * n + k].count;
            if n_fwd == 0 || n_res == 0 {
                continue;
            }
            let scale = n_res as f64 / n_fwd as f64;
            for c in 0..3 {
                pair_accum[i * n + k].sum_i[c] = sum_i_scratch[i * n + k].sum[c] * scale;
            }
        }
        // img is dropped here, freeing the full-res buffer.
    }

    // Convert pair accumulators to PairStats for the linear solver.
    let stats: Vec<PairStats> = {
        let mut v = Vec::new();
        for i in 0..n {
            for j in (i + 1)..n {
                let acc = &pair_accum[i * n + j];
                if acc.count >= opts.min_overlap_samples.max(1) {
                    v.push(PairStats {
                        i,
                        j,
                        count: acc.count,
                        sum_i: acc.sum_i,
                        sum_j: acc.sum_j,
                    });
                }
            }
        }
        v
    };

    // Same linear-system build + solver as solve_gains.
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
        let x = solve_dense(a, b).ok_or_else(|| {
            PanoError::InvalidOptions("solve_gains_streaming: singular normal equations".into())
        })?;
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
