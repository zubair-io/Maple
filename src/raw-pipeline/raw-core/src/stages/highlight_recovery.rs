//! Highlight reconstruction per spec § 3.3a — Path C (chromatic-adaptation).
//!
//! Operates on camera-native linear RGB **after** the DNG WB pre-gain has run
//! (see `pipeline::develop`). At that point the per-channel ceiling is not 1.0
//! but `2^BaselineExposure / AsShotNeutral[c]`: sensor saturation lives at
//! the raw white level (1.0 in normalized camera RGB). Develop applies the
//! baseline exposure gain, then `apply_pre_gain` multiplies each channel by
//! `1.0 / neutral[c]`. The examples below assume BaselineExposure is zero.
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
/// Together with `baseline_exposure` in EV it encodes the post-WB clip
/// ceiling: `ceiling[c] = 2^BaselineExposure / neutral[c]`. Pass an identity
/// neutral when the input's white balance is already baked in. The stage
/// runs after both baseline exposure and the white-balance pre-gain.
pub fn apply(
    img: &mut Image,
    mode: HighlightRecoveryMode,
    as_shot_neutral: [f32; 3],
    baseline_exposure: f32,
) {
    img.assert_space(ColorSpace::CameraNativeLinearRgb);
    match mode {
        HighlightRecoveryMode::Off => {}
        HighlightRecoveryMode::Blend | HighlightRecoveryMode::Luminance => {
            // Back-compat: legacy XMPs that explicitly request the old modes
            // get the new chromatic-adaptation behavior. The old code paths
            // produced the magenta cast that motivated this rewrite (see
            // module-level comment) — silently upgrading is the right call.
            apply_chromatic_adaptation(img, as_shot_neutral, baseline_exposure);
        }
        HighlightRecoveryMode::ChromaticAdaptation => {
            apply_chromatic_adaptation(img, as_shot_neutral, baseline_exposure);
        }
        HighlightRecoveryMode::OklabChromaReduction => {
            // Ticket #471: this variant runs POST-DCP in scene-linear
            // Rec.2020 D65 where Oklab is well-defined. Nothing to do here
            // (camera-native pre-DCP). The work happens in
            // `super::highlight_recovery_oklab::apply_post_dcp`.
        }
    }
}

/// Per-channel post-WB clip ceiling. Sensor saturation maps to
/// `2^BaselineExposure / neutral[c]`. Clamps the denominator at 1e-6 to keep
/// a degenerate `AsShotNeutral` from producing infinities.
fn ceilings(neutral: [f32; 3], baseline_exposure: f32) -> [f32; 3] {
    // Match the baseline-exposure stage's negligible-gain fast path in
    // full, sized, tile and panorama develop, including its exact boundary.
    let gain = if baseline_exposure.abs() > 1e-4 {
        baseline_exposure.exp2()
    } else {
        1.0
    };
    [
        1.0 / neutral[0].abs().max(1e-6),
        1.0 / neutral[1].abs().max(1e-6),
        1.0 / neutral[2].abs().max(1e-6),
    ]
    .map(|ceiling| ceiling * gain)
}

/// Path C — chromatic-adaptation highlight reconstruction. See module comment.
fn apply_chromatic_adaptation(img: &mut Image, neutral: [f32; 3], baseline_exposure: f32) {
    let w = img.width as i32;
    let h = img.height as i32;
    if w == 0 || h == 0 {
        return;
    }
    let ceil = ceilings(neutral, baseline_exposure);
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
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let m = clip_mask[idx];
            if m == 0 {
                continue;
            }
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
                img.pixels[idx] = [x_val, x_val, x_val];
                continue;
            }

            // 1+2-channel clip — gather (R/G, B/G) from unclipped neighbors.
            let mut sum_rg = 0.0f32;
            let mut sum_bg = 0.0f32;
            let mut count: u32 = 0;
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
                    if np[1] > 1e-4 {
                        sum_rg += np[0] / np[1];
                        sum_bg += np[2] / np[1];
                        count += 1;
                    }
                }
            }

            // Confidence: fraction of the 7×7 window that contributed.
            // < 4 contributing neighbors is unstable — collapse confidence
            // to zero and rely on the WB-implied neutral target.
            let mut conf = (count as f32) / NEIGHBOR_WINDOW_AREA;
            if count < 4 {
                conf = 0.0;
            }
            conf = conf.clamp(0.0, 1.0);

            let local_rg = if count > 0 {
                sum_rg / count as f32
            } else {
                1.0
            };
            let local_bg = if count > 0 {
                sum_bg / count as f32
            } else {
                1.0
            };

            // Target chromaticity = blend(local, neutral). Post-WB neutral
            // white is (1,1,1), so the neutral chromaticity is (1, 1).
            let target_rg = local_rg * conf + 1.0 * (1.0 - conf);
            let target_bg = local_bg * conf + 1.0 * (1.0 - conf);

            // Extrapolate to maintain chromaticity. Strategy:
            //   - Use the brightest **unclipped** channel as the reference.
            //   - Solve for the clipped channel(s) from the target ratios.
            //   - If no unclipped channel exists (shouldn't happen here because
            //     `clipped_count < 3`), fall through to leaving the pixel.
            let mut p_out = p_in;
            // Find the brightest unclipped channel (this is our anchor).
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
                        if target_rg.abs() > 1e-6 {
                            p_in[0] / target_rg
                        } else {
                            p_in[1]
                        }
                    }
                    1 => p_in[1], // anchor is G; G is fixed.
                    2 => {
                        // anchor is B; target_bg = B/G → G = B/target_bg
                        if target_bg.abs() > 1e-6 {
                            p_in[2] / target_bg
                        } else {
                            p_in[1]
                        }
                    }
                    _ => unreachable!(),
                };
                let r_implied = g_implied * target_rg;
                let b_implied = g_implied * target_bg;
                let implied = [r_implied, g_implied, b_implied];

                // Replace each clipped channel with the implied value. The
                // spatial "feather" the brief calls for emerges naturally from
                // the neighborhood averaging: adjacent clipped pixels see
                // overlapping windows so their reconstructed chromaticities
                // vary smoothly, and the unclipped channels (held fixed) tie
                // the result to the local color.
                //
                // We do NOT clamp `implied[c] >= p_in[c]`. Path C derives
                // `implied` from a stable anchor + local chromaticity, so
                // letting it fall below the (numerical) input is legitimate
                // when the input was magenta-shifted — the whole point is to
                // pull the chromaticity back toward neutral. The legacy
                // `Blend` magenta-pull came from anchoring to
                // `max_unclipped ≤ 1.0`, not from the direction of motion.
                for c in 0..3 {
                    if (m >> c) & 1 == 1 {
                        p_out[c] = implied[c];
                    }
                }
            }
            img.pixels[idx] = p_out;
        }
    }
}

#[cfg(test)]
#[path = "highlight_recovery/tests.rs"]
mod tests;
