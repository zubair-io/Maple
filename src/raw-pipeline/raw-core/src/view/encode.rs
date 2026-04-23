use crate::{
    color::matrices::M_REC2020_TO_SRGB,
    image::{ColorSpace, Image},
};

/// Rec.2020 → sRGB linear via compile-time 3×3.
pub fn rec2020_to_srgb(img: &mut Image) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    for p in &mut img.pixels {
        *p = M_REC2020_TO_SRGB.mul_vec(*p);
    }
    img.space = ColorSpace::DisplayLinearSrgb;
}

/// Piecewise sRGB gamma encode. Per IEC 61966-2-1.
pub fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

// ── Display-space Levels (spec § 3.6 step 6-7 minimal "look" layer) ──────
// Applied in sRGB-gamma-encoded space to produce the Adobe-compatible look
// users expect. Calibrated empirically against ACR baseline renders via
// a Photoshop Levels adjustment (black=66, white=227, gamma=0.65 on u8).
// The same operation in [0, 1] float space uses these constants:
const LEVELS_BLACK: f32 = 66.0 / 255.0;   // 0.2588
const LEVELS_WHITE: f32 = 227.0 / 255.0;  // 0.8902
const LEVELS_GAMMA: f32 = 0.65;           // < 1 → darken midtones
const LEVELS_EXP:   f32 = 1.0 / LEVELS_GAMMA; // 1.538 — applied as x^EXP

/// Photoshop-style Levels on a gamma-encoded sRGB value in [0, 1]:
///   normalize by (LEVELS_BLACK, LEVELS_WHITE), apply gamma, clamp.
fn apply_levels(x: f32) -> f32 {
    let denom = LEVELS_WHITE - LEVELS_BLACK;
    let n = ((x - LEVELS_BLACK) / denom).clamp(0.0, 1.0);
    n.powf(LEVELS_EXP)
}

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma +
/// display-space Levels (look layer) + quantize. Returns a flat row-major
/// `Vec<u8>` of length 3 * w * h.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayLinearSrgb);
    let mut out = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        for &c in p {
            let g = srgb_gamma(c);
            let levelled = apply_levels(g);
            out.push((levelled * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
        }
    }
    img.space = ColorSpace::DisplayEncodedSrgb;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_zero_maps_to_zero() {
        assert!((srgb_gamma(0.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn gamma_one_maps_to_one() {
        assert!((srgb_gamma(1.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gamma_below_threshold_is_linear_times_12_92() {
        let x = 0.001;
        let expected = x * 12.92;
        assert!((srgb_gamma(x) - expected).abs() < 1e-6);
    }

    #[test]
    fn rec2020_white_maps_to_srgb_white() {
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = [1.0, 1.0, 1.0];
        rec2020_to_srgb(&mut img);
        for &c in &img.pixels[0] {
            assert!((c - 1.0).abs() < 1e-2);
        }
    }

    #[test]
    fn quantize_produces_expected_length() {
        let mut img = Image::new(4, 4, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert_eq!(bytes.len(), 4 * 4 * 3);
    }

    #[test]
    fn quantize_black_is_zero() {
        // With Levels black=66/255 applied, any gamma-encoded value ≤ 0.259
        // maps to u8 = 0 (Levels clamps the low end).
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        // With Levels white=227/255 applied, any gamma-encoded value ≥ 0.890
        // maps to u8 = 255. sRGB gamma of 1.0 is 1.0, which is > 0.890 → 255.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }

    #[test]
    fn levels_matches_photoshop_formula() {
        // Spot-check apply_levels against PS Levels: black=66, white=227,
        // gamma=0.65 on 0-255 u8 input 128 → output (128-66)/(227-66))^(1/0.65)
        // * 255 ≈ 124. (In float: 0.5019 → ((0.5019-0.2588)/0.6314)^1.538 ≈ 0.229
        //              → * 255 ≈ 58... hmm wait)
        // Actually: normalize = (128-66)/(227-66) = 62/161 = 0.385
        //           gamma = 0.385^1.538 = 0.227
        //           out = 0.227 * 255 = 58
        let srgb_in = 128.0 / 255.0;
        let out_float = apply_levels(srgb_in);
        let out_u8 = (out_float * 255.0 + 0.5) as u8;
        // Allow ±1 tolerance for float rounding.
        assert!((out_u8 as i32 - 58).abs() <= 1,
            "PS Levels check failed: {} → {}", 128, out_u8);
    }
}
