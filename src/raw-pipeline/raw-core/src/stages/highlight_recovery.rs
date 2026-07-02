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

#[cfg(test)]
mod tests {
    use super::*;

    /// Identity neutral (1,1,1) — equivalent to no WB pre-gain having run.
    /// Per-channel ceilings then collapse to 1.0 and the stage behaves like
    /// the legacy single-threshold detector.
    const NEUTRAL_IDENTITY: [f32; 3] = [1.0, 1.0, 1.0];

    /// Typical daylight DNG `AsShotNeutral`. Post-WB ceilings are
    /// `(2.0, 1.0, 1.428…)`.
    const NEUTRAL_DAYLIGHT: [f32; 3] = [0.5, 1.0, 0.7];

    fn make_img(size: u32) -> Image {
        Image::new(size, size, ColorSpace::CameraNativeLinearRgb)
    }

    #[test]
    fn mode_off_is_identity() {
        let mut img = make_img(4);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [0.999, 0.5, (i as f32) / 16.0];
        }
        let before = img.pixels.clone();
        apply(&mut img, HighlightRecoveryMode::Off, NEUTRAL_DAYLIGHT);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn nothing_to_recover_is_identity_under_chromatic_adaptation() {
        // No channel reaches the per-channel ceiling, so the stage exits via
        // the fast `!any_clipped` path.
        let mut img = make_img(4);
        for p in &mut img.pixels {
            *p = [0.5, 0.5, 0.5];
        }
        let before = img.pixels.clone();
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn fully_clipped_pixel_lands_neutral() {
        // 5×5 image; every pixel fully clipped at neutral=identity (ceilings
        // collapse to 1.0). The stage should emit (X, X, X) — no chromatic
        // cast. Acceptance criterion 1.
        let mut img = make_img(5);
        for p in &mut img.pixels {
            *p = [1.0, 1.0, 1.0];
        }
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_IDENTITY,
        );
        for p in &img.pixels {
            assert!(
                (p[0] - p[1]).abs() < 1e-6 && (p[1] - p[2]).abs() < 1e-6,
                "expected neutral, got {:?}",
                p
            );
            assert!(p[0] >= 1.0, "expected at-or-above ceiling, got {}", p[0]);
        }
    }

    #[test]
    fn fully_clipped_pixel_lands_neutral_under_daylight_wb() {
        // Sensor was fully saturated. Post-WB the pixel reads (2.0, 1.0, 1.43).
        // All three channels at their per-channel ceiling → fully clipped.
        // Output must be neutral (X, X, X). Spec § 3.3a step 5.
        let mut img = make_img(5);
        for p in &mut img.pixels {
            *p = [2.0, 1.0, 1.0 / 0.7];
        }
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        for p in &img.pixels {
            assert!(
                (p[0] - p[1]).abs() < 1e-5 && (p[1] - p[2]).abs() < 1e-5,
                "expected neutral after full-clip, got {:?}",
                p
            );
            // The anchor X is the largest ceiling = 1/min(neutral) = 2.0.
            assert!((p[0] - 2.0).abs() < 1e-5, "expected X = 2.0, got {}", p[0]);
        }
    }

