//! Highlight reconstruction per spec § 3.3a — Path C (chromatic-adaptation).
//!
//! Operates on camera-native linear RGB **after** the DNG WB pre-gain has run
//! (see `pipeline::develop`). At that point the per-channel ceiling is not 1.0
//! but `1.0 / AsShotNeutral[c]`: sensor saturation lives at the raw white
//! level (1.0 in normalized camera RGB), and `apply_pre_gain` multiplies each
//! channel by `1.0 / neutral[c]`. Bayer green typically saturates first and
//! `AsShotNeutral[1] == 1.0`, so post-WB green clips at 1.0 while R and B
//! clip at `1.0 / neutral[r]` ≈ 2.0 and `1.0 / neutral[b]` ≈ 1.4 respectively.
//!
//! ### What the magenta cast looked like
//!
//! Sensor `(R=0.8, G=1.0_clipped, B=0.7)` → post-WB with neutral
//! `(0.5, 1.0, 0.7)` → `(1.6, 1.0, 1.0)`. The clipped pixel reads as
//! R-heavy + B-rich vs. G stuck at 1.0 — magenta. The legacy `Blend` mode
//! pulled the clipped channels DOWN toward `max_unclipped ≤ 1.0`, which
//! made the situation worse.
//!
//! ### Algorithm (`ChromaticAdaptation`)
//!
//! For each pixel where one or two channels exceed the per-channel ceiling:
//!
//! 1. **Adaptive 7→63 search** for unclipped neighbours via a summed-area-table
//!    (SAT). Build three SATs over fully-unclipped pixels — `Σ R/G`, `Σ B/G`,
//!    and a count — in one O(WH) pass. Per clipped pixel, query at radii
//!    `{3, 7, 15, 31}` (= 7×7 … 63×63 windows) until at least
//!    `MIN_NEIGHBOURS` contribute, or the cap is hit. Each query is O(1).
//! 2. Local chromaticity is the SAT-derived mean of `(R/G, B/G)` over the
//!    accepted window.
//! 3. **Scene-aware fallback.** Confidence
//!    `w = min(count / MIN_NEIGHBOURS, 1)` is independent of window size — once
//!    we have enough neighbours we trust the local sample fully regardless of
//!    how far we had to search. When `w < 1` the missing weight blends in the
//!    **scene-median chromaticity** computed once at stage entry from a
//!    downsampled scan of the unclipped pixels. This preserves warm sunsets:
//!    a clipped pixel inside a vast warm-toned region still falls back to
//!    "warm" rather than "neutral white". When zero unclipped pixels exist
//!    anywhere in the frame the global fallback is `(1, 1)` (post-WB neutral).
//! 4. **Anchor on the brightest unclipped channel** (Bayer green stays clipped
//!    most often; the chosen anchor is whichever of the three holds the most
//!    signal). Derive an implied G from `anchor + target_chromaticity`, then
//!    `R = G·target_rg`, `B = G·target_bg`.
//! 5. **Invariant clamp.** A clipped channel cannot reconstruct to **below**
//!    its observed clipped value — the sensor reported at-least-this. Apply
//!    `recovered[c] = max(p_in[c], implied[c])`. Without this clamp two-
//!    channel clips drift the brighter channel down (e.g. `[2.0, 1.0, 1.2]`
//!    in a neutral neighbourhood collapses to `[1.2, 1.2, 1.2]` — the bug
//!    that produced the negative baseline-bias in #325).
//! 6. **Fully-clipped pixels.** All three channels at or past their ceilings:
//!    write neutral `(X, X, X)` at `X = max(ceiling)`. Saturation-white is the
//!    chromaticity-preserving answer; we cannot recover scene detail past
//!    full sensor saturation, but we can at least stop the channel-
//!    magnification cast leaking through.
//!
//! ### Performance
//!
//! - Build per-pixel clip mask (one pass, O(WH)).
//! - Build three f32 SATs (`sum_rg`, `sum_bg`, `count`) over unclipped
//!   contributors — one pass, O(WH), three buffers of `(W+1)·(H+1)` floats.
//! - Compute the scene-median chromaticity over a strided sample of unclipped
//!   pixels — O(WH / stride²), one allocation.
//! - Per clipped pixel: up to four SAT rectangle subtractions and a couple
//!   of divisions. The full inner-loop work is bounded by the clipped-pixel
//!   subset; in scenes without blown highlights the stage is a mask-build
//!   + early-out.

