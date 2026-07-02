//! BM3D two-pass driver (#1105): collaborative filtering + deterministic
//! aggregation over the three opponent planes.
//!
//! ## Determinism contract (the #1105 gate)
//!
//! Output must be byte-identical across platforms AND thread counts, so
//! there is **no atomic float scatter-add anywhere**. The driver walks
//! reference-patch rows sequentially; within a row the per-reference work
//! (matching + transforms + shrinkage — all the expensive parts) runs in
//! parallel into an **indexed** result vector (each task writes only its
//! own slot), and the aggregation scatter then replays that vector
//! **serially in scan order**. Summation order is therefore a pure
//! function of the reference grid — independent of the rayon thread
//! count and schedule.
//!
//! ## Exact-identity construction
//!
//! Every quantity is processed **relative to the reference**: patches are
//! mean-subtracted before the 2-D DCT, the per-patch means are filtered
//! as deltas against the reference patch's mean, and aggregation
//! accumulates `weight · (estimate − noisy)` against the noisy plane. On
//! a uniform plane every one of those deltas is exactly `0.0`, every
//! transform of an all-zero vector is exactly zero, and the final
//! `plane + Σ0/Σw` is bit-identical to the input — the synthetic-grey
//! gate holds at any strength with no tolerance.

use rayon::prelude::*;

use super::matching::{extract_patch, find_group, patch_mean, ref_coords};
use super::transforms::{dct2d_forward, dct2d_inverse, wht_in_place, PATCH};
use super::{Progress, GROUP_MAX, LAMBDA_HT};

/// Which shrinkage the pass applies.
pub enum PassKind<'a> {
    /// Pass 1: hard-threshold the 3-D spectrum at `λ·σ`.
    Hard,
    /// Pass 2: empirical Wiener shrinkage guided by the basic estimate.
    Wiener { basic: &'a [Vec<f32>; 3] },
}

/// Per-reference filtering result, queued for the serial aggregation
/// scatter. `filtered[ch]` holds `positions.len()` consecutive 64-px
/// patch estimates (absolute values, means restored).
struct RefOut {
    positions: Vec<(usize, usize)>,
    filtered: [Vec<f32>; 3],
    weights: [f32; 3],
}

/// Shrink one channel's group. `patches` are the noisy mean-relative DCT
/// spectra (one `[f32; PATCH]` per group member); `means_delta` the
/// per-patch means relative to the reference's. For the Wiener pass,
/// `guide` carries the SAME quantities computed from the basic estimate.
/// Returns the channel weight. Spectra/means are filtered in place.
fn shrink_group(
    patches: &mut [[f32; PATCH]],
    means_delta: &mut [f32],
    guide: Option<(&[[f32; PATCH]], &[f32])>,
    sigma: f32,
    sigma_mean: f32,
) -> f32 {
    let n = patches.len();
    debug_assert!(n.is_power_of_two() && n <= GROUP_MAX);
    let mut scratch = [0f32; GROUP_MAX];
    let mut g_scratch = [0f32; GROUP_MAX];

    match guide {
        None => {
            // Hard threshold over the full 3-D spectrum (group-axis WHT of
            // every 2-D coefficient), plus the means-delta vector at the
            // tighter mean-noise sigma. Weight = 1/(1 + retained).
            let thr = LAMBDA_HT * sigma;
            let mut retained = 0usize;
            for j in 0..PATCH {
                for k in 0..n {
                    scratch[k] = patches[k][j];
                }
                wht_in_place(&mut scratch[..n]);
                for v in scratch[..n].iter_mut() {
                    if v.abs() < thr {
                        *v = 0.0;
                    } else {
                        retained += 1;
                    }
                }
                wht_in_place(&mut scratch[..n]);
                for k in 0..n {
                    patches[k][j] = scratch[k];
                }
            }
            let thr_m = LAMBDA_HT * sigma_mean;
            wht_in_place(&mut means_delta[..n]);
            for v in means_delta[..n].iter_mut() {
                if v.abs() < thr_m {
                    *v = 0.0;
                } else {
                    retained += 1;
                }
            }
            wht_in_place(&mut means_delta[..n]);
            1.0 / (1.0 + retained as f32)
        }
        Some((g_patches, g_means)) => {
            // Empirical Wiener: W = B²/(B² + σ²) from the basic-estimate
            // spectrum B, applied to the noisy spectrum. Weight =
            // 1/(ε + Σ W²) — on a uniform field every W is 0, the weight
            // is large but multiplies an exactly-zero delta.
            let s2 = sigma * sigma;
            let mut sum_w2 = 0f32;
            for j in 0..PATCH {
                for k in 0..n {
                    scratch[k] = patches[k][j];
                    g_scratch[k] = g_patches[k][j];
                }
                wht_in_place(&mut scratch[..n]);
                wht_in_place(&mut g_scratch[..n]);
                for k in 0..n {
                    let b2 = g_scratch[k] * g_scratch[k];
                    let wgt = b2 / (b2 + s2);
                    scratch[k] *= wgt;
                    sum_w2 += wgt * wgt;
                }
                wht_in_place(&mut scratch[..n]);
                for k in 0..n {
                    patches[k][j] = scratch[k];
                }
            }
            let s2m = sigma_mean * sigma_mean;
            g_scratch[..n].copy_from_slice(&g_means[..n]);
            wht_in_place(&mut means_delta[..n]);
            wht_in_place(&mut g_scratch[..n]);
            for k in 0..n {
                let b2 = g_scratch[k] * g_scratch[k];
                let wgt = b2 / (b2 + s2m);
                means_delta[k] *= wgt;
                sum_w2 += wgt * wgt;
            }
            wht_in_place(&mut means_delta[..n]);
            1.0 / (1e-8 + sum_w2)
        }
    }
}

