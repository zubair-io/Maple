//! Separable blur utilities for clarity/texture stages.
//!
//! `gaussian_blur_rgb` approximates a 2D Gaussian by three successive 1D box
//! blurs per axis (Wells 1986, "Efficient synthesis of Gaussian filters"). At
//! the slice-3 radii (3 and 40), the approximation is visually indistinguishable
//! from a true Gaussian and runs in O(n) per pixel independent of radius.
//!
//! Also hosts `guided_filter` (He, Sun, Tang 2010) — the edge-preserving
//! base/detail decomposition primitive shared by clarity (#264) and texture
//! (#265). Self-guided (`guide == p`) gives a structure-aware local mean
//! that does not bleed across high-contrast edges, eliminating the
//! unsharp-mask halo around dark/bright transitions.

use crate::image::{ColorSpace, Image};
use rayon::prelude::*;

/// Separable box blur of a single channel plane.
/// `buf` is row-major w×h. Returns a new blurred buffer.
///
/// Both sweeps run in parallel via rayon:
/// * **Horizontal sweep** writes `tmp_row` row by row; each row's output is a
///   disjoint `w`-element slice, so `par_chunks_mut(w)` is safe and trivial.
/// * **Vertical sweep** reads `tmp_row` column-by-column (stride `w`) and
///   historically wrote back into a row-major `out` via the same stride.
///   That stride-`w` scatter prevents a clean parallel-mut over rows. The
///   fix: write the vertical pass into a column-major `tmp_col` buffer
///   (each column is a contiguous `h`-element slice, so `par_chunks_mut(h)`
///   is safe), then transpose column-major → row-major in a final parallel
///   pass. Memory cost: one extra w×h f32 buffer (same size as `tmp_row`).
///   CPU cost: one extra pass, amortized against doing the full sweep in
///   parallel on 8+ cores.
///
/// This owning entry point allocates the result plus the two scratch planes
/// and delegates to [`box_blur_into`]; stand-alone callers (`stages::guided`,
/// `scene_tone_controls`, `gaussian_blur_*`) keep the simple
/// `&[f32] -> Vec<f32>` form. Callers that run *many* blurs in one tick
/// (the `guided_filter` base/detail decomposition) call `box_blur_into`
/// directly with a reused scratch arena so they don't re-allocate per pass
/// — see #1089 item 7.
#[derive(Copy, Clone, Debug)]
pub(crate) struct GuidedOptions {
    pub r: usize,
    pub eps: f32,
}

pub(crate) fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 {
        return buf.to_vec();
    }
    let mut out = vec![0.0f32; buf.len()];
    let mut tmp_row = vec![0.0f32; buf.len()];
    let mut tmp_col = vec![0.0f32; buf.len()];
    box_blur_into(buf, &mut out, &mut tmp_row, &mut tmp_col, w, h, r);
    out
}

