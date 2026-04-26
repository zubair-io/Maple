use crate::{
    color::matrices::M_REC2020_TO_SRGB,
    image::{ColorSpace, Image},
};
use rayon::prelude::*;

/// Rec.2020 → sRGB linear via compile-time 3×3.
pub fn rec2020_to_srgb(img: &mut Image) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    img.pixels.par_iter_mut().for_each(|p| {
        *p = M_REC2020_TO_SRGB.mul_vec(*p);
    });
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

// Display-space Levels look-layer was previously applied here (black=66,
// white=227, gamma=0.65) to compensate for Blender 4.x AgX's mid-gray lift
// when measured against ACR. Maple AgX (v6) is now calibrated directly
// against ACR — its polynomial places mid-gray near 0.18 display-linear,
// matching ACR's tone placement. The Levels layer is therefore no longer
// needed; leaving it in compounds the correction and crushes midtones.

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma +
/// quantize. Returns a flat row-major `Vec<u8>` of length 3 * w * h.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayLinearSrgb);
    let mut out = vec![0u8; img.pixels.len() * 3];
    out.par_chunks_mut(3)
        .zip(img.pixels.par_iter())
        .for_each(|(dst, p)| {
            for (i, &c) in p.iter().enumerate() {
                let g = srgb_gamma(c);
                dst[i] = (g * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            }
        });
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
        // Display-linear 0 → sRGB-encoded 0 → u8 0.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        // Display-linear 1.0 → sRGB-encoded 1.0 → u8 255.
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }

    #[test]
    fn quantize_mid_gray_lands_near_118() {
        // Display-linear 0.18 → sRGB-encoded ≈ 0.461 → u8 ≈ 118. This is
        // the classic mid-gray placement in display-encoded sRGB; the
        // Maple AgX polynomial is calibrated to land scene 0.18 here.
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
        img.pixels[0] = [0.18, 0.18, 0.18];
        let bytes = quantize_u8(&mut img);
        for &b in &bytes {
            assert!((b as i32 - 118).abs() <= 2,
                "mid-gray u8 = {}, expected near 118", b);
        }
    }
}
