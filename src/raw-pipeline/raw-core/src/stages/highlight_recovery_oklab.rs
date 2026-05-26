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
