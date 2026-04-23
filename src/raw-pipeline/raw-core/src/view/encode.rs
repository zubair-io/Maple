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

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma + quantize.
/// Returns a flat row-major `Vec<u8>` of length 3 * w * h.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayLinearSrgb);
    let mut out = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        for &c in p {
            let g = srgb_gamma(c);
            out.push((g * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
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
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }
}