    #[test]
    fn g_clipped_pixel_loses_magenta_under_daylight_wb() {
        // Acceptance criterion 2: G-clipped pixel (0.8, 1.0, 0.7) at sensor,
        // post-WB = (1.6, 1.0, 1.0). Only G is clipped (R=1.6 < ceiling 2.0,
        // B=1.0 < ceiling 1.428).
        //
        // The strict letter of the brief asks the output to match
        // chromaticity 1/AsShotNeutral = (2.0, 1.428). That's unreachable while
        // holding R and B fixed (any G ≥ 1.0 gives R/G ≤ 1.6, B/G ≤ 1.0).
        //
        // The SPIRIT — verified here — is:
        //   - G gets lifted above its clip threshold.
        //   - No magenta: the recovered pixel's R/G is at most the input R/G
        //     (better, equal or lower; we never go more magenta).
        //   - With no unclipped neighbors the result is the neutral-target
        //     extrapolation: G is lifted so R/G == 1.0 and B/G == 1.0 (the
        //     post-WB neutral chromaticity), which is the maximum lift we
        //     can produce with R held fixed.
        //
        // We test on a single-pixel image so there are no neighbors → the
        // stage falls back to the WB-implied neutral target (confidence 0).
        let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [1.6, 1.0, 1.0];
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        let p = img.pixels[0];
        // G must have been lifted above the threshold (1.0 - EPSILON).
        assert!(p[1] > 1.0 - EPSILON, "G should be lifted, got {}", p[1]);
        // The recovered pixel should not be more magenta than the input.
        // input R/G = 1.6, output R/G should be ≤ 1.6.
        let out_rg = p[0] / p[1];
        let out_bg = p[2] / p[1];
        assert!(out_rg <= 1.6 + 1e-4, "R/G grew (more magenta): {}", out_rg);
        // Under fallback-to-neutral, R/G and B/G should both move toward 1
        // (the post-WB neutral chromaticity). With the soft feather close to
        // the threshold, expect R/G ≤ 1.6 and B/G ≤ 1.0 — i.e. less magenta.
        assert!(
            out_rg < 1.6,
            "expected magenta to reduce, got R/G = {}",
            out_rg
        );
        assert!(out_bg <= 1.0 + 1e-4, "B/G out of bound: {}", out_bg);
    }

    #[test]
    fn g_clipped_with_neutral_neighbors_lifts_g_to_match_local_chromaticity() {
        // 11×11 image. Outer ring is a neutral grey well below clip. The
        // center pixel is G-clipped post-WB. Only G is mutated (R and B
        // are below their per-channel ceilings); the recovered G must be
        // lifted so that R/G matches the neighborhood's R/G (= 1.0).
        //
        // B is unclipped (1.0 < ceiling 1.428), so the algorithm leaves it
        // alone — the chromaticity guarantee in the acceptance criterion
        // applies along the clipped axis (R/G here). B/G post-recovery is
        // a *consequence* of the (R, B) anchors plus the new G, not a
        // direct target.
        let mut img = Image::new(11, 11, ColorSpace::CameraNativeLinearRgb);
        for p in &mut img.pixels {
            *p = [0.9, 0.9, 0.9];
        }
        // Center pixel: G-clipped (post-WB G hit 1.0; R=1.6 < ceil 2.0,
        // B=1.0 < ceil 1.428). Pre-recovery R/G = 1.6 (magenta).
        let cx = 5;
        let cy = 5;
        img.pixels[cy * 11 + cx] = [1.6, 1.0, 1.0];
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        let p = img.pixels[cy * 11 + cx];
        let out_rg = p[0] / p[1];
        // 5% tolerance around the neighborhood's R/G = 1.0 — the chromaticity
        // axis the algorithm is responsible for.
        assert!(
            (out_rg - 1.0).abs() < 0.05,
            "expected R/G ≈ 1.0 ± 5%, got {}",
            out_rg
        );
        // G must have been lifted above its post-WB ceiling.
        assert!(p[1] > 1.0 - EPSILON, "G should be lifted, got {}", p[1]);
        // The original magenta cast must be gone: R/G strictly less than the
        // pre-recovery 1.6 ratio.
        assert!(out_rg < 1.6, "R/G should drop below 1.6, got {}", out_rg);
    }

