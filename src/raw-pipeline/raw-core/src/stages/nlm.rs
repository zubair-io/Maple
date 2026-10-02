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
//! Shifts run sequentially in the outer loop. Within a shift, the squared
//! differences, box-sum and accumulation are fused and parallelise across
//! horizontal STRIPS of output rows — each strip computes its own halo'd
//! horizontal sums into a thread-local buffer (recycled across strips, so no
//! full-frame box-sum plane round-trips through DRAM) and slides the vertical
//! window down out of it. The persistent acc/wsum/max_w buffers are
//! allocated once per `denoise_plane` call and reused across all shifts.
//! Squared differences use the existing thread-local row scratch (#1472).

use crate::cancel::CancelToken;
use rayon::prelude::*;

#[path = "nlm_radius.rs"]
mod radius;
#[path = "nlm_shift.rs"]
mod shift;
use radius::LocalRadiusPlane;
use shift::process_shift;

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

    let (local_s_plane, local_inv_norm_plane) = if use_dynamic {
        LocalRadiusPlane::variance_scaled(n, l_plane, params, s_coeff, o_coeff)
    } else {
        (LocalRadiusPlane::empty(), Vec::new())
    };

    // Persistent accumulators are allocated once and reused across shifts.
    // Squared differences use the existing thread-local row scratch (#1472),
    // so neither a difference plane nor a full-frame box-sum is allocated.
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
                &mut acc,
                &mut wsum,
                &mut max_w,
            );
        }
    }

    // Add central pixel with weight = running max weight (Buades'
    // self-similarity correction), then divide. No later shift needs acc,
    // so normalize it in place instead of allocating another full plane.
    acc.par_iter_mut().enumerate().for_each(|(i, dst)| {
        let mw_i = max_w[i].max(1e-12);
        let total_w = wsum[i] + mw_i;
        let total_acc = *dst + mw_i * plane[i];
        *dst = total_acc / total_w;
    });
    acc
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

// Tests live in the sibling `nlm_tests.rs` so this file stays under the
// 600-LOC budget (#951 — the in-kernel cancellation proof pushed the inline
// module over). Same `#[path]` split pattern the FFI + render modules use.
#[cfg(test)]
#[path = "nlm_tests.rs"]
mod tests;

// Box-sum kernel proofs split further into `nlm_tests_box.rs` (600-LOC budget).
#[cfg(test)]
#[path = "nlm_tests_box.rs"]
mod tests_box;
