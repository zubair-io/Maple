//! Colour-range refinement weight (#3270, spec §5.2): a per-pixel factor in
//! `[0, 1]` multiplied into the primary mask weight, evaluated on the pixel
//! entering the local-adjustments stage.

use crate::color::oklab::rec2020_to_oklab;
use crate::stages::hsl::circular_delta_deg;
use crate::stages::scene_tone_controls::smoothstep;
use crate::types::RangeRefinement;

/// Lightness roll-off width on each side of `[l_min, l_max]`, in Oklab L.
pub const L_EDGE: f32 = 0.05;

/// Weight in `[0, 1]` for `rgb` (scene-linear Rec.2020) under `range`.
#[inline]
pub fn weight(range: &RangeRefinement, rgb: [f32; 3]) -> f32 {
    let RangeRefinement::Color {
        hue_deg,
        hue_half_width_deg,
        chroma_min,
        l_min,
        l_max,
        feather,
    } = *range;
    let lab = rec2020_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let c = (a * a + b * b).sqrt();
    // Chroma gate: hue is meaningless near the neutral axis (same rule the
    // HSL stage's own chroma gate follows).
    let c0 = chroma_min.max(1e-6);
    let chroma_w = smoothstep(c0, 2.0 * c0, c);
    if chroma_w <= 0.0 {
        return 0.0;
    }
    let hue = b.atan2(a).to_degrees();
    // `circular_delta_deg` already returns the absolute wrapped distance.
    let d = circular_delta_deg(hue, hue_deg);
    let hue_w = band_weight(d, hue_half_width_deg.max(1e-3), feather.clamp(0.0, 1.0));
    let l_w = smoothstep(l_min, l_min + L_EDGE, l) * (1.0 - smoothstep(l_max - L_EDGE, l_max, l));
    chroma_w * hue_w * l_w
}

/// 1 inside `(1 − feather)·half_width`, a raised cosine down to 0 at
/// `half_width`. `feather` 0 = hard edge, 1 = cosine from the centre out.
/// The `half_width` boundary itself always reads 0 — checked first so a
/// zero-width roll-off (`feather == 0`, where `inner == half_width_deg`)
/// doesn't hit the inner-band branch at that exact point.
#[inline]
pub fn band_weight(delta_deg: f32, half_width_deg: f32, feather: f32) -> f32 {
    if delta_deg >= half_width_deg {
        return 0.0;
    }
    let inner = half_width_deg * (1.0 - feather);
    if delta_deg <= inner {
        return 1.0;
    }
    let t = (delta_deg - inner) / (half_width_deg - inner);
    0.5 * (1.0 + (std::f32::consts::PI * t).cos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_weight_is_one_inside_the_inner_band() {
        assert_eq!(band_weight(0.0, 25.0, 0.3), 1.0);
        assert_eq!(band_weight(17.4, 25.0, 0.3), 1.0); // inner = 17.5
    }

    #[test]
    fn band_weight_is_zero_at_and_past_the_half_width() {
        assert_eq!(band_weight(25.0, 25.0, 0.3), 0.0);
        assert_eq!(band_weight(90.0, 25.0, 0.3), 0.0);
    }

    #[test]
    fn band_weight_rolls_off_smoothly_between_inner_and_half_width() {
        // At the arithmetic midpoint of the roll-off band, the raised cosine
        // is exactly 0.5.
        let inner = 25.0 * (1.0 - 0.3); // 17.5
        let mid = (inner + 25.0) / 2.0;
        assert!((band_weight(mid, 25.0, 0.3) - 0.5).abs() < 1e-5);
    }

    #[test]
    fn band_weight_zero_feather_is_a_hard_step_at_half_width() {
        assert_eq!(band_weight(24.9, 30.0, 0.0), 1.0);
        assert_eq!(band_weight(30.0, 30.0, 0.0), 0.0);
    }

    #[test]
    fn band_weight_full_feather_ramps_from_the_centre() {
        // feather=1 => inner=0, so ANY nonzero delta is already past the
        // "inside" branch and on the cosine ramp.
        let w_small = band_weight(1.0, 30.0, 1.0);
        let w_mid = band_weight(15.0, 30.0, 1.0);
        assert!(w_small < 1.0 && w_small > w_mid);
    }
}