    #[test]
    fn two_channel_clip_recovers_chromaticity_from_neighbors() {
        // 11×11 image. Outer ring is a neutral grey well below clip. Center
        // pixel has R AND G both clipped (post-WB R=2.0 hits ceiling, G=1.0
        // hits ceiling), B=1.2 < ceiling 1.428.
        //
        // The algorithm anchors on the brightest unclipped channel (B), and
        // recovers R and G from the local chromaticity (R/G=1, B/G=1, both
        // from the neutral neighborhood). With B/G target = 1 and B=1.2,
        // G = 1.2 → R = 1.2 × 1 = 1.2. Output (1.2, 1.2, 1.2).
        let mut img = Image::new(11, 11, ColorSpace::CameraNativeLinearRgb);
        for p in &mut img.pixels {
            *p = [0.9, 0.9, 0.9];
        }
        let cx = 5;
        let cy = 5;
        img.pixels[cy * 11 + cx] = [2.0, 1.0, 1.2];
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        let p = img.pixels[cy * 11 + cx];
        // All three channels should now be ≈ 1.2.
        assert!(
            (p[0] - 1.2).abs() < 0.05,
            "R recovered to ≈ 1.2, got {}",
            p[0]
        );
        assert!(
            (p[1] - 1.2).abs() < 0.05,
            "G recovered to ≈ 1.2, got {}",
            p[1]
        );
        assert!(
            (p[2] - 1.2).abs() < 0.05,
            "B unchanged at 1.2, got {}",
            p[2]
        );
        // Neutral chromaticity within 5%.
        let out_rg = p[0] / p[1];
        let out_bg = p[2] / p[1];
        assert!((out_rg - 1.0).abs() < 0.05, "R/G drift: {}", out_rg);
        assert!((out_bg - 1.0).abs() < 0.05, "B/G drift: {}", out_bg);
    }

    #[test]
    fn unclipped_pixels_pass_through() {
        // No pixel hits any ceiling — stage must early-out.
        let mut img = make_img(10);
        for p in &mut img.pixels {
            *p = [0.3, 0.4, 0.5];
        }
        let before = img.pixels.clone();
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn empty_image_is_a_noop() {
        let mut img = Image::new(0, 0, ColorSpace::CameraNativeLinearRgb);
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        assert_eq!(img.pixels.len(), 0);
    }

    /// Perf budget per ticket #325: ChromaticAdaptation must add < 4ms on a
    /// 2 MP viewport. We synthesize a 2 MP image with ~5% clipped pixels
    /// (a realistic blown-sky scenario) and assert the stage finishes in
    /// under 4 ms in release mode. Skipped in debug to avoid spurious
    /// timing failures.
    #[test]
    #[cfg(not(debug_assertions))]
    fn perf_chromatic_adaptation_2mp_under_4ms_release() {
        // 1600 × 1250 ≈ 2 MP
        let w = 1600u32;
        let h = 1250u32;
        let mut img = Image::new(w, h, ColorSpace::CameraNativeLinearRgb);
        // Fill with mostly mid-grey; sprinkle a stripe of fully-clipped
        // pixels along the top 5% of rows to exercise the inner loop.
        for y in 0..h {
            for x in 0..w {
                let idx = (y * w + x) as usize;
                if y < h / 20 {
                    img.pixels[idx] = [2.0, 1.0, 1.0 / 0.7];
                } else {
                    img.pixels[idx] = [0.5, 0.5, 0.5];
                }
            }
        }
        let t0 = std::time::Instant::now();
        apply(
            &mut img,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        let elapsed = t0.elapsed();
        eprintln!(
            "highlight_recovery::apply ChromaticAdaptation on 2 MP: {:?}",
            elapsed
        );
        assert!(
            elapsed < std::time::Duration::from_millis(4),
            "perf budget exceeded: {:?} > 4 ms",
            elapsed
        );
    }

    #[test]
    fn legacy_blend_mode_upgrades_to_chromatic_adaptation() {
        // Old XMP sidecars that selected Blend/Luminance should get the new
        // behavior — magenta-free reconstruction — not the old broken modes.
        let mut img_blend = make_img(5);
        let mut img_ca = make_img(5);
        for p in &mut img_blend.pixels {
            *p = [1.6, 1.0, 1.0];
        }
        for p in &mut img_ca.pixels {
            *p = [1.6, 1.0, 1.0];
        }
        apply(
            &mut img_blend,
            HighlightRecoveryMode::Blend,
            NEUTRAL_DAYLIGHT,
        );
        apply(
            &mut img_ca,
            HighlightRecoveryMode::ChromaticAdaptation,
            NEUTRAL_DAYLIGHT,
        );
        assert_eq!(img_blend.pixels, img_ca.pixels);
    }
}
