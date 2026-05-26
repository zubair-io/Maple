//! AgX hue restoration + Oklab gamut compression (#435).
//!
//! Two concerns lived together in the pre-#435 AgX path:
//!   1. **Per-channel sigmoid → magenta on saturated primaries.** The
//!      Sobotka S2O3 sigmoid applied independently to R, G, B drives a
//!      channel below zero on saturated red/blue/purple (e.g. a saturated
//!      sunset), which the post-outset `clamp(0, 1)` then mangles into a
//!      flat magenta tint.
//!   2. **Hard `clamp(0, 1)` post-outset.** Even when hue restoration
//!      bounds the per-channel deltas, the outset matrix's negative
//!      off-diagonals can still push a channel slightly out of `[0, 1]`
//!      in deep saturation. Clipping loses chroma and shifts hue.
//!
//! This module implements two replacements:
//!
//! * `norm_sigmoid_ratio` — filmic-style ratio-preserving sigmoid. Take
//!   `n = max(R, G, B)` after inset, sigmoid `n` once, scale RGB by
//!   `sigmoid(n) / n`. Hue is identical to the input (it's the same
//!   chromaticity, just remapped intensity). This subsumes the
//!   `luma_coupled_toe` band-aid — deep shadows preserve their chroma
//!   through the same ratio scale.
//!
//! * `oklab_gamut_compress` — hue-preserving gamut compression. If any
//!   channel after outset is `< 0` or `> 1`, bisect the Oklab `(a, b)`
//!   chroma toward the neutral axis at the same `L` until the round-trip
//!   to Rec.2020 fits in `[0, 1]^3`. Mirrors #471 (OklabChromaReduction)
//!   but at the view-transform step rather than at highlight recovery.
//!
//! Sobotka's "rotate post-sigmoid toward per-channel sigmoid weighted by
//! chroma" is a documented future refinement (more nuanced, but harder
//! to verify and slower); the norm-based path is the simplest hue-
//! preserving form and lands the #435 acceptance criterion (no magenta).

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};

/// Cube root used to safely take a 0-or-positive value's logarithm — the
/// sigmoid path needs a strictly positive scaling input. Below this floor
/// the ratio scale would diverge; we treat it as a pure neutral and let
/// the sigmoid handle the toe.
const RATIO_FLOOR: f32 = 1e-6;

/// Apply the AgX sigmoid in a ratio-preserving way.
///
/// `sigmoid_fn(x)` is the caller-supplied 1D AgX sigmoid (log-encode +
/// LUT sample + contrast modulation, in normalised-log space). It is
/// applied to the **max channel** of `inset_rgb`; the result is scaled
/// back across R, G, B by the same ratio. This is the photographer's
/// "filmic" form: hue is invariant by construction, only intensity is
/// remapped.
///
/// Why max rather than Rec.2020 luma:
/// * `max(R, G, B)` is the channel that's at risk of clipping; sigmoidising
///   it bounds the worst case and the others ride safely under it.
/// * Luma weights skew toward green — applying the sigmoid to luma and
///   scaling RGB by it brightens green-channel-dominant pixels and
///   crushes red-dominant ones, producing visible hue shift on saturated
///   reds. Max avoids that.
///
/// For pure neutrals (R = G = B), `max = R = G = B = n` and `ratio = 1`,
/// so the output equals `sigmoid(n) * 1 = sigmoid(n)` exactly — neutral
/// grey-axis preservation is identical to the per-channel form.
#[inline]
pub fn norm_sigmoid_ratio<F: Fn(f32) -> f32>(
    inset_rgb: [f32; 3],
    sigmoid_fn: F,
) -> [f32; 3] {
    let r = inset_rgb[0];
    let g = inset_rgb[1];
    let b = inset_rgb[2];
    let n = r.max(g).max(b);
    if n <= RATIO_FLOOR {
        // Deep shadow: sigmoid the floor once, return the neutral. This
        // matches what the old `luma_coupled_toe` did, but without the
        // separate luma gate — the ratio path handles the edge naturally.
        let v = sigmoid_fn(RATIO_FLOOR);
        return [v, v, v];
    }
    let sn = sigmoid_fn(n);
    let ratio = sn / n;
    [r * ratio, g * ratio, b * ratio]
}

