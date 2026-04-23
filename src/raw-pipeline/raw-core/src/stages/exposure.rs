use crate::image::{ColorSpace, Image};

/// Apply exposure (EV) in scene-linear Rec.2020. `rgb * 2^ev` per spec § 3.6.
pub fn apply(img: &mut Image, ev: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if ev.abs() < 1e-6 { return; }
    let gain = ev.exp2();
    for p in &mut img.pixels {
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ev_zero_is_identity() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        apply(&mut img, 0.0);
        for p in &img.pixels {
            assert_eq!(*p, [0.18, 0.18, 0.18]);
        }
    }

    #[test]
    fn ev_plus_one_doubles() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.1, 0.2, 0.3];
        apply(&mut img, 1.0);
        let p = img.pixels[0];
        assert!((p[0] - 0.2).abs() < 1e-6);
        assert!((p[1] - 0.4).abs() < 1e-6);
        assert!((p[2] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn ev_minus_one_halves() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.4, 0.6, 0.8];
        apply(&mut img, -1.0);
        let p = img.pixels[0];
        assert!((p[0] - 0.2).abs() < 1e-6);
        assert!((p[1] - 0.3).abs() < 1e-6);
        assert!((p[2] - 0.4).abs() < 1e-6);
    }

    #[test]
    fn preserves_scene_headroom() {
        // Scene-linear: values > 1 must pass through doubled.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [5.0, 5.0, 5.0];
        apply(&mut img, 1.0);
        assert_eq!(img.pixels[0], [10.0, 10.0, 10.0]);
    }
}