use crate::{
    image::{ColorSpace, Image},
    xmp::HighlightRecoveryMode,
};

/// Per-channel "this channel is clipped" margin, in post-WB camera-RGB units.
const EPSILON: f32 = 0.005;

/// Ladder of half-widths (radii) used for the adaptive neighbour search.
/// Window sizes are `(2r+1)²` — 7×7 then 15×15.
///
/// The cap is tuned to keep the stage under the 4 ms slider-tick budget on
/// a 2 MP viewport (#336). The SAT infrastructure scales cleanly to a
/// 63×63 cap (`[3, 7, 15, 31]`), but each additional ladder level adds a
/// triple SAT rectangle query to every clipped pixel; the worst-case
/// "large blown block" pattern at 2 MP regresses past 4 ms with three or
/// more levels enabled. The 15×15 cap covers blown regions up to 7 pixels
/// deep — typical for sun, spec highlights, and most cloud edges on a
/// 2 MP preview. Pixels deeper inside a blown region fall back to the
/// **scene-median chromaticity** (shortcoming #1 fix), so the worst case
/// is "warm sunset stays warm" rather than the neutral-white collapse
/// that motivated this ticket.
///
/// To raise the cap, bump the array and re-measure
/// `perf_chromatic_adaptation_2mp_large_block_under_4ms_release` —
/// `[3, 7, 15]` (31×31) is the next step, then `[3, 7, 15, 31]` (63×63).
const NEIGHBOR_RADII: &[i32] = &[3, 7];

/// Minimum number of unclipped neighbour contributions before we stop growing
/// the search radius. Below this we keep widening (or, at the cap, fall back
/// to the scene-median chromaticity). Tuned so the 7×7 default still satisfies
/// it in a typical edge region — 16 contributors fits in the central 5×5 of a
/// 7×7 window once any edge of the clipped region is in view.
const MIN_NEIGHBORS: u32 = 16;

/// Stride for the scene-median chromaticity sample. We do not need every
/// unclipped pixel; a strided sample over the whole frame is a stable median
/// estimator and keeps the stage's overhead negligible on small thumbs.
const SCENE_MEDIAN_STRIDE: usize = 64;

/// Apply highlight reconstruction per spec § 3.3a.
///
/// `as_shot_neutral` is the DNG `AsShotNeutral` triplet (G normalized to 1.0).
/// It encodes the per-channel post-WB clip ceiling: `ceiling[c] = 1.0 /
/// neutral[c]`. The stage runs after `white_balance::apply_pre_gain`, so the
/// ceiling tells us where the sensor actually clipped vs. where the buffer
/// happens to sit numerically.
pub fn apply(img: &mut Image, mode: HighlightRecoveryMode, as_shot_neutral: [f32; 3]) {
    img.assert_space(ColorSpace::CameraNativeLinearRgb);
    match mode {
        HighlightRecoveryMode::Off => {}
        HighlightRecoveryMode::Blend | HighlightRecoveryMode::Luminance => {
            // Back-compat: legacy XMPs that explicitly request the old modes
            // get the new chromatic-adaptation behaviour. The old code paths
            // produced the magenta cast that motivated this rewrite (see
            // module-level comment) — silently upgrading is the right call.
            apply_chromatic_adaptation(img, as_shot_neutral);
        }
        HighlightRecoveryMode::ChromaticAdaptation => {
            apply_chromatic_adaptation(img, as_shot_neutral);
        }
    }
}

/// Per-channel post-WB clip ceiling. Sensor saturation maps to `1.0 /
/// neutral[c]` after `apply_pre_gain`. Clamps the denominator at 1e-6 to keep
/// a degenerate `AsShotNeutral` from producing infinities.
fn ceilings(neutral: [f32; 3]) -> [f32; 3] {
    [
        1.0 / neutral[0].abs().max(1e-6),
        1.0 / neutral[1].abs().max(1e-6),
        1.0 / neutral[2].abs().max(1e-6),
    ]
}

