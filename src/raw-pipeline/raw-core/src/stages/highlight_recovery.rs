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
//! ### What Path C does (`ChromaticAdaptation`, DEFAULT since #335)
//!
//! The variant was originally landed in #334 as opt-in because the PR body
//! read the unchanged main-bias numbers as a regression. A per-case Off-vs-CA
//! diff in #335 showed the algorithm is a near-noop on the budget-gated
//! baseline fixtures (ΔΔE ≤ 0.001, bias deltas in the 5th decimal): the
//! pixels post-WB rarely cross their per-channel ceilings on these scenes,
//! so the `!any_clipped` early-out fires and the stage is effectively a
//! pass-through. The flip was parity-safe.
//!
//! For each pixel where one or two channels exceed the per-channel ceiling:
//!
//! 1. Sample unclipped neighbors in a 7×7 window.
//! 2. Compute their average chromaticity in `(R/G, B/G)` space, but only count
//!    neighbors with NO clipped channels. With <4 unclipped neighbors the
//!    sample is unreliable; the per-pixel confidence collapses to zero and we
//!    fall back to the WB-implied neutral chromaticity `(1, 1)`.
//! 3. Blend the local chromaticity with the WB-implied neutral chromaticity
//!    `(1, 1)` (post-WB neutral white is `(1, 1, 1)` — that's the point of WB
//!    pre-gain) using a confidence weight `w = unclipped_count / 49` clamped
//!    to `[0, 1]`. `w == 1` means trust the local neighborhood completely;
//!    `w == 0` means assume the highlight is neutral.
//! 4. Extrapolate the clipped channel(s) so the pixel's chromaticity matches
//!    the blended target. We keep the unclipped channels fixed and solve for
//!    the clipped channel(s) given a reference channel (the brightest of the
//!    three).
//! 5. For fully-clipped pixels (all 3 channels at or past their ceilings),
//!    leave them as neutral `(X, X, X)` at the largest per-channel ceiling
//!    seen across the three channels — that's the saturation white at the
//!    post-WB-implied neutral chromaticity.
//! 6. Soft-feather the boundary by writing the reconstructed value back as a
//!    blend with the original at small clip excess (the per-channel headroom
//!    above the ceiling gives a natural ramp).
//!
//! ### Performance
//!
//! Two-pass: build a per-pixel `u8` clip mask first, then iterate only over
//! pixels with `clipped_count >= 1`. The 7×7 neighbor scan only fires on the
//! clipped subset — in scenes without blown highlights the stage is a
//! mask-build + early-out, ~one allocation. The clip-pixel inner loop is
//! still O(R²) per clipped pixel; that's the budget the brief calls out.

use crate::{
    image::{ColorSpace, Image},
    xmp::HighlightRecoveryMode,
};
use rayon::prelude::*;

/// Per-channel "this channel is clipped" margin, in post-WB camera-RGB units.
const EPSILON: f32 = 0.005;

/// Half-window for the unclipped-neighbor scan.
const NEIGHBOR_RADIUS: i32 = 3; // 7×7 window per spec.

