//! Post-DCP highlight recovery via Oklab chroma reduction (ticket #471).
//!
//! Sibling to `stages::highlight_recovery`. Lives in its own file to keep the
//! 600-line-per-file budget on the camera-native variant intact.
//!
//! ### Why post-DCP?
//!
//! Oklab is defined against linear sRGB D65 (and by composition, linear
//! Rec.2020 D65 — see `color::oklab`). The camera-native space the existing
//! `ChromaticAdaptation` variant runs in is NOT colorimetrically
//! well-defined; routing through Oklab there would produce wrong hue
//! coordinates. So this variant runs AFTER `dcp::apply_colorimetry` on the
//! scene-linear Rec.2020 D65 buffer.
//!
//! ### Algorithm
//!
//! For each pixel that is **post-DCP sensor-clipped** — i.e. at least one
//! Rec.2020 channel exceeds `1.0` (the post-white-balance, post-DCP sensor
//! saturation point):
//!
//! 1. Convert RGB → Oklab.
//! 2. Binary-search a scale factor `k ∈ [0, 1]` such that scaling `(a, b)` by
//!    `k` produces an RGB whose max channel is ≤ 1.0 + EPSILON.
//! 3. Convert the scaled Oklab back to RGB.
//!
//! Scaling `a` and `b` by the same factor preserves `atan2(b, a)` — the
//! Oklab hue angle — exactly for any `k > 0`. That's the hue-preservation
//! guarantee in the ticket. Lightness `L` is left untouched, so the pixel
//! stays as bright as the input; only its chromatic excursion shrinks.
//!
//! ### "Sensor-clipped" vs "out of gamut" — important nuance
//!
//! The `>1.0` predicate here is **not** an "out-of-gamut" check. The working
//! space (`ColorSpace::SceneLinearRec2020`) is intentionally unbounded
//! scene-linear Rec.2020 D65 — values above `1.0` are legitimate scene
//! headroom (specular highlights, HDR content) that downstream stages
//! (AgX view transform) compress into display range. Genuine
//! "out-of-gamut" checks in this codebase test for *negative* Rec.2020
//! channels (see `stages::saturation::GAMUT_EPS` and the
//! `min(channel) >= -GAMUT_EPS` predicate there).
//!
//! Instead, `1.0` here represents **post-WB / post-DCP sensor saturation**:
//! the level at which the raw sensor lost information at capture time.
//! Pixels above `1.0` after the DCP stage are the targets of highlight
//! recovery — they're the ones with broken hue/luminance relationships
//! because one or more channels clipped at the sensor. The variant's job is
//! to pull chroma in just enough to put those channels back below the
//! sensor-clip line while preserving the perceptual hue we recovered from
//! the un-clipped channels.
//!
//! ### Pipeline placement
//!
//! Invoked from `pipeline::develop`, `pipeline::develop_sized`, and
//! `pipeline::tile::develop` immediately after `dcp::apply_colorimetry`. The
//! function is an early-return no-op unless
//! `model.highlight_recovery == OklabChromaReduction`, so the default
//! pipeline (CA) is byte-identical to pre-#471.

use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
    xmp::HighlightRecoveryMode,
};

/// Numerical slack above the `1.0` post-DCP sensor-saturation line that we
/// still treat as "below the sensor clip" — accounts for f32 round-trip
/// noise on the Oklab matrix chain. Matches the `EPSILON` in the sibling
/// camera-native variant for consistency. NOT a gamut tolerance — the
/// working space is unbounded scene-linear Rec.2020 (see module docs).
const CEILING_EPSILON: f32 = 0.005;

/// Predicate: returns `true` when any Rec.2020 channel exceeds the post-DCP
/// sensor-clip line (`1.0 + CEILING_EPSILON`). This is **NOT** a gamut
/// check — values `> 1.0` are legitimate scene headroom in the unbounded
/// scene-linear Rec.2020 D65 working space. Genuine out-of-gamut checks
/// test for negative channels (see `stages::saturation`). `1.0`
/// represents the post-WB / post-DCP sensor saturation point: pixels above
/// it lost information at the sensor and are the targets of highlight
/// recovery.
#[inline]
fn is_post_dcp_sensor_clipped(rgb: [f32; 3]) -> bool {
    rgb[0].max(rgb[1]).max(rgb[2]) > 1.0 + CEILING_EPSILON
}

/// Number of binary-search iterations. 15 halvings → resolution `~3e-5` on
/// the `[0, 1]` scale factor, comfortably below the f32 round-trip noise on
/// the Oklab matrix chain.
const BISECTION_ITERS: u32 = 15;

/// Post-DCP highlight recovery. Asserts scene-linear Rec.2020 D65; early
/// returns unless the user opted into `OklabChromaReduction`. Identity for
/// every other variant.
pub fn apply_post_dcp(img: &mut Image, mode: HighlightRecoveryMode) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if !matches!(mode, HighlightRecoveryMode::OklabChromaReduction) {
        return;
    }
    apply_oklab_chroma_reduction(img);
}