/// Box-blur `src` into `dst`, using two caller-provided scratch planes
/// (`tmp_row`, `tmp_col`) instead of allocating any buffers. All four
/// slices must be exactly `w*h` long; `src` may alias none of the others
/// (the caller guarantees distinct buffers). `r > 0` is required — the
/// `r == 0` identity is the owning wrapper's job.
///
/// Output is **bit-identical** to the previous `box_blur_channel` body:
/// the horizontal running-sum sweep, the column-major vertical sweep, and
/// the transpose are byte-for-byte the same operations in the same order;
/// only the buffer *ownership* changed (provided-and-reused vs freshly
/// `vec!`-allocated per call). This is the allocation cut in #1089 item 7.
fn box_blur_into(
    src: &[f32],
    dst: &mut [f32],
    tmp_row: &mut [f32],
    tmp_col: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
) {
    debug_assert_eq!(src.len(), w * h);
    debug_assert_eq!(dst.len(), w * h);
    debug_assert_eq!(tmp_row.len(), w * h);
    debug_assert_eq!(tmp_col.len(), w * h);
    debug_assert!(r > 0, "box_blur_into requires r > 0");

    // --- Horizontal sweep: row-parallel, row-major into `tmp_row` ---
    tmp_row
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, out_row)| {
            let row = &src[y * w..(y + 1) * w];
            let right0 = r.min(w - 1);
            let mut acc: f64 = row[0..=right0].iter().map(|&x| x as f64).sum();
            let mut count = right0 + 1;
            out_row[0] = (acc / count as f64) as f32;
            for x in 1..w {
                if x + r < w {
                    acc += row[x + r] as f64;
                    count += 1;
                }
                if x > r {
                    acc -= row[x - r - 1] as f64;
                    count -= 1;
                }

                // Periodic reset every 256 pixels to flush rounding errors
                if x % 256 == 0 {
                    let start = if x > r { x - r } else { 0 };
                    let end = (x + r).min(w - 1);
                    acc = row[start..=end].iter().map(|&v| v as f64).sum();
                    count = end - start + 1;
                }

                out_row[x] = (acc / count as f64) as f32;
            }
        });

    // --- Vertical sweep: column-parallel into a column-major scratch ---
    //
    // `tmp_col[x * h + y]` = `tmp_row[y * w + x]` after blur along y.
    // Each column is a contiguous `h`-element chunk of `tmp_col`, and
    // columns don't overlap, so par_chunks_mut(h) is safe.
    let tmp_row_ro: &[f32] = tmp_row;
    tmp_col
        .par_chunks_mut(h)
        .enumerate()
        .for_each(|(x, out_col)| {
            let bot0 = r.min(h - 1);
            let mut acc: f64 = (0..=bot0).map(|i| tmp_row_ro[i * w + x] as f64).sum();
            let mut count = bot0 + 1;
            out_col[0] = (acc / count as f64) as f32;
            for y in 1..h {
                if y + r < h {
                    acc += tmp_row_ro[(y + r) * w + x] as f64;
                    count += 1;
                }
                if y > r {
                    acc -= tmp_row_ro[(y - r - 1) * w + x] as f64;
                    count -= 1;
                }

                // Periodic reset every 256 pixels to flush rounding errors
                if y % 256 == 0 {
                    let start = if y > r { y - r } else { 0 };
                    let end = (y + r).min(h - 1);
                    acc = (start..=end).map(|i| tmp_row_ro[i * w + x] as f64).sum();
                    count = end - start + 1;
                }

                out_col[y] = (acc / count as f64) as f32;
            }
        });

    // --- Transpose column-major → row-major (parallel by output row) ---
    let tmp_col_ro: &[f32] = tmp_col;
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        for x in 0..w {
            out_row[x] = tmp_col_ro[x * h + y];
        }
    });
}

/// Gaussian-ish blur of an RGB image via 3 successive box-blur passes per axis
/// (approximation per Wells 1986). `radius` is the effective Gaussian radius;
/// internally uses 3 box passes of `radius / 3`.
///
/// A radius of 0 returns a clone of the input unchanged.
///
/// NOTE the integer math: `(radius / 3).max(1)` floors to a box radius of 1
/// for every `radius < 6`, so all small radii produce the SAME blur (an
/// effective Gaussian sigma of ~1.42 px). Fine for the fixed structure-scale
/// radii texture uses; useless for a sub-pixel-tunable PSF. Callers that need
/// a sigma-faithful blur (sharpen, capture sharpening) use
/// [`gaussian_blur_plane_sigma`] instead — see #1083.
pub fn gaussian_blur_plane(buf: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 {
        return buf.to_vec();
    }
    let r_box = (radius / 3).max(1);
    let mut plane = buf.to_vec();
    for _ in 0..3 {
        plane = box_blur_channel(&plane, w, h, r_box);
    }
    plane
}