/// Number of pixels in the 7×7 window — used as the denominator when computing
/// the confidence weight.
const NEIGHBOR_WINDOW_AREA: f32 = ((2 * NEIGHBOR_RADIUS + 1) * (2 * NEIGHBOR_RADIUS + 1)) as f32;

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
            // get the new chromatic-adaptation behavior. The old code paths
            // produced the magenta cast that motivated this rewrite (see
            // module-level comment) — silently upgrading is the right call.
            apply_chromatic_adaptation(img, as_shot_neutral);
        }
        HighlightRecoveryMode::ChromaticAdaptation => {
            apply_chromatic_adaptation(img, as_shot_neutral);
        }
        HighlightRecoveryMode::OklabChromaReduction => {
            // Ticket #471: this variant runs POST-DCP in scene-linear
            // Rec.2020 D65 where Oklab is well-defined. Nothing to do here
            // (camera-native pre-DCP). The work happens in
            // `super::highlight_recovery_oklab::apply_post_dcp`.
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

/// Path C — chromatic-adaptation highlight reconstruction. See module comment.
fn apply_chromatic_adaptation(img: &mut Image, neutral: [f32; 3]) {
    let w = img.width as i32;
    let h = img.height as i32;
    if w == 0 || h == 0 {
        return;
    }
    let ceil = ceilings(neutral);
    let thresholds = [ceil[0] - EPSILON, ceil[1] - EPSILON, ceil[2] - EPSILON];

    // Cheap pre-scan: most scenes have no clipping post-WB (the common case
    // now that ChromaticAdaptation is the default — see #335 per-fixture
    // diff). Bail out before touching the heap. `any()` short-circuits on
    // the first clipped pixel.
    let any_clipped = img
        .pixels
        .iter()
        .any(|p| p[0] >= thresholds[0] || p[1] >= thresholds[1] || p[2] >= thresholds[2]);
    if !any_clipped {
        return;
    }

    // Pass 1: build a per-pixel clip mask. Bit 0..2 = "channel c is clipped".
    // Pixels with any channel ≥ its per-channel ceiling minus EPSILON count as
    // "clipped" for the purposes of neighbor exclusion. Storing the mask in a
    // `Vec<u8>` rather than recomputing keeps the inner loop branch-free.
    let n = img.pixels.len();
    let mut clip_mask = vec![0u8; n];
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
    }

    // Snapshot of inputs so the inner loop reads consistent values even as we
    // write the reconstructed outputs back to `img.pixels`.
    let pixels_in = img.pixels.clone();

    // Pass 2: reconstruct each clipped pixel.
    img.pixels
        .par_iter_mut()
        .enumerate()
        .for_each(|(idx, p_out)| {
            let m = clip_mask[idx];
            if m == 0 {
                return;
            }
            let y = (idx as i32) / w;
            let x = (idx as i32) % w;
            let p_in = pixels_in[idx];
            let clipped_count = m.count_ones();

            // Fully clipped → assume saturation neutral white at the
            // post-WB-implied scale. Pick the largest ceiling as the "white"
            // anchor so the recovered pixel sits at the brightest plausible
            // neutral output. `(X, X, X)` is the chromaticity-preserving
            // answer; we cannot recover scene detail past full sensor
            // saturation, but we can at least stop magenta from leaking in.
            if clipped_count == 3 {
                let x_val = ceil[0].max(ceil[1]).max(ceil[2]);
                *p_out = [x_val, x_val, x_val];
                return;
            }

            // Identify guide channel `u` (brightest unclipped channel)
            let mut u = 0;
            let mut max_u_val = -1.0;
            for c in 0..3 {
                if (m >> c) & 1 == 0 {
                    if p_in[c] > max_u_val {
                        max_u_val = p_in[c];
                        u = c;
                    }
                }
            }

            // Guided bilateral filter propagation
            let mut sum_ratio = [0.0f32; 3];
            let mut sum_w = [0.0f32; 3];
            let mut valid_count = 0;

            for dy in -NEIGHBOR_RADIUS..=NEIGHBOR_RADIUS {
                let ny = y + dy;
                if ny < 0 || ny >= h {
                    continue;
                }
                for dx in -NEIGHBOR_RADIUS..=NEIGHBOR_RADIUS {
                    let nx = x + dx;
                    if nx < 0 || nx >= w {
                        continue;
                    }
                    let n_idx = (ny * w + nx) as usize;
                    if clip_mask[n_idx] != 0 {
                        continue; // Only fully-unclipped neighbors contribute.
                    }
                    let np = pixels_in[n_idx];
                    if np[u] > 1e-4 {
                        let spatial_dist_sq = (dx * dx + dy * dy) as f32;
                        let range_dist = np[u] - p_in[u];
                        let range_dist_sq = range_dist * range_dist;

                        // Bilateral weight calculation
                        // sigma_s = 3.0 (2 * sigma_s^2 = 18.0)
                        // sigma_r = 0.15 (2 * sigma_r^2 = 0.045)
                        let w_n = (-spatial_dist_sq / 18.0).exp() * (-range_dist_sq / 0.045).exp();

                        for c in 0..3 {
                            if (m >> c) & 1 == 1 {
                                sum_ratio[c] += w_n * (np[c] / np[u]);
                                sum_w[c] += w_n;
                            }
                        }
                        valid_count += 1;
                    }
                }
            }

            // Confidence based on number of contributing neighbors
            let mut conf = (valid_count as f32) / NEIGHBOR_WINDOW_AREA;
            if valid_count < 4 {
                conf = 0.0;
            }
            conf = conf.clamp(0.0, 1.0);

            let mut reconstructed = p_in;
            for c in 0..3 {
                if (m >> c) & 1 == 1 {
                    let local_ratio = if sum_w[c] > 1e-6 {
                        sum_ratio[c] / sum_w[c]
                    } else {
                        1.0
                    };
                    let blended_ratio = local_ratio * conf + 1.0 * (1.0 - conf);
                    reconstructed[c] = p_in[u] * blended_ratio;
                }
            }

            // Ensure highlights roll off gracefully to white without chromatic shifts
            let max_val = reconstructed[0].max(reconstructed[1]).max(reconstructed[2]);
            let max_ceil = ceil[0].max(ceil[1]).max(ceil[2]);
            let roll_off_start = max_ceil * 0.7;
            let denom = max_ceil - roll_off_start;
            if denom > 1e-4 && max_val > roll_off_start {
                let t = ((max_val - roll_off_start) / denom).clamp(0.0, 1.0);
                for c in 0..3 {
                    reconstructed[c] = reconstructed[c] * (1.0 - t) + max_val * t;
                }
            }

            *p_out = reconstructed;
        });
}

// Tests live in the sibling `highlight_recovery_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "highlight_recovery_tests.rs"]
mod tests;