/// Scene-median `(R/G, B/G)` over fully-unclipped pixels, sampled at
/// `SCENE_MEDIAN_STRIDE`. Returns `(1.0, 1.0)` (post-WB neutral) when no
/// unclipped pixel is visible in the sample.
fn scene_median_chromaticity(
    pixels: &[[f32; 3]],
    clip_mask: &[u8],
    width: usize,
    height: usize,
) -> (f32, f32) {
    let mut rg: Vec<f32> = Vec::new();
    let mut bg: Vec<f32> = Vec::new();
    let stride = SCENE_MEDIAN_STRIDE.max(1);
    let mut y = 0usize;
    while y < height {
        let mut x = 0usize;
        while x < width {
            let idx = y * width + x;
            if clip_mask[idx] == 0 {
                let p = pixels[idx];
                if p[1] > 1e-4 {
                    rg.push(p[0] / p[1]);
                    bg.push(p[2] / p[1]);
                }
            }
            x += stride;
        }
        y += stride;
    }
    if rg.is_empty() {
        return (1.0, 1.0);
    }
    // Median via select; cheap at the sample size SCENE_MEDIAN_STRIDE produces
    // (≤ 1024 elements on a 100 MP frame at stride=64). Linear sort is fine.
    rg.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    bg.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = rg.len() / 2;
    (rg[mid], bg[mid])
}

/// Inclusive-rectangle sum over a per-channel SAT. Returns the sum across
/// `[x0, x1] × [y0, y1]` (both endpoints inclusive). `sat` has shape
/// `(width + 1) × (height + 1)`.
#[inline(always)]
fn sat_sum(
    sat: &[f32],
    stride: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
) -> f32 {
    let a = sat[(y1 + 1) * stride + (x1 + 1)];
    let b = sat[y0 * stride + (x1 + 1)];
    let c = sat[(y1 + 1) * stride + x0];
    let d = sat[y0 * stride + x0];
    a - b - c + d
}

/// Build three parallel SoA SATs (`sum_rg`, `sum_bg`, `count`) from pixel +
/// clip-mask buffers. Output shape is `(width + 1) × (height + 1)` with the
/// first row and column zeroed.
///
/// SoA (three `Vec<f32>` rather than one `Vec<[f32; 3]>`) lets the prefix-sum
/// writes hit each row sequentially, one cache line per channel; on Apple
/// silicon this is measurably faster than the 12-byte-stride AoS layout.
fn build_sat_soa(
    pixels: &[[f32; 3]],
    clip_mask: &[u8],
    width: usize,
    height: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let stride = width + 1;
    let total = stride * (height + 1);
    let mut sat_rg = vec![0.0f32; total];
    let mut sat_bg = vec![0.0f32; total];
    let mut sat_ct = vec![0.0f32; total];
    for y in 0..height {
        let mut row_rg = 0.0f32;
        let mut row_bg = 0.0f32;
        let mut row_ct = 0.0f32;
        let row_in = y * width;
        let row_out = (y + 1) * stride;
        let row_above = y * stride;
        for x in 0..width {
            let i = row_in + x;
            if clip_mask[i] == 0 {
                let p = pixels[i];
                if p[1] > 1e-4 {
                    row_rg += p[0] / p[1];
                    row_bg += p[2] / p[1];
                    row_ct += 1.0;
                }
            }
            sat_rg[row_out + (x + 1)] = sat_rg[row_above + (x + 1)] + row_rg;
            sat_bg[row_out + (x + 1)] = sat_bg[row_above + (x + 1)] + row_bg;
            sat_ct[row_out + (x + 1)] = sat_ct[row_above + (x + 1)] + row_ct;
        }
    }
    (sat_rg, sat_bg, sat_ct)
}