fn apply_oklab_chroma_reduction(img: &mut Image) {
    for p in img.pixels.iter_mut() {
        if !is_post_dcp_sensor_clipped(*p) {
            continue;
        }
        let lab = rec2020_to_oklab(*p);
        // Binary search the largest `k` in [0, 1] such that scaling (a, b)
        // by k brings max channel back below the post-DCP sensor-clip line
        // (`1.0 + CEILING_EPSILON`). `hi = 1.0` is the identity (no
        // change); `lo = 0.0` is the fully achromatic projection at this
        // lightness — always below the sensor-clip line because a neutral
        // grey at any lightness has equal channels.
        let mut lo = 0.0f32;
        let mut hi = 1.0f32;
        for _ in 0..BISECTION_ITERS {
            let mid = 0.5 * (lo + hi);
            let scaled = [lab[0], lab[1] * mid, lab[2] * mid];
            let rgb = oklab_to_rec2020(scaled);
            if !is_post_dcp_sensor_clipped(rgb) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Use `lo` — the largest verified-below-sensor-clip scale. If even
        // k=0 didn't fit (very bright pixel), lo stays 0 and the output is
        // the achromatic projection at this lightness — that's the right
        // "fully clipped" fallback.
        let scaled = [lab[0], lab[1] * lo, lab[2] * lo];
        *p = oklab_to_rec2020(scaled);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test fixture: a single-pixel scene-linear Rec.2020 image with the given
    /// RGB values.
    fn one_pixel(rgb: [f32; 3]) -> Image {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = rgb;
        img
    }

    /// Hue angle in Oklab — `atan2(b, a)` in radians, wrapped into
    /// `(-pi, pi]`. Used only by tests.
    fn oklab_hue(rgb: [f32; 3]) -> f32 {
        let lab = rec2020_to_oklab(rgb);
        lab[2].atan2(lab[1])
    }

    /// Wrap a hue delta into `(-pi, pi]` for "minimum angular distance"
    /// comparisons across the +/-pi seam.
    fn hue_delta(a: f32, b: f32) -> f32 {
        let mut d = a - b;
        while d > std::f32::consts::PI {
            d -= 2.0 * std::f32::consts::PI;
        }
        while d <= -std::f32::consts::PI {
            d += 2.0 * std::f32::consts::PI;
        }
        d.abs()
    }

    #[test]
    fn opt_out_modes_are_no_ops_post_dcp() {
        // Every mode that's NOT OklabChromaReduction must leave the buffer
        // untouched at the post-DCP call site, even with clipped pixels.
        for mode in [
            HighlightRecoveryMode::Off,
            HighlightRecoveryMode::Blend,
            HighlightRecoveryMode::Luminance,
            HighlightRecoveryMode::ChromaticAdaptation,
        ] {
            let mut img = one_pixel([1.8, 0.4, 0.4]);
            let before = img.pixels.clone();
            apply_post_dcp(&mut img, mode);
            assert_eq!(img.pixels, before, "mode {:?} mutated post-DCP", mode);
        }
    }

    #[test]
    fn unclipped_pixel_passes_through() {
        // No channel exceeds 1.0 → identity even with OklabChromaReduction.
        let mut img = one_pixel([0.4, 0.5, 0.6]);
        let before = img.pixels.clone();
        apply_post_dcp(&mut img, HighlightRecoveryMode::OklabChromaReduction);
        // f32 strict equality — the early-out path must NOT touch the
        // pixel (no Oklab round-trip).
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn clipped_red_is_brought_into_gamut_and_hue_preserved() {
        // Saturated red, R well over the post-DCP sensor-clip line (1.0),
        // others in range. After recovery every channel must be below
        // `1 + EPSILON` and the Oklab hue angle must be preserved within
        // 2 degrees (test 5 / ticket). Note: "into gamut" in the test
        // name is colloquial for "below the sensor-clip line"; the working
        // space is unbounded scene-linear Rec.2020 (see module docs).
        let input = [1.8, 0.2, 0.15];
        let hue_in = oklab_hue(input);
        let mut img = one_pixel(input);
        apply_post_dcp(&mut img, HighlightRecoveryMode::OklabChromaReduction);
        let out = img.pixels[0];
        let max_c = out[0].max(out[1]).max(out[2]);
        assert!(
            max_c <= 1.0 + 2.0 * CEILING_EPSILON,
            "expected max channel below sensor-clip line, got {} on {:?}",
            max_c,
            out
        );
        let hue_out = oklab_hue(out);
        let two_deg = 2.0 * std::f32::consts::PI / 180.0;
        assert!(
            hue_delta(hue_in, hue_out) < two_deg,
            "hue drifted: in {:?} ({}rad) → out {:?} ({}rad), delta {}",
            input,
            hue_in,
            out,
            hue_out,
            hue_delta(hue_in, hue_out)
        );
    }

    /// #1733 clamp audit: unlike `saturation.rs` / `vibrance.rs` / (post-fix)
    /// `hsl.rs`, this stage's chroma-reduction bisection lands EXACTLY on the
    /// sensor-clip boundary predicate with no Reinhard soft-knee taper — the
    /// same shape as the pre-#1621 hard clip-to-hull. Audit verdict (see
    /// module doc "Sensor-clipped vs out of gamut"): **keep as-is, no fix**.
    /// Reasoning:
    ///   1. The predicate only fires on pixels that are ALREADY
    ///      information-destroyed at the sensor (`max_channel > 1.0` post-
    ///      WB/DCP is a real physical clip, not a display-range choice) —
    ///      there is no "true" continuous signal on the other side of the
    ///      boundary to preserve smoothness of; every pixel at or above the
    ///      clip line already lost its relative-channel information at
    ///      capture time.
    ///   2. This second-difference probe (same second-difference-spike
    ///      instrument as `src/scripts/banding_check.py` / #1627, applied
    ///      directly on the Rust side to a fine ramp straddling the clip
    ///      line) confirms the elbow's second-difference is bounded and small
    ///      relative to the pixel's own chroma scale — nothing like the
    ///      #1621 defect's near-total plateau collapse. See the numbers
    ///      printed by `--nocapture` for the actual ratio.
    ///   3. #1621's fix target was the display-range gamut compressor, which
    ///      runs on EVERY pixel unconditionally; this stage only engages on
    ///      already-clipped pixels and its downstream consumer (AgX) still
    ///      applies its own soft gamut compression — so any residual step
    ///      here is smoothed again before it reaches the display.
    #[test]
    fn sensor_clip_bisection_has_no_pre_1621_style_plateau() {
        // Ramp brightness across the sensor-clip line at a fixed saturated
        // hue (red channel scales, G/B fixed) — the shape that would surface
        // a hard-clip plateau if one existed.
        const N: usize = 400;
        const R_MAX: f32 = 3.0; // well past the 1.0 sensor-clip line
        let mut chroma_out = Vec::with_capacity(N);
        for i in 0..N {
            let r = R_MAX * (i as f32) / ((N - 1) as f32);
            let mut img = one_pixel([r, 0.2, 0.15]);
            apply_post_dcp(&mut img, HighlightRecoveryMode::OklabChromaReduction);
            let lab = rec2020_to_oklab(img.pixels[0]);
            chroma_out.push((lab[1] * lab[1] + lab[2] * lab[2]).sqrt());
        }
        // Second difference along the ramp.
        let d1: Vec<f32> = chroma_out.windows(2).map(|w| w[1] - w[0]).collect();
        let d2: Vec<f32> = d1.windows(2).map(|w| w[1] - w[0]).collect();
        let max_abs_d2 = d2.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        let max_abs_d1 = d1.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        let spike_ratio = max_abs_d2 / max_abs_d1.max(1e-9);
        eprintln!(
            "sensor_clip_bisection_has_no_pre_1621_style_plateau: \
             max_abs_d2={max_abs_d2:.6} max_abs_d1={max_abs_d1:.6} spike_ratio={spike_ratio:.4}"
        );
        // #1627's gate observed clean post-#1621 spike ratios in the 0.02-1.06
        // range and a hard-clip regression at ~1.0-with-huge-raw-magnitude;
        // this bisection-to-boundary shape is expected to sit at the higher
        // end of "healthy" (there IS a real slope change at the boundary
        // where the stage switches from no-op to engaged) but must not blow
        // past a hard-clip's signature. 3.0 is a generous ceiling — well
        // under a plateau's ~identical-output-for-100-steps collapse, which
        // would drive this ratio over 100 (see #1621's RED-run repro:
        // 140 identical u8 steps out of 140).
        assert!(
            spike_ratio < 3.0,
            "spike ratio {spike_ratio} suggests a hard-clip-style elbow, not a smooth boundary"
        );
    }

    #[test]
    fn chromatic_adaptation_default_does_not_touch_post_dcp_buffer() {
        // Sanity: the default mode (CA) is a no-op at the post-DCP call
        // site — the comparison anchor for the ticket's "vs CA" reference
        // difference. The CA work happens pre-DCP via `apply()` in the
        // sibling module; the post-DCP hook is OklabChromaReduction-only.
        let input = [1.8, 0.2, 0.15];
        let mut img_ca = one_pixel(input);
        let mut img_oklab = one_pixel(input);
        apply_post_dcp(&mut img_ca, HighlightRecoveryMode::ChromaticAdaptation);
        apply_post_dcp(&mut img_oklab, HighlightRecoveryMode::OklabChromaReduction);
        // CA path is identity here; OklabChromaReduction must have moved
        // the pixel (otherwise the variant is broken). The two must NOT
        // be byte-equal — that's the documented difference.
        assert_eq!(img_ca.pixels[0], input, "CA leaked into post-DCP buffer");
        assert!(
            img_oklab.pixels[0] != input,
            "OklabChromaReduction failed to move clipped pixel: {:?}",
            img_oklab.pixels[0]
        );
        assert!(
            img_oklab.pixels[0] != img_ca.pixels[0],
            "OklabChromaReduction matched CA exactly — unexpected"
        );
    }
}
