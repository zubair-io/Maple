//! Luminance-only unsharp-mask sharpening on scene-linear Rec.2020.
//!
//! Mirrors the Metal stitchable kernel `SharpenLumaUSM.metal` byte-for-byte
//! (BT.2020 luma weights, smoothstep shadow guard, scale clamp). Produces
//! a "full-strength sharpened" (amount=100, masking=0) buffer that the
//! edge-mix step at the bottom of this stage scales with the amount /
//! detail / masking sliders.
//!
//! The unsharp blur is a TRUE separable Gaussian parameterised by the float
//! `radius` (PSF sigma, 0.5..3.0) via `blur::gaussian_blur_plane_sigma`.
//! #1083: the previous `radius.round() as usize` → `(radius_px / 3).max(1)`
//! box-cascade truncated to the SAME 1-px box for every legal radius, so the
//! Radius slider was a no-op. Box cascades fundamentally can't express
//! sub-pixel sigmas (the smallest non-identity 3-pass cascade is already
//! σ≈1.42), which is most of this slider's range — hence the true Gaussian,
//! the same approach capture sharpening adopted in #452 for the same bug.
//! Platform copies that must stay in lockstep: raw-gpu's `SharpenPass`
//! (gaussian sub-passes over the shared `gaussian_blur` WGSL kernel) and the
//! Apple Metal fallback (`MetalKernels.applySceneSharpen` →
//! `applySeparableTrueGaussianBlur`).
//!
//! Replaces the per-channel Richardson-Lucy iteration + overdrive that
//! lived in this file previously. The 3-iteration RL implementation
//! produced saturated chroma artefacts in shadow regions where one
//! channel (typically blue, after Bayer + WB gain) had a noise spike
//! that ratio'd to many-fold larger than the other channels — the
//! "blue specks / magenta cast in shadows" pattern observed on
//! test_0002 etc. Luma-only USM scales every RGB channel at a pixel by
//! the SAME factor, so chroma ratios are preserved by construction.
//!
//! Constants must stay in lockstep with `SharpenLumaUSM.metal`:
//!   * `LUMA_R/G/B`     — BT.2020 luma weights.
//!   * `SHADOW_EPSILON` — 1e-4 (~13 EV below mid-gray; below this the
//!                       scale is held at 1.0 so shadow noise can't
//!                       amplify).
//!   * `SHADOW_BAND`    — 4.0 (smoothstep transition width above the
//!                       epsilon).
//!   * `MAX_SCALE`      — 4.0 (per-pixel amplification cap).
//!   * `MIN_SCALE`      — 0.0 (floor; prevents channel inversion at
//!                       extreme edges into deep shadow).
//!
//! The amount/detail/masking sliders run on top exactly as the Metal
//! `sharpenEdgeMix` kernel does (mix = amount * edge_factor).

use crate::{
    cancel::CancelToken,
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_plane_sigma,
};
use rayon::prelude::*;

const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;
const SHADOW_EPSILON: f32 = 1e-4;
const SHADOW_BAND: f32 = 4.0;
const MAX_SCALE: f32 = 4.0;
const MIN_SCALE: f32 = 0.0;

/// Apply luminance-only USM sharpening on a scene-linear Rec.2020 image.
///
/// * `amount`  — 0..150 slider (>100 boosts the mix beyond unity).
/// * `radius`  — Gaussian PSF sigma in pixels (clamped 0.5..3.0). The unsharp
///               blur is a true separable Gaussian at exactly this sigma
///               (`gaussian_blur_plane_sigma`), so sub-pixel steps move the
///               kernel — see #1083 for the integer-box-radius round-off that
///               previously collapsed every radius to one kernel.
/// * `detail`  — 0..100 slider; controls how much sharpening leaks into
///               flat regions when masking is non-zero.
/// * `masking` — 0..100 slider; gradient threshold for edge-only mix.
///
/// `amount == 0` short-circuits the entire stage.
///
/// Non-cancellable wrapper — forwards to [`apply_cancellable`] with a
/// never-cancel token, so its output is bit-identical to the pre-#951 stage.
#[inline]
pub fn apply(img: &mut Image, amount: f32, radius: f32, detail: f32, masking: f32) {
    apply_cancellable(img, amount, radius, detail, masking, CancelToken::never());
}