/// Hue-preserving gamut compression toward the `[0, 1]^3` display box.
///
/// If `rgb` already fits, returns it untouched. Otherwise, bisects
/// the Oklab `(a, b)` chroma toward 0 at constant `L` until the
/// resulting Rec.2020 triple is in-gamut (with a small numerical
/// margin). 24 iterations of bisection give `2^-24 ≈ 6e-8` precision
/// on the chroma scale, comfortably below 8-bit quantisation.
///
/// Mid-gray and other neutrals pass through unchanged (chroma is zero,
/// nothing to compress).
#[inline]
pub fn oklab_gamut_compress(rgb: [f32; 3]) -> [f32; 3] {
    if in_unit_box(rgb) {
        // Trim the tiny fp wobble at the edges so the next stage sees
        // strict `[0, 1]`.
        return [
            rgb[0].clamp(0.0, 1.0),
            rgb[1].clamp(0.0, 1.0),
            rgb[2].clamp(0.0, 1.0),
        ];
    }
    let lab = rec2020_to_oklab(rgb);
    let l = lab[0];
    let a = lab[1];
    let b = lab[2];
    // Binary search for the largest scale s in [0, 1] such that
    // oklab_to_rec2020([l, s*a, s*b]) is in-gamut. 24 iterations.
    let mut lo: f32 = 0.0;
    let mut hi: f32 = 1.0;
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        let candidate = oklab_to_rec2020([l, a * mid, b * mid]);
        if in_unit_box(candidate) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let out = oklab_to_rec2020([l, a * lo, b * lo]);
    // Tighten with the trailing clamp — Oklab round-trips can drift a
    // few ULPs past 0 or 1 even when the bisection landed inside.
    [
        out[0].clamp(0.0, 1.0),
        out[1].clamp(0.0, 1.0),
        out[2].clamp(0.0, 1.0),
    ]
}

#[inline]
fn in_unit_box(rgb: [f32; 3]) -> bool {
    // Allow a tiny epsilon at the high end so values like 1.0 + 1e-7
    // (fp error) don't trigger the expensive Oklab compression path.
    const EPS_HI: f32 = 1.0 + 1e-5;
    const EPS_LO: f32 = -1e-5;
    rgb[0] >= EPS_LO && rgb[0] <= EPS_HI
        && rgb[1] >= EPS_LO && rgb[1] <= EPS_HI
        && rgb[2] >= EPS_LO && rgb[2] <= EPS_HI
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(x: f32) -> f32 { x }

    #[test]
    fn ratio_preserves_neutral_axis() {
        // Neutral input → neutral output under any sigmoid.
        for v in [0.001f32, 0.05, 0.18, 0.5, 1.0] {
            let out = norm_sigmoid_ratio([v, v, v], |x| x.sqrt());
            assert!(
                (out[0] - out[1]).abs() < 1e-6 && (out[1] - out[2]).abs() < 1e-6,
                "neutral {} → non-neutral {:?}",
                v, out
            );
        }
    }

    #[test]
    fn ratio_preserves_hue_for_saturated_red() {
        // Saturated red: R = 5.0, G = B = 0.05. Per-channel sigmoid would
        // drive the inset-projected channels asymmetrically; norm path
        // keeps the R:G:B ratio constant.
        let inset = [5.0f32, 0.05, 0.05];
        // Use sqrt as a stand-in monotone sigmoid.
        let out = norm_sigmoid_ratio(inset, |x| x.sqrt());
        let in_rg_ratio = inset[1] / inset[0];
        let out_rg_ratio = out[1] / out[0];
        assert!(
            (in_rg_ratio - out_rg_ratio).abs() < 1e-5,
            "hue drift: in R:G = {}, out R:G = {}", in_rg_ratio, out_rg_ratio
        );
        let in_rb_ratio = inset[2] / inset[0];
        let out_rb_ratio = out[2] / out[0];
        assert!(
            (in_rb_ratio - out_rb_ratio).abs() < 1e-5,
            "hue drift: in R:B = {}, out R:B = {}", in_rb_ratio, out_rb_ratio
        );
    }

    #[test]
    fn ratio_below_floor_collapses_to_neutral() {
        // Truly black pixel: nothing to scale by, output is a neutral.
        let out = norm_sigmoid_ratio([0.0, 0.0, 0.0], identity);
        assert_eq!(out[0], out[1]);
        assert_eq!(out[1], out[2]);
        // And finite.
        assert!(out[0].is_finite());
    }

    #[test]
    fn gamut_compress_passes_through_in_gamut() {
        // Mid-gray, no compression.
        let p = [0.18, 0.18, 0.18];
        let out = oklab_gamut_compress(p);
        for i in 0..3 {
            assert!((out[i] - p[i]).abs() < 1e-5, "drift {}: {} → {}", i, p[i], out[i]);
        }
    }

    #[test]
    fn gamut_compress_lands_in_unit_box() {
        // Out-of-gamut saturated red — bisection should bring it into
        // [0, 1]^3.
        let p = [1.4, 0.1, -0.05];
        let out = oklab_gamut_compress(p);
        for i in 0..3 {
            assert!(
                out[i] >= 0.0 && out[i] <= 1.0,
                "channel {} out of gamut: {}", i, out[i]
            );
        }
    }

    #[test]
    fn gamut_compress_preserves_hue_direction() {
        // Saturated red goes in, output should still be red-dominant
        // (R > G, R > B) — the hue is preserved, only chroma compressed.
        let p = [1.4, 0.05, 0.05];
        let out = oklab_gamut_compress(p);
        assert!(
            out[0] > out[1] && out[0] > out[2],
            "hue lost — R should still dominate: {:?}", out
        );
    }
}
