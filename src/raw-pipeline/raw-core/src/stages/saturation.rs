use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
};

/// Oklab-based chroma scale per spec § 02 ("chroma-preserving saturation in a
/// gamut-invariant space, not CIColorControls").
///
/// `saturation` in [-100, +100]; 0 is identity. `-100` fully desaturates to
/// achromatic; `+100` doubles chroma. Unlike vibrance, saturation has no
/// low-chroma boost and no skin-tone protection — it scales all chroma uniformly.
pub fn apply(img: &mut Image, saturation: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if saturation.abs() < 1e-3 { return; }
    let scale = 1.0 + saturation / 100.0;

    for p in &mut img.pixels {
        let lab = rec2020_to_oklab(*p);
        let new_lab = [lab[0], lab[1] * scale, lab[2] * scale];
        *p = oklab_to_rec2020(new_lab);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_zero() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.4, 0.3, 0.5]; }
        let before = img.pixels.clone();
        apply(&mut img, 0.0);
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            assert!((a[0] - b[0]).abs() < 1e-5);
            assert!((a[1] - b[1]).abs() < 1e-5);
            assert!((a[2] - b[2]).abs() < 1e-5);
        }
    }

    #[test]
    fn minus_100_makes_achromatic() {
        // Saturation -100 → scale=0 → a=0, b=0 → neutral gray.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.8, 0.1, 0.1];
        apply(&mut img, -100.0);
        // After full desaturation, R == G == B (within float tolerance).
        let p = img.pixels[0];
        assert!((p[0] - p[1]).abs() < 0.05, "R {} vs G {}", p[0], p[1]);
        assert!((p[1] - p[2]).abs() < 0.05, "G {} vs B {}", p[1], p[2]);
    }

    #[test]
    fn plus_100_doubles_chroma() {
        // Saturation +100 should increase chroma (not exactly 2x in RGB because
        // Oklab chroma scales uniformly but sRGB channels do not).
        let rgb = [0.5, 0.3, 0.3];
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = rgb;

        let before = crate::color::oklab::rec2020_to_oklab(rgb);
        let before_chroma = (before[1] * before[1] + before[2] * before[2]).sqrt();
        apply(&mut img, 100.0);
        let after = crate::color::oklab::rec2020_to_oklab(img.pixels[0]);
        let after_chroma = (after[1] * after[1] + after[2] * after[2]).sqrt();
        // Expect chroma to approximately double (Oklab chroma scaling is exact;
        // float round-trip should be tight).
        assert!((after_chroma / before_chroma - 2.0).abs() < 1e-3,
            "chroma ratio {} should be ~2.0", after_chroma / before_chroma);
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [5.0, 3.0, 1.5];
        apply(&mut img, 50.0);
        for &c in &img.pixels[0] {
            assert!(c.is_finite(), "non-finite after saturation: {}", c);
        }
    }
}