/// Cancellable variant of [`apply`]. Identical math; additionally observes
/// `cancel` once per output row in the fused per-pixel sweep. Rows that have
/// not yet started skip their work when the token is set; rows already running
/// complete normally (rayon's `for_each` cannot short-circuit mid-dispatch).
/// A row-granular relaxed load is free and does not perturb the result; with a
/// never-cancel token this is bit-identical to [`apply`].
///
/// The USM-scale build and the edge-aware mix were two serial full-image sweeps
/// (#1089): the first wrote a full `sharpened_pixels` buffer that the second
/// immediately consumed, and both read a full-image `observed_pixels` clone.
/// They are fused here into ONE `par_chunks_mut(w)` pass over `img.pixels`. The
/// edge gradient reads only the immutable `luma` plane (never the sharpened
/// pixels), and every output pixel reads its own input at the same index before
/// overwriting it — so each row's sharpened value is computed inline and the
/// mix written in place. That drops the two avoidable image-sized allocations
/// (`observed_pixels`, `sharpened_pixels`) and one full sweep over memory
/// (~2.4 GB of avoidable traffic per 100MP refine) while leaving the result
/// bit-identical: the per-pixel arithmetic is unchanged and order-independent,
/// so serial-fused, parallel-fused and the old two-sweep form all agree to the
/// last bit.
///
/// On early return `img.pixels` is left partially written — that's fine: the
/// develop chain checks the same token immediately after this stage and
/// returns `Err(Cancelled)`, so the half-written buffer is discarded and
/// never packed into a result.
pub fn apply_cancellable(
    img: &mut Image,
    amount: f32,
    radius: f32,
    detail: f32,
    masking: f32,
    cancel: CancelToken<'_>,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 {
        return;
    }

    // `radius` IS the Gaussian PSF sigma — keep it float all the way down.
    // (Pre-#1083 this was rounded to an integer box radius whose `/ 3`
    // truncated to the same 1-px box cascade for EVERY legal radius, making
    // the Radius slider a complete no-op.)
    let sigma = radius.clamp(0.5, 3.0);

    let w_usize = img.width as usize;
    let h_usize = img.height as usize;

    // --- Luma plane and its blur (single Gaussian pass) ---
    // Gaussian blur is linear, so blur(luma) == LUMA · blur(rgb).
    // Computing luma first and blurring one plane is 3× cheaper than
    // blurring RGB and dot-producting at every output pixel.
    let luma: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2])
        .collect();
    let luma_blur = gaussian_blur_plane_sigma(&luma, w_usize, h_usize, sigma);

    // --- Edge-aware amount + masking blend params ---
    // amount=100 + masking=0 → full sharpened buffer (mix=1).
    // amount<100 → linear interpolation toward observed.
    // masking>0 → flat regions mix at `detail_atten`, edges at 1.0.
    let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
    let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
    let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);

    let w = img.width as i32;
    let h = img.height as i32;

    // Central-difference luma gradient — fast Sobel approximation. Reads ONLY
    // the immutable `luma` plane (never the in-place sharpened pixels), so it
    // is unaffected by writing `img.pixels` underneath it.
    let gradient = |x: i32, y: i32| -> f32 {
        let idx = |xi: i32, yi: i32| -> usize {
            let xc = xi.clamp(0, w - 1) as usize;
            let yc = yi.clamp(0, h - 1) as usize;
            yc * (w as usize) + xc
        };
        let gx = luma[idx(x + 1, y)] - luma[idx(x - 1, y)];
        let gy = luma[idx(x, y + 1)] - luma[idx(x, y - 1)];
        (gx * gx + gy * gy).sqrt()
    };

    // --- Fused per-pixel USM + edge mix, one row-parallel pass (#1089) ---
    //
    // The USM-scale build and the edge mix were two serial full-image sweeps
    // bridged by a full `sharpened_pixels` buffer and a full `observed_pixels`
    // clone. Both buffers are gone: each output pixel reads its own input at
    // index `i` (same index only — no neighbour reads of `img.pixels`), so the
    // sharpened value is computed inline from `o`/`luma`/`luma_blur` and the
    // mix written straight back into `img.pixels[i]`. The arithmetic is
    // unchanged and per-pixel-independent, so this is bit-identical to the old
    // two-sweep form regardless of row order or parallelism.
    //
    // Cancellation is observed once per output row (top of each row's closure),
    // matching the previous per-row granularity. With a never-cancel token the
    // relaxed load is a no-op and does not perturb the result.
    img.pixels
        .par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y, row)| {
            if cancel.is_cancelled() {
                return;
            }
            let row_base = y * w_usize;
            for (x, px) in row.iter_mut().enumerate() {
                let i = row_base + x;

                // USM scale with shadow guard (mirrors the Metal kernel). `o`
                // is the original pixel — read before we overwrite `*px`.
                let o = *px;
                let li = luma[i];
                let lb = luma_blur[i];
                let lo = li + (li - lb);

                let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, li);
                let safe_luma = li.max(SHADOW_EPSILON);
                let raw_scale = lo / safe_luma;
                let bounded = raw_scale.clamp(MIN_SCALE, MAX_SCALE);
                let scale = 1.0 + weight * (bounded - 1.0);
                let s = [o[0] * scale, o[1] * scale, o[2] * scale];

                // Edge-aware amount + masking blend.
                let edge = if masking_threshold > 1e-3 {
                    let g = gradient(x as i32, y as i32);
                    // Normalise by a rough estimate: gradient around 0.2 on
                    // typical edges → g_norm ∈ [0, 1].
                    let g_norm = (g / 0.2).clamp(0.0, 1.0);
                    if g_norm >= masking_threshold {
                        1.0
                    } else {
                        detail_atten
                    }
                } else {
                    1.0 // masking=0 → mix everywhere equally
                };
                let mix = overall_mix * edge;
                *px = [
                    o[0] + (s[0] - o[0]) * mix,
                    o[1] + (s[1] - o[1]) * mix,
                    o[2] + (s[2] - o[2]) * mix,
                ];
            }
        });
}

/// GLSL-style smoothstep (matches Metal's built-in).
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
#[path = "sharpen/tests.rs"]
mod tests;

// Fringing + radius tests split further into `sharpen/tests_fringing.rs`
// (600-LOC budget).
#[cfg(test)]
#[path = "sharpen/tests_fringing.rs"]
mod tests_fringing;
