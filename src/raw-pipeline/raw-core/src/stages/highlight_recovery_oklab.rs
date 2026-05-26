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
//! For each pixel where any channel exceeds 1.0 (the Rec.2020 display
//! reference white in scene-linear space):
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

/// Margin above 1.0 we accept as "in gamut". Matches the `EPSILON` in the
/// sibling camera-native variant for consistency.
const CEILING_EPSILON: f32 = 0.005;

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
        let max_in = p[0].max(p[1]).max(p[2]);
        if max_in <= 1.0 + CEILING_EPSILON {
            continue;
        }
        let lab = rec2020_to_oklab(*p);
        // Binary search the largest `k` in [0, 1] such that scaling (a, b)
        // by k brings max channel ≤ 1.0 + EPSILON. `hi = 1.0` is the
        // identity (no change); `lo = 0.0` is the fully achromatic
        // projection at this lightness.
        let mut lo = 0.0f32;
        let mut hi = 1.0f32;
        for _ in 0..BISECTION_ITERS {
            let mid = 0.5 * (lo + hi);
            let scaled = [lab[0], lab[1] * mid, lab[2] * mid];
            let rgb = oklab_to_rec2020(scaled);
            let max_c = rgb[0].max(rgb[1]).max(rgb[2]);
            if max_c <= 1.0 + CEILING_EPSILON {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Use `lo` — the largest verified-in-gamut scale. If even k=0
        // didn't fit (very bright pixel), lo stays 0 and the output is the
        // achromatic projection at this lightness — that's the right
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
        // Saturated red, R well over 1.0, others in range. After recovery
        // every channel must be ≤ 1 + EPSILON and the Oklab hue angle must
        // be preserved within 2 degrees (test 5 / ticket).
        let input = [1.8, 0.2, 0.15];
        let hue_in = oklab_hue(input);
        let mut img = one_pixel(input);
        apply_post_dcp(&mut img, HighlightRecoveryMode::OklabChromaReduction);
        let out = img.pixels[0];
        let max_c = out[0].max(out[1]).max(out[2]);
        assert!(
            max_c <= 1.0 + 2.0 * CEILING_EPSILON,
            "expected in-gamut, got max channel = {} on {:?}",
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