/// Hard ceiling on the Gaussian sigma [`gaussian_kernel_1d`] will accept, in
/// pixels. Defense-in-depth against an unbounded `2 * ceil(3σ) + 1`-tap kernel
/// allocation (OOM/DoS) from a direct caller — the pipeline helpers clamp
/// XMP-sourced sigmas far lower (8 px for capture sharpening, 3 px for
/// sharpen). At `sigma = 50.0` the kernel is 301 taps: large but bounded.
///
/// Moved here from `capture_sharpening.rs` (#1083) so the sharpen stage can
/// share the exact same true-Gaussian primitive.
pub(crate) const MAX_GAUSSIAN_SIGMA_PX: f32 = 50.0;

/// Build a windowed, renormalized 1D Gaussian kernel of length `2*half+1`,
/// where `half = ceil(3 * sigma).max(1) as usize`. The kernel is symmetric
/// around index `half`; weights are `exp(-(k^2)/(2σ²))` and the whole array
/// is divided by its sum so the convolution preserves DC.
///
/// `sigma` is clamped to `(0, MAX_GAUSSIAN_SIGMA_PX]` and non-finite values
/// are rounded up to a tiny lower bound — the stage entry points reject bogus
/// sigma upfront, so the clamp here is the last-line safeguard against an
/// unbounded allocation if a future entry point forgets to validate.
///
/// Moved verbatim from `capture_sharpening.rs` (#1083); raw-gpu carries a
/// bit-for-bit port (`raw_gpu::capture_sharpening::gaussian_kernel_1d`) that
/// must stay in lockstep.
pub(crate) fn gaussian_kernel_1d(sigma: f32) -> Vec<f32> {
    let sigma = if sigma.is_finite() && sigma > 0.0 {
        sigma.min(MAX_GAUSSIAN_SIGMA_PX)
    } else {
        // Smallest sigma that still produces a kernel; only reachable via
        // kernel-only unit tests (stage entry points validate upfront).
        1e-3
    };
    let half = (3.0 * sigma).ceil().max(1.0) as usize;
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut k: Vec<f32> = (0..=2 * half)
        .map(|i| {
            let x = i as f32 - half as f32;
            (-(x * x) / two_sigma_sq).exp()
        })
        .collect();
    let sum: f32 = k.iter().sum();
    let inv = 1.0 / sum;
    for v in &mut k {
        *v *= inv;
    }
    k
}

/// Separable TRUE-Gaussian blur of a single-channel plane, parameterised by a
/// float `sigma` (the PSF sigma in pixels). Two 1D convolutions (horizontal
/// then vertical) against the windowed/renormalized kernel from
/// [`gaussian_kernel_1d`]; edge handling clamps the sample index to
/// `[0, w-1]` / `[0, h-1]`.
///
/// This is the sigma-faithful sibling of [`gaussian_blur_plane`]: distinct
/// sigmas produce distinct kernels even below 1 px, which the tripled-box
/// approximation cannot express (its integer box radius floors every small
/// radius to the same width — the #1083 sharpen-radius no-op). Used by the
/// sharpen stage (sigma 0.5..3.0) and capture sharpening (sigma 0.5..8.0).
///
/// Cost vs the box path: per pixel, `2 * (2*ceil(3σ)+1)` multiply-adds
/// (14 taps at the sharpen default σ=1.0, ≤ 38 at the σ=3.0 ceiling) against
/// the box cascade's 6 running-sum updates — a 2–6× wider blur inner loop,
/// O(n·σ) instead of O(n). It runs on ONE luma plane inside sharpen, where
/// the per-pixel USM + edge-mix sweeps dominate; capture sharpening already
/// pays exactly this cost for FOUR blurs per render at comparable sigma.
/// Both sweeps are rayon-parallel over rows (per-pixel tap order is
/// unchanged, so the result is bit-identical to the serial form this
/// replaces in `capture_sharpening.rs`).
pub(crate) fn gaussian_blur_plane_sigma(buf: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let kernel = gaussian_kernel_1d(sigma);
    let half = kernel.len() / 2;

    // Horizontal pass: tmp[y*w + x] = sum_k kernel[k] * buf[y*w + clamp(x + k - half)]
    let mut tmp = vec![0.0_f32; buf.len()];
    let w_i = w as isize;
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row_out)| {
        let row_in = &buf[y * w..(y + 1) * w];
        for (x, out) in row_out.iter_mut().enumerate() {
            let mut acc = 0.0_f32;
            for (k_idx, &k) in kernel.iter().enumerate() {
                let xi = (x as isize + k_idx as isize - half as isize).clamp(0, w_i - 1) as usize;
                acc += k * row_in[xi];
            }
            *out = acc;
        }
    });

    // Vertical pass: out[y*w + x] = sum_k kernel[k] * tmp[clamp(y + k - half)*w + x]
    let mut out = vec![0.0_f32; buf.len()];
    let h_i = h as isize;
    out.par_chunks_mut(w).enumerate().for_each(|(y, row_out)| {
        for (x, out_px) in row_out.iter_mut().enumerate() {
            let mut acc = 0.0_f32;
            for (k_idx, &k) in kernel.iter().enumerate() {
                let yi = (y as isize + k_idx as isize - half as isize).clamp(0, h_i - 1) as usize;
                acc += k * tmp[yi * w + x];
            }
            *out_px = acc;
        }
    });
    out
}

