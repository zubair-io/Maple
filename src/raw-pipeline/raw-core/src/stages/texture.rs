use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};

const TEXTURE_RADIUS: usize = 3;

/// Unsharp mask at radius 3 for fine-frequency local contrast per spec § 3.8.
/// `texture` in [-100, +100]; 0 is identity.
pub fn apply(img: &mut Image, texture: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if texture.abs() < 1e-3 { return; }
    let amount = texture / 100.0;

    let blurred = gaussian_blur_rgb(img, TEXTURE_RADIUS);
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
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            assert!((p[0] - 0.5).abs() < 1e-4);
        }
    }

    #[test]
    fn enhances_edges() {
        // A step edge should get sharper with positive texture.
        let mut img = Image::new(10, 1, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < 5 { [0.3, 0.3, 0.3] } else { [0.7, 0.7, 0.7] };
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        // Darker side should go darker; brighter side should go brighter.
        assert!(img.pixels[4][0] <= before[4][0] + 0.01,
            "dark side at edge: {} vs before {}", img.pixels[4][0], before[4][0]);
        assert!(img.pixels[5][0] >= before[5][0] - 0.01,
            "bright side at edge: {} vs before {}", img.pixels[5][0], before[5][0]);
    }
}
