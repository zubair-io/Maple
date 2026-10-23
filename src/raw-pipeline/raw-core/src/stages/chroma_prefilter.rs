//! Decode-time chroma pre-filter (#1104, tone/zoom design spec § 3.1).
//!
//! A luma-guided sparse cross-bilateral filter applied to opponent chroma
//! only, as part of the decode product: in the capture stage's fixed as-shot
//! Rec.2020 basis (#5213), after retouch and before BM3D, capture
//! sharpening, white balance, DCP and all user adjustments. Because it lands inside the cached decoded
//! scene-linear buffer, its per-slider-tick cost is zero. No GPU port —
//! the stage never runs per tick (spec § 3.1 "Gates").
//!
//! ## Algorithm (clean-room per the design spec)
//!
//! - Opponent decomposition: `Y = dot(LUMA_REC2020, RGB)`, `C1 = R − Y`,
//!   `C2 = B − Y`. Linear 3×3 algebra — deliberately NOT an Oklab
//!   round-trip (ticket #05 flagged that decode-time cost).
//! - C1/C2 are filtered with a 9-tap sparse cross-bilateral kernel: the
//!   center plus two 4-tap 90°-rotation orbits spanning ±4 px (≈9 px).
//!   No tap offset is congruent to the CFA period (never (even, even)
//!   for 2×2 Bayer, never ≡ (0, 0) mod 6 for X-Trans), which decorrelates
//!   the kernel from CFA-periodic demosaic noise.
//! - The range weight is driven by **luma difference only** (rational /
//!   Cauchy falloff), normalised by the local luma scale so the response
//!   is exposure-invariant; a quadratic spatial penalty derates the outer
//!   orbit. Luma edges therefore stop chroma diffusion, and `Y` itself
//!   passes through untouched — exactly the "bias residual noise toward
//!   luminance" property.
//! - **Chroma-magnitude clamp:** if the filtered chroma magnitude exceeds
//!   the original, it is rescaled back. Smoothing may only desaturate
//!   noise, never bleed color into a pixel — prevents blotching.
//! - Reconstruction preserves Y: `R' = R + δ1`, `B' = B + δ2`,
//!   `G' = G − (wR·δ1 + wB·δ2) / wG`.
//!
//! ## Exact-identity guarantee (grey-card gates)
//!
//! The filter is computed in **delta form**: the chroma correction is
//! `δ = Σ wᵢ·(Cᵢ − C_center) / Σ wᵢ`. On any uniform field every tap's
//! `Cᵢ − C_center` is exactly `0.0`, so `δ` is exactly `0.0` and the
//! output pixel is bit-identical to the input — no float-rounding drift
//! from a weighted average of equal values, and no drift from a
//! `Y + C` reconstruction round-trip. `test_synthetic_grey.sh` flatness
//! invariants and all grey predictors hold at ANY strength, not just 0.
//!
//! `strength < 1e-3` (the shipped default 0) skips the stage entirely —
//! bit-identical, allocation-free.
//!
//! Tile-safety: the kernel is translation-invariant with a ±4 px stencil,
//! well inside `TILE_OVERLAP_PX` (48), so the tile develop runs it too.

use rayon::prelude::*;

use crate::image::{ColorSpace, Image};

#[path = "chroma_prefilter_params.rs"]
mod parameters;
use parameters::*;

/// Apply the decode-time chroma pre-filter. `strength` is the
/// `papp:ChromaPrefilter` slider value in `[0, 100]`; `< 1e-3` (the
/// default 0) is an exact bit-identical skip.
///
/// Deterministic across thread counts: each output pixel is a pure
/// function of a fixed input neighborhood (rayon parallelism is over
/// disjoint output rows; there is no cross-thread accumulation).
pub fn apply(img: &mut Image, strength: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if strength < 1e-3 {
        return;
    }

    let sigma = SIGMA_MAX_REL * (strength.min(100.0) / 100.0);
    let w = img.width as usize;
    let h = img.height as usize;

    // Luma plane, computed once (the range weight reads it per tap).
    let ys: Vec<f32> = img
        .pixels
        .par_iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();

    let src = &img.pixels;
    let ys_ref = &ys;
    let mut out: Vec<[f32; 3]> = vec![[0.0; 3]; src.len()];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, dst) in row.iter_mut().enumerate() {
            let i = y * w + x;
            let p = src[i];
            let yc = ys_ref[i];
            let c1c = p[0] - yc;
            let c2c = p[2] - yc;

            // Delta-form weighted average — see module docs for why this
            // (and not a plain weighted mean) is what makes uniform fields
            // bit-exact. The center tap contributes weight 1, delta 0.
            let mut num1 = 0.0f32;
            let mut num2 = 0.0f32;
            let mut den = 1.0f32;
            for (k, (dx, dy)) in TAPS.iter().enumerate() {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue; // skip out-of-bounds taps; den renormalises
                }
                let j = ny as usize * w + nx as usize;
                let yt = ys_ref[j];
                // Range weight from LUMA difference only (Cauchy falloff,
                // relative to the local level + pedestal). The level's
                // magnitude keeps the scale positive on the signed
                // capture-first basis (#5213), where luma can go negative.
                let scale = (0.5 * (yc + yt)).abs() + PEDESTAL;
                let t = (yt - yc) / (sigma * scale);
                let wr = 1.0 / (1.0 + t * t);
                let wk = SPATIAL_W[k] * wr;
                let q = src[j];
                num1 += wk * ((q[0] - yt) - c1c);
                num2 += wk * ((q[2] - yt) - c2c);
                den += wk;
            }
            let mut d1 = num1 / den;
            let mut d2 = num2 / den;

            // Chroma-magnitude clamp: filtered magnitude may never exceed
            // the original — smoothing only desaturates, never bleeds.
            let c1f = c1c + d1;
            let c2f = c2c + d2;
            let m0_sq = c1c * c1c + c2c * c2c;
            let mf_sq = c1f * c1f + c2f * c2f;
            if mf_sq > m0_sq {
                let s = if mf_sq > 0.0 {
                    (m0_sq / mf_sq).sqrt()
                } else {
                    0.0
                };
                d1 = c1f * s - c1c;
                d2 = c2f * s - c2c;
            }

            // Reconstruct with Y algebraically invariant:
            //   Y' = Y + wR·δ1 + wB·δ2 + wG·δg = Y  ⇒  δg = −(wR·δ1 + wB·δ2)/wG
            let dg = -(LUMA_REC2020[0] * d1 + LUMA_REC2020[2] * d2) / LUMA_REC2020[1];
            *dst = [p[0] + d1, p[1] + dg, p[2] + d2];
        }
    });
    img.pixels = out;
}

#[cfg(test)]
mod tests;
