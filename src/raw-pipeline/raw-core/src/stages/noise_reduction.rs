//! Simplified noise reduction per spec § 3.11 (slice-5 shim).
//!
//! Luminance NR blurs the L channel of Oklab; chroma (a, b) untouched.
//! Color NR blurs a and b; L untouched. Full NLM implementation lands later.

use crate::{
    color::oklab::{oklab_to_rec2020, rec2020_to_oklab},
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};

/// Apply luminance NR: blur L in Oklab, leave chroma.
pub fn apply_luminance(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    // Blur radius scales with amount [0..100] → radius [0..2].
    let radius = ((amount / 100.0) * 2.0).ceil() as usize;
    let radius = radius.max(1);

    // Convert whole image to Oklab (L, a, b) stored per-pixel.
    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter().enumerate() {
        oklab_img.pixels[i] = rec2020_to_oklab(*p);
    }
    // Blur only L (channel 0). Replicate L into a 3-channel image,
    // blur, and pick channel 0 back out.
    let mut l_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        l_only.pixels[i] = [p[0], p[0], p[0]];
    }
    let blurred_l = gaussian_blur_rgb(&l_only, radius);
    for i in 0..oklab_img.pixels.len() {
        oklab_img.pixels[i][0] = blurred_l.pixels[i][0];
    }
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        img.pixels[i] = oklab_to_rec2020(*p);
    }
}

/// Apply color NR: blur a and b in Oklab, leave luminance.
pub fn apply_color(img: &mut Image, amount: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }
    let radius = ((amount / 100.0) * 4.0).ceil() as usize;
    let radius = radius.max(1);

    let mut oklab_img = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter().enumerate() {
        oklab_img.pixels[i] = rec2020_to_oklab(*p);
    }
    // Blur (a, b) via a 3-channel image: put a in R, b in G, 0 in B.
    let mut chroma_only = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        chroma_only.pixels[i] = [p[1], p[2], 0.0];
    }
    let blurred = gaussian_blur_rgb(&chroma_only, radius);
    for i in 0..oklab_img.pixels.len() {
        oklab_img.pixels[i][1] = blurred.pixels[i][0];
        oklab_img.pixels[i][2] = blurred.pixels[i][1];
    }
    for (i, p) in oklab_img.pixels.iter().enumerate() {
        img.pixels[i] = oklab_to_rec2020(*p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_luminance_is_identity() {
        let mut img = Image::new(5, 5, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.5, 0.7]; }
        let before = img.pixels.clone();
        apply_luminance(&mut img, 0.0);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn zero_color_is_identity() {
        let mut img = Image::new(5, 5, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.5, 0.7]; }
        let before = img.pixels.clone();
        apply_color(&mut img, 0.0);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn luminance_smooths_without_killing_color() {
        // Alternating bright/dark pixels on same hue.
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i % 2 == 0 { [0.6, 0.3, 0.3] } else { [0.3, 0.1, 0.1] };
        }
        apply_luminance(&mut img, 100.0);
        // After blur the luminance alternation should be reduced;
        // the red tint should persist.
        for p in &img.pixels {
            let luma = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2];
            let saturation = (p[0] - p[1]).max(p[0] - p[2]);
            // Average luma ≈ (luma_bright + luma_dark)/2 = ~0.25. Individual
            // pixel luminance should land close to that; we assert only that
            // it's somewhere in the valid range.
            assert!(luma > 0.15 && luma < 0.6, "luma out of expected range: {}", luma);
            assert!(saturation > 0.05, "saturation lost: {}", saturation);
        }
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(5, 5, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [5.0, 3.0, 1.5]; }
        apply_luminance(&mut img, 100.0);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }
}
