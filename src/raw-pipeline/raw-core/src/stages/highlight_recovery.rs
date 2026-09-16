//! Sensor-highlight chromaticity reconstruction (#3633).
//!
//! Runs in post-as-shot-WB camera RGB before lens gain, warp or reduction.
//! Sensor ceilings include BaselineExposure and AsShotNeutral. Fully known
//! pixels and every known channel of a partially clipped pixel stay unchanged.
//!
//! For each partial clip, normalize each fully known 7×7 witness by the mean
//! of the target's surviving channels, using the SAME channel mask throughout.
//! Reject negative or non-finite witnesses without changing their pixels.
//! Average the missing-channel ratios, blend with neutral at the existing
//! count/49 confidence (<4 witnesses means zero confidence), and multiply by
//! the target's known-channel mean. This treats channel permutations equally
//! and avoids both a preferred green denominator and ratios of averaged ratios.
//! Fully clipped pixels retain the existing neutral saturation-white fallback.
//!
//! This is a local chromaticity estimate, not recovery of unknowable scene
//! detail: an unrelated edge in either known channel can affect the estimate.
//! Nonpositive or numerically unusable known energy provides no estimate; leave
//! that target untouched. No stage output is clamped to display range.
//!
//! A frozen clipping mask excludes every modified pixel from witness reads.
//! Thus reconstruction needs no full RGB snapshot: known witnesses never change
//! and each clipped target reads its original value before its sole write.
//! The neighborhood scan runs only on clipped pixels; a scene without clips
//! returns before allocating the mask.

use crate::{
    image::{ColorSpace, Image},
    xmp::HighlightRecoveryMode,
};

/// Per-channel clip margin in post-WB camera RGB at zero BaselineExposure.
/// Scale it with the pixels and ceilings when baseline exposure is applied.
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
    let gain = baseline_gain(baseline_exposure);
    [
        1.0 / neutral[0].abs().max(1e-6),
        1.0 / neutral[1].abs().max(1e-6),
        1.0 / neutral[2].abs().max(1e-6),
    ]
    .map(|ceiling| ceiling * gain)
}

fn baseline_gain(baseline_exposure: f32) -> f32 {
    // Match the baseline-exposure stage's negligible-gain fast path in
    // full, sized, tile and panorama develop, including its exact boundary.
    if baseline_exposure.abs() > 1e-4 {
        baseline_exposure.exp2()
    } else {
        1.0
    }
}

/// Path C — chromatic-adaptation highlight reconstruction. See module comment.
fn apply_chromatic_adaptation(img: &mut Image, neutral: [f32; 3], baseline_exposure: f32) {
    let w = img.width as i32;
    let h = img.height as i32;
    if w == 0 || h == 0 {
        return;
    }
    let ceil = ceilings(neutral, baseline_exposure);
    let gain = baseline_gain(baseline_exposure);
    let margin = EPSILON * gain;
    let denominator_floor = 1e-4 * gain;
    let thresholds = ceil.map(|ceiling| ceiling - margin);

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
    // Pixels with any channel ≥ its per-channel ceiling minus the margin count as
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

    // Keep this mask frozen: even a reconstructed value below threshold must
    // remain excluded. Every accepted witness is therefore still original.

    // Pass 2: reconstruct each clipped pixel.
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

            let known_count = (3 - clipped_count) as f32;
            let known_mean = |p: [f32; 3]| {
                (0..3)
                    .filter(|c| (m >> c) & 1 == 0)
                    .map(|c| p[c])
                    .sum::<f32>()
                    / known_count
            };
            let known_level = known_mean(p_in);
            if known_level <= denominator_floor {
                continue;
            }
            let mut sum_ratio = [0.0f32; 3];
            let mut count = 0u32;
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
                        continue;
                    }
                    let np = img.pixels[n_idx];
                    // Negative demosaic undershoot is valid scene data, but
                    // cannot be evidence for extrapolating positive saturation.
                    // Reject the witness; never clamp or modify its channels.
                    if np.iter().any(|v| !v.is_finite() || *v < 0.0) {
                        continue;
                    }
                    let witness_level = known_mean(np);
                    if witness_level > denominator_floor {
                        for c in 0..3 {
                            if (m >> c) & 1 == 1 {
                                sum_ratio[c] += np[c] / witness_level;
                            }
                        }
                        count += 1;
                    }
                }
            }
            let confidence = if count < 4 {
                0.0
            } else {
                count as f32 / NEIGHBOR_WINDOW_AREA
            };
            let mut p_out = p_in;
            for c in 0..3 {
                if (m >> c) & 1 == 1 {
                    let ratio = if count > 0 {
                        sum_ratio[c] / count as f32
                    } else {
                        1.0
                    };
                    p_out[c] = known_level * (1.0 + confidence * (ratio - 1.0));
                }
            }
            img.pixels[idx] = p_out;
        }
    }
}

#[cfg(test)]
#[path = "highlight_recovery/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "highlight_recovery/tests_mask_aware.rs"]
mod tests_mask_aware;