/// Path C — chromatic-adaptation highlight reconstruction. See module comment.
fn apply_chromatic_adaptation(img: &mut Image, neutral: [f32; 3]) {
    let w = img.width as i32;
    let h = img.height as i32;
    if w == 0 || h == 0 {
        return;
    }
    let uw = w as usize;
    let uh = h as usize;
    let ceil = ceilings(neutral);
    let thresholds = [ceil[0] - EPSILON, ceil[1] - EPSILON, ceil[2] - EPSILON];

    // Pass 1: build a per-pixel clip mask. Bit 0..2 = "channel c is clipped".
    // Pixels with any channel ≥ its per-channel ceiling minus EPSILON count
    // as "clipped" for the purposes of neighbour exclusion. Storing the mask
    // in a `Vec<u8>` rather than recomputing keeps the inner loop
    // branch-free.
    let n = img.pixels.len();
    let mut clip_mask = vec![0u8; n];
    let mut any_clipped = false;
    for (i, p) in img.pixels.iter().enumerate() {
        let mut m: u8 = 0;
        if p[0] >= thresholds[0] {
            m |= 0b001;
        }
        if p[1] >= thresholds[1] {
            m |= 0b010;
        }
        if p[2] >= thresholds[2] {
            m |= 0b100;
        }
        clip_mask[i] = m;
        if m != 0 {
            any_clipped = true;
        }
    }
    if !any_clipped {
        return; // Fast path: nothing to do.
    }

    // We do NOT clone img.pixels. Each clipped pixel reads `p_in` from
    // img.pixels at its own index before writing back at the same index;
    // unclipped pixels are never written. The SAT and scene-median pass
    // also read directly from img.pixels — they need the pre-recovery
    // values, but only at unclipped indices, which are never mutated.
    // Scene-median chromaticity — the "scene-aware fallback" target used when
    // local confidence is low.
    let (scene_rg, scene_bg) =
        scene_median_chromaticity(&img.pixels, &clip_mask, uw, uh);

    // Pass 2: build three parallel SATs (SoA) over unclipped contributions.
    // Each pixel that is fully unclipped (clip_mask == 0) and has G > epsilon
    // contributes `(R/G, B/G, 1.0)`; everything else contributes `(0, 0, 0)`.
    // The SATs then answer arbitrary rectangle queries in O(1).
    //
    // SoA (three `Vec<f32>` rather than one `Vec<[f32; 3]>`) lets each row's
    // writes stream linearly through one cache line per channel. We also
    // exploit "check count first, fetch rg/bg only on a hit" in the query
    // loop — most clipped pixels satisfy MIN_NEIGHBORS at the smallest
    // radius, so two-thirds of the SAT memory is never read in practice.
    let (sat_rg, sat_bg, sat_ct) = build_sat_soa(&img.pixels, &clip_mask, uw, uh);
    let sat_stride = uw + 1;

    // Pass 3: reconstruct each clipped pixel.
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let m = clip_mask[idx];
            if m == 0 {
                continue;
            }
            let p_in = img.pixels[idx];
            let clipped_count = m.count_ones();

            // Fully clipped → assume saturation neutral white at the
            // post-WB-implied scale. Pick the largest ceiling as the "white"
            // anchor so the recovered pixel sits at the brightest plausible
            // neutral output. `(X, X, X)` is the chromaticity-preserving
            // answer; we cannot recover scene detail past full sensor
            // saturation, but we can at least stop magenta from leaking in.
            if clipped_count == 3 {
                let x_val = ceil[0].max(ceil[1]).max(ceil[2]);
                img.pixels[idx] = [x_val, x_val, x_val];
                continue;
            }

            // 1/2-channel clip — adaptive SAT-based neighbour search.
            // Check the cheap (count-only) SAT first; widen if needed; only
            // pay the rg/bg lookups once we've found a radius that satisfies
            // MIN_NEIGHBORS (or we've exhausted the ladder).
            let mut sum_rg = 0.0f32;
            let mut sum_bg = 0.0f32;
            let mut count: u32 = 0;
            let mut best_box = (0usize, 0usize, 0usize, 0usize);
            for &r in NEIGHBOR_RADII {
                let x0 = (x - r).max(0) as usize;
                let y0 = (y - r).max(0) as usize;
                let x1 = (x + r).min(w - 1) as usize;
                let y1 = (y + r).min(h - 1) as usize;
                let c_sum = sat_sum(&sat_ct, sat_stride, x0, y0, x1, y1);
                if c_sum >= MIN_NEIGHBORS as f32 {
                    sum_rg = sat_sum(&sat_rg, sat_stride, x0, y0, x1, y1);
                    sum_bg = sat_sum(&sat_bg, sat_stride, x0, y0, x1, y1);
                    count = c_sum as u32;
                    break;
                }
                if c_sum > count as f32 {
                    count = c_sum as u32;
                    best_box = (x0, y0, x1, y1);
                }
            }
            if count > 0 && sum_rg == 0.0 && sum_bg == 0.0 {
                // Best-so-far path: never reached MIN_NEIGHBORS but found
                // some neighbours at the largest radius tried. Fetch the
                // rg/bg sums for the best box.
                let (x0, y0, x1, y1) = best_box;
                sum_rg = sat_sum(&sat_rg, sat_stride, x0, y0, x1, y1);
                sum_bg = sat_sum(&sat_bg, sat_stride, x0, y0, x1, y1);
            }

            // Confidence is now a function of `count / MIN_NEIGHBORS`, not
            // window area — once we have enough samples we trust the local
            // chromaticity fully regardless of how far we searched.
            let conf = ((count as f32) / (MIN_NEIGHBORS as f32)).clamp(0.0, 1.0);

            let local_rg = if count > 0 { sum_rg / count as f32 } else { scene_rg };
            let local_bg = if count > 0 { sum_bg / count as f32 } else { scene_bg };

            // Target chromaticity = blend(local, scene_median). With low
            // confidence we trust the scene-wide median (warm sunset stays
            // warm); with high confidence we trust the local sample (a
            // boundary edge follows its own neighbourhood).
            let target_rg = local_rg * conf + scene_rg * (1.0 - conf);
            let target_bg = local_bg * conf + scene_bg * (1.0 - conf);

            // Extrapolate to maintain chromaticity. Strategy:
            //   - Use the brightest **unclipped** channel as the reference.
            //   - Solve for the clipped channel(s) from the target ratios.
            //   - If no unclipped channel exists (shouldn't happen because
            //     `clipped_count < 3`), fall through to leaving the pixel.
            let mut p_out = p_in;
            let mut anchor_c: Option<usize> = None;
            let mut anchor_val = f32::MIN;
            for c in 0..3 {
                if (m >> c) & 1 == 0 && p_in[c] > anchor_val {
                    anchor_val = p_in[c];
                    anchor_c = Some(c);
                }
            }
            if let Some(ac) = anchor_c {
                // Derive G implied by the anchor + target chromaticity.
                let g_implied = match ac {
                    0 => {
                        // anchor is R; target_rg = R/G  → G = R/target_rg
                        if target_rg.abs() > 1e-6 { p_in[0] / target_rg } else { p_in[1] }
                    }
                    1 => p_in[1], // anchor is G; G is fixed.
                    2 => {
                        // anchor is B; target_bg = B/G → G = B/target_bg
                        if target_bg.abs() > 1e-6 { p_in[2] / target_bg } else { p_in[1] }
                    }
                    _ => unreachable!(),
                };
                let r_implied = g_implied * target_rg;
                let b_implied = g_implied * target_bg;
                let implied = [r_implied, g_implied, b_implied];

                // Replace each clipped channel with the implied value, with
                // an invariant clamp:
                //
                //   recovered[c] = max(p_in[c], implied[c])
                //
                // The sensor reported "at least p_in[c]" before WB pre-gain
                // pushed it past the ceiling — reconstructing to *below* the
                // observed value is wrong-directional (it darkens the
                // brightest unclipped anchor when two channels clip). This
                // clamp was deliberately absent in #325 ("derived from a
                // stable anchor … letting it fall below the input is
                // legitimate"); empirically that produced ~0.1 negative
                // channel bias on every baseline fixture. The clamp restores
                // the at-least-as-bright invariant the sensor actually
                // reports.
                for c in 0..3 {
                    if (m >> c) & 1 == 1 {
                        p_out[c] = implied[c].max(p_in[c]);
                    }
                }
            }
            img.pixels[idx] = p_out;
        }
    }
}

#[cfg(test)]
#[path = "highlight_recovery_tests.rs"]
mod tests;
