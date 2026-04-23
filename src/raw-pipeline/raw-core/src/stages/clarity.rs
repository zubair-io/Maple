use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};

const CLARITY_RADIUS: usize = 40;

/// Unsharp mask at radius 40 for mid-frequency local contrast per spec § 3.8.
/// `clarity` in [-100, +100]; 0 is identity.
pub fn apply(img: &mut Image, clarity: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if clarity.abs() < 1e-3 { return; }
    let amount = clarity / 100.0;

    let blurred = gaussian_blur_rgb(img, CLARITY_RADIUS);
    for (p, b) in img.pixels.iter_mut().zip(blurred.pixels.iter()) {
        p[0] += (p[0] - b[0]) * amount;
        p[1] += (p[1] - b[1]) * amount;
        p[2] += (p[2] - b[2]) * amount;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_zero() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [(i % 3) as f32 * 0.3, 0.5, 0.7];
        }
        let before = img.pixels.clone();
        apply(&mut img, 0.0);
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn flat_input_stays_flat() {
        // A perfectly flat field has no high-frequency content; unsharp adds nothing.
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            assert!((p[0] - 0.5).abs() < 1e-4);
        }
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [5.0, 3.0, 1.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }
}