/// Edge-preserving local-mean filter (He, Sun, Tang 2010 — "Guided
/// Image Filtering"). Returns the filtered `p` plane in which each
/// pixel is a locally-linear regression of `p` against `guide` over a
/// `(2r+1)²` window. `eps` is the regularisation that controls how
/// strongly `guide` edges propagate into the output: small `eps`
/// (≪ var(guide)) means "follow the edges sharply", large `eps`
/// (≫ var(guide)) collapses the filter back toward a plain box blur.
///
/// Self-guided (`guide == p`) is the classic structure-preserving
/// smoother — gives the "base" layer for base/detail decomposition.
/// `detail = p - guided(p, p, r, eps)` is high-frequency without the
/// cross-edge bleed that an unsharp mask suffers.
///
/// Effective stencil reach is `2r` per side: the `mean_a` / `mean_b`
/// passes box-blur a buffer that was itself box-blurred at radius `r`.
/// Pin tile overlap accordingly when adding new callers — see
/// `pipeline::tile::TILE_OVERLAP_PX` and the const-assertion against
/// `CLARITY_GUIDED_RADIUS` in `pipeline::tile::mod`.
///
/// Used by `stages::clarity` (radius 20, structure-scale) and
/// `stages::texture` (radius 2, fine-detail-scale).
pub(crate) fn guided_filter(
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    opts: GuidedOptions,
) -> Vec<f32> {
    assert_eq!(guide.len(), p.len());
    let n = guide.len();
    if opts.r == 0 {
        return p.to_vec();
    }
    // Hard assert (not debug-only): `guided_filter` is a coarse-grained entry
    // point — called a handful of times per render, not per pixel — so the cost
    // of one integer compare is negligible, and failing fast here yields a clear
    // message in release builds instead of a downstream out-of-bounds panic when
    // a caller's `(w, h)` disagrees with the buffer length. The per-tile box-blur
    // hot loop keeps `debug_assert_eq!` for the same invariant (see `box_blur_into`).
    assert_eq!(
        n,
        w * h,
        "guided_filter: dims {w}×{h} disagree with buffer len {n}"
    );

    // --- Scratch arena (#1089 item 7) ---------------------------------
    //
    // The pre-arena code allocated ~24 image-sized `Vec`s per call: each
    // of the six box-blur calls minted three fresh buffers
    // (tmp_row + tmp_col + out), plus `ip`/`ii`, the `a`/`b` unzip, and
    // the final combine. At 2 MP that's ~192 MB of allocator traffic on a
    // per-tick slider (#1089 item 7).
    //
    // Here we allocate a *fixed* set of planes once and reuse them across
    // both blur phases. Beyond the four mean outputs and `ip`/`ii`, the
    // arena holds FOUR box-blur scratch pairs (`s0_row/s0_col` …
    // `s3_row/s3_col`) — one per blur that can run concurrently. The four
    // mean-blurs in phase A run under nested `rayon::join`, and concurrent
    // blurs CANNOT share a scratch pair, so each gets its own; phase B
    // (mean_a, mean_b) reuses pairs 0 and 1, and `mean_a`/`mean_b`
    // themselves reuse the now-dead `mean_ip`/`mean_ii`. `out` is folded
    // onto the dead `mean_i`. Net: 14 image-sized buffers, down from ~24
    // (−42 % allocator traffic, −80 MB/tick at 2 MP) — and box-blur no
    // longer allocates internally.
    //
    // Why keep the joins (rather than one shared scratch pair + sequential
    // blurs, which would cut to 8 buffers): at 2 MP a single box-blur does
    // NOT saturate all cores, so the inter-blur `rayon::join` overlap is a
    // real win on the tick. A measured sequential-blur variant hit 8
    // buffers but *regressed* the 2 MP tick — the macOS caching allocator
    // already recycles the freed buffers ~for free, so cutting allocations
    // buys little there while losing the join overlap costs wall-time. The
    // arena keeps every join and still removes ~40 % of the buffers.
    //
    // Bit-identity: the per-element math is untouched and each box-blur's
    // internal accumulation order is byte-for-byte the same as before
    // (same running-sum sweeps, same join structure); only buffer
    // *ownership* changed (pre-sized-and-reused vs freshly `vec!`-allocated
    // per pass). The covariance/variance/a/b derivation and the final
    // combine are per-element and unchanged. Pinned by the
    // `guided_filter_arena_matches_owning_box_blur_*` tests below.
    let mut s0_row = vec![0.0f32; n];
    let mut s0_col = vec![0.0f32; n];
    let mut s1_row = vec![0.0f32; n];
    let mut s1_col = vec![0.0f32; n];
    let mut s2_row = vec![0.0f32; n];
    let mut s2_col = vec![0.0f32; n];
    let mut s3_row = vec![0.0f32; n];
    let mut s3_col = vec![0.0f32; n];

    // ip = guide * p ; ii = guide * guide. (Later reused as a / b.)
    let mut ip: Vec<f32> = guide
        .par_iter()
        .zip(p.par_iter())
        .map(|(&a, &b)| a * b)
        .collect();
    let mut ii: Vec<f32> = guide.par_iter().map(|&a| a * a).collect();

    let mut mean_i = vec![0.0f32; n];
    let mut mean_p = vec![0.0f32; n];
    let mut mean_ip = vec![0.0f32; n];
    let mut mean_ii = vec![0.0f32; n];

    // --- Phase A: box-blur the four planes concurrently. Each call is
    // itself row/column-parallel (`par_chunks_mut`); nested rayon::join
    // overlaps the four so the cumulative wall-clock cost is dominated by
    // the slowest one, not the sum. Each concurrent blur writes a distinct
    // mean output through a DISJOINT scratch pair, so the parallelism is
    // sound. ---
    {
        let mi: &mut [f32] = &mut mean_i;
        let mp: &mut [f32] = &mut mean_p;
        let mip: &mut [f32] = &mut mean_ip;
        let mii: &mut [f32] = &mut mean_ii;
        let (s0r, s0c) = (&mut s0_row, &mut s0_col);
        let (s1r, s1c) = (&mut s1_row, &mut s1_col);
        let (s2r, s2c) = (&mut s2_row, &mut s2_col);
        let (s3r, s3c) = (&mut s3_row, &mut s3_col);
        rayon::join(
            || {
                rayon::join(
                    || box_blur_into(guide, mi, s0r, s0c, w, h, opts.r),
                    || box_blur_into(p, mp, s1r, s1c, w, h, opts.r),
                )
            },
            || {
                rayon::join(
                    || box_blur_into(&ip, mip, s2r, s2c, w, h, opts.r),
                    || box_blur_into(&ii, mii, s3r, s3c, w, h, opts.r),
                )
            },
        );
    }

    // Fuse the covariance / variance / a / b derivations into one
    // parallel pass, writing a→ip and b→ii in place (both are dead now).
    // The two writes target disjoint buffers, so a single zipped
    // par-iter over (ip, ii) is data-race-free.
    ip.par_iter_mut()
        .zip(ii.par_iter_mut())
        .enumerate()
        .for_each(|(i, (a_slot, b_slot))| {
            let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
            // Variance can never be physically negative — clamp the
            // box-mean roundoff at zero (#1088), mirroring the sibling
            // at `stages::guided`. Without the clamp, scene-linear luma
            // ≫ 1 makes the `mean_ii - mean_i²` cancellation error
            // comparable to `opts.eps`, which can flip the `var_i + opts.eps`
            // denominator sign and blow `a_i` up unboundedly in flat
            // bright regions.
            let var_i = (mean_ii[i] - mean_i[i] * mean_i[i]).max(0.0);
            let a_i = cov_ip / (var_i + opts.eps);
            let b_i = mean_p[i] - a_i * mean_i[i];
            *a_slot = a_i;
            *b_slot = b_i;
        });
    // `ip` now holds `a`; `ii` now holds `b`.
    let a = ip;
    let b = ii;

    // --- Phase B: box-blur a, b concurrently. mean_a / mean_b reuse the
    // now-dead mean_ip / mean_ii buffers; the two blurs reuse scratch
    // pairs 0 and 1. ---
    let mut mean_a = mean_ip;
    let mut mean_b = mean_ii;
    {
        let ma: &mut [f32] = &mut mean_a;
        let mb: &mut [f32] = &mut mean_b;
        let (s0r, s0c) = (&mut s0_row, &mut s0_col);
        let (s1r, s1c) = (&mut s1_row, &mut s1_col);
        rayon::join(
            || box_blur_into(&a, ma, s0r, s0c, w, h, opts.r),
            || box_blur_into(&b, mb, s1r, s1c, w, h, opts.r),
        );
    }

    // out = mean_a * guide + mean_b. Reuse `mean_i` (dead) as the output
    // buffer rather than minting a fresh Vec for the return value.
    let mut out = mean_i;
    out.par_iter_mut().enumerate().for_each(|(i, o)| {
        *o = mean_a[i] * guide[i] + mean_b[i];
    });
    out
}

