use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
};

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Oklab-based vibrance with skin-tone protection per spec § 3.7.
///
/// `vibrance` in [-100, +100]; 0 is identity. Low-chroma pixels get more
/// boost than high-chroma; hue in the skin window (15°-42° in Oklab) is
/// attenuated 60%. Endpoints are the spec's v1 placeholders — final values
/// are locked by the pre-ship calibration pass.
pub fn apply(img: &mut Image, vibrance: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if vibrance.abs() < 1e-3 { return; }
    let amount = vibrance / 100.0;

    for p in &mut img.pixels {
        let lab = rec2020_to_oklab(*p);
        let (l, a, b) = (lab[0], lab[1], lab[2]);
        let chroma = (a * a + b * b).sqrt();
        if chroma < 1e-6 {
            // Near-neutral pixel — nothing meaningful to scale.
            continue;
        }
        let hue_deg = b.atan2(a) * 180.0 / std::f32::consts::PI; // [-180, 180]
        let skin_mask = smoothstep(15.0, 22.0, hue_deg) * (1.0 - smoothstep(35.0, 42.0, hue_deg));
        let low_chroma_factor = 1.0 - (chroma / 0.3).min(1.0);
        let chroma_boost = low_chroma_factor * amount * (1.0 - skin_mask * 0.6);
        let scale = 1.0 + chroma_boost;
        let new_lab = [l, a * scale, b * scale];
        *p = oklab_to_rec2020(new_lab);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_zero() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.2, 0.4]; }
        let before = img.pixels.clone();
        apply(&mut img, 0.0);
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            assert!((a[0] - b[0]).abs() < 1e-5);
            assert!((a[1] - b[1]).abs() < 1e-5);
            assert!((a[2] - b[2]).abs() < 1e-5);
        }
    }

    #[test]
    fn neutral_gray_unchanged() {
        // Near-neutral pixel has near-zero chroma → vibrance can't boost anything.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.5, 0.5, 0.5];
        apply(&mut img, 100.0);
        for (c, &expected) in img.pixels[0].iter().zip([0.5, 0.5, 0.5].iter()) {
            assert!((c - expected).abs() < 1e-3, "{} != {}", c, expected);
        }
    }

    #[test]
    fn positive_vibrance_increases_low_chroma_more_than_high() {
        // Two pixels with same hue; low-chroma should gain more proportionally.
        let low_chroma_rgb = [0.35, 0.30, 0.30];   // slightly red
        let high_chroma_rgb = [0.80, 0.10, 0.10];   // very red

        let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = low_chroma_rgb;
        img.pixels[1] = high_chroma_rgb;

        let before_low = crate::color::oklab::rec2020_to_oklab(low_chroma_rgb);
        let before_low_chroma = (before_low[1] * before_low[1] + before_low[2] * before_low[2]).sqrt();
        let before_high = crate::color::oklab::rec2020_to_oklab(high_chroma_rgb);
        let before_high_chroma = (before_high[1] * before_high[1] + before_high[2] * before_high[2]).sqrt();

        apply(&mut img, 100.0);

        let after_low = crate::color::oklab::rec2020_to_oklab(img.pixels[0]);
        let after_low_chroma = (after_low[1] * after_low[1] + after_low[2] * after_low[2]).sqrt();
        let after_high = crate::color::oklab::rec2020_to_oklab(img.pixels[1]);
        let after_high_chroma = (after_high[1] * after_high[1] + after_high[2] * after_high[2]).sqrt();

        let low_ratio = after_low_chroma / before_low_chroma;
        let high_ratio = after_high_chroma / before_high_chroma;
        assert!(low_ratio > high_ratio,
            "low-chroma ratio {} should exceed high-chroma ratio {}", low_ratio, high_ratio);
    }

    #[test]
    fn preserves_scene_headroom() {
        // Scene-linear value > 1 must survive and stay finite.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [5.0, 3.0, 1.5];
        apply(&mut img, 50.0);
        for &c in &img.pixels[0] {
            assert!(c.is_finite(), "non-finite after vibrance: {}", c);
        }
    }
}