/// Build the mean-relative DCT spectra + means-deltas for `positions` on
/// one plane. Returns `(spectra, means_delta, ref_mean)`.
fn group_spectra(
    plane: &[f32],
    w: usize,
    positions: &[(usize, usize)],
) -> (Vec<[f32; PATCH]>, Vec<f32>, f32) {
    let n = positions.len();
    let mut spectra = Vec::with_capacity(n);
    let mut means = Vec::with_capacity(n);
    for &(x, y) in positions {
        let mut p = extract_patch(plane, w, x, y);
        let m = patch_mean(&p);
        for v in p.iter_mut() {
            *v -= m;
        }
        dct2d_forward(&mut p);
        spectra.push(p);
        means.push(m);
    }
    let ref_mean = means[0];
    let means_delta: Vec<f32> = means.iter().map(|&m| m - ref_mean).collect();
    (spectra, means_delta, ref_mean)
}

/// Run one BM3D pass over the three opponent planes. `sigmas` are the
/// per-channel noise sigmas (`[σ_Y, σ_C, σ_C]`), `tau_sq` the match
/// ceiling. Returns the pass output planes. `cancelled` is polled per
/// reference row; when it returns true the pass aborts and returns
/// `None` (no partial buffer escapes).
#[allow(clippy::too_many_arguments)]
pub fn run_pass(
    noisy: &[Vec<f32>; 3],
    w: usize,
    h: usize,
    sigmas: [f32; 3],
    tau_sq: f32,
    pass: PassKind<'_>,
    pass_name: &'static str,
    progress: Progress<'_>,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<[Vec<f32>; 3]> {
    let xs = ref_coords(w);
    let ys = ref_coords(h);

    // Match guide: the luma plane — noisy for pass 1, basic for pass 2
    // (one joint match list reused by all three channels).
    let guide_y: &[f32] = match &pass {
        PassKind::Hard => &noisy[0],
        PassKind::Wiener { basic } => &basic[0],
    };

    // Delta aggregation accumulators (see module docs).
    let mut num: [Vec<f32>; 3] = [vec![0f32; w * h], vec![0f32; w * h], vec![0f32; w * h]];
    let mut den: [Vec<f32>; 3] = [vec![0f32; w * h], vec![0f32; w * h], vec![0f32; w * h]];

    for (row_i, &ry) in ys.iter().enumerate() {
        if cancelled() {
            return None;
        }
        // Phase A (parallel, indexed — no shared mutation): filter every
        // reference group on this row.
        let row_out: Vec<RefOut> = xs
            .par_iter()
            .map(|&rx| {
                let positions = find_group(guide_y, w, h, rx, ry, tau_sq);
                let n = positions.len();
                let mut filtered: [Vec<f32>; 3] = [
                    Vec::with_capacity(n * PATCH),
                    Vec::with_capacity(n * PATCH),
                    Vec::with_capacity(n * PATCH),
                ];
                let mut weights = [0f32; 3];
                for ch in 0..3 {
                    let (mut spectra, mut means_delta, ref_mean) =
                        group_spectra(&noisy[ch], w, &positions);
                    let g;
                    let guide = match &pass {
                        PassKind::Hard => None,
                        PassKind::Wiener { basic } => {
                            g = group_spectra(&basic[ch], w, &positions);
                            Some((g.0.as_slice(), g.1.as_slice()))
                        }
                    };
                    let sigma = sigmas[ch];
                    weights[ch] = shrink_group(
                        &mut spectra,
                        &mut means_delta,
                        guide,
                        sigma,
                        sigma / (PATCH as f32).sqrt(),
                    );
                    for (k, spec) in spectra.iter_mut().enumerate() {
                        dct2d_inverse(spec);
                        let m = ref_mean + means_delta[k];
                        for &v in spec.iter() {
                            filtered[ch].push(v + m);
                        }
                    }
                }
                RefOut {
                    positions,
                    filtered,
                    weights,
                }
            })
            .collect();

        // Phase B (serial, scan order): aggregation scatter in delta form.
        for r in &row_out {
            for ch in 0..3 {
                let wgt = r.weights[ch];
                let plane = &noisy[ch];
                let numc = &mut num[ch];
                let denc = &mut den[ch];
                for (k, &(px, py)) in r.positions.iter().enumerate() {
                    let patch = &r.filtered[ch][k * PATCH..(k + 1) * PATCH];
                    for row in 0..super::BLOCK {
                        let base = (py + row) * w + px;
                        let prow = &patch[row * super::BLOCK..(row + 1) * super::BLOCK];
                        for col in 0..super::BLOCK {
                            let i = base + col;
                            numc[i] += wgt * (prow[col] - plane[i]);
                            denc[i] += wgt;
                        }
                    }
                }
            }
        }
        if let Some(p) = progress {
            p(pass_name, (row_i + 1) as f32 / ys.len() as f32);
        }
    }

    let mut out: [Vec<f32>; 3] = [
        Vec::with_capacity(w * h),
        Vec::with_capacity(w * h),
        Vec::with_capacity(w * h),
    ];
    for ch in 0..3 {
        out[ch] = noisy[ch]
            .par_iter()
            .enumerate()
            .map(|(i, &v)| {
                let d = den[ch][i];
                if d > 0.0 {
                    v + num[ch][i] / d
                } else {
                    v // unreachable: ref_coords covers every pixel
                }
            })
            .collect();
    }
    Some(out)
}