pub fn gaussian_blur_rgb(img: &Image, radius: usize) -> Image {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if radius == 0 {
        return img.clone();
    }
    let w = img.width as usize;
    let h = img.height as usize;
    let r_box = (radius / 3).max(1);

    // Split into three channel planes.
    let mut r_plane: Vec<f32> = img.pixels.iter().map(|p| p[0]).collect();
    let mut g_plane: Vec<f32> = img.pixels.iter().map(|p| p[1]).collect();
    let mut b_plane: Vec<f32> = img.pixels.iter().map(|p| p[2]).collect();

    for _ in 0..3 {
        r_plane = box_blur_channel(&r_plane, w, h, r_box);
        g_plane = box_blur_channel(&g_plane, w, h, r_box);
        b_plane = box_blur_channel(&b_plane, w, h, r_box);
    }

    let mut out = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for i in 0..img.pixels.len() {
        out.pixels[i] = [r_plane[i], g_plane[i], b_plane[i]];
    }
    out
}

// Tests live in the sibling `blur_tests.rs` so this file stays under the
// 600-LOC file-size budget (#1089 — the scratch-arena byte-identity proofs
// pushed the inline module over). Same `#[path]` split the `nlm` and
// `sharpen` stages use.
#[cfg(test)]
#[path = "blur_tests.rs"]
mod tests;
