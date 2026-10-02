use super::*;

#[test]
fn sampled_sharpen_preserves_authored_radius_in_image_coordinates() {
    let mut original = Image::new(32, 32, ColorSpace::SceneLinearRec2020);
    for (i, pixel) in original.pixels.iter_mut().enumerate() {
        let value = if i % 32 < 16 { 0.08 } else { 0.6 };
        *pixel = [value, value * 0.8, value * 0.5];
    }
    let mut native = original.clone();
    apply(&mut native, 75.0, 2.0, 25.0, 0.0);
    for (scale, effective_radius) in [(0.5, 1.0), (0.25, 0.5), (0.1, 0.5)] {
        let mut sampled = original.clone();
        sampled.nr_sampling_scale = scale;
        apply(&mut sampled, 75.0, radius_at_scale(2.0, scale), 25.0, 0.0);
        let mut expected = original.clone();
        apply(&mut expected, 75.0, effective_radius, 25.0, 0.0);
        assert_eq!(sampled.pixels, expected.pixels);
        assert_ne!(sampled.pixels, native.pixels);
        assert_ne!(
            sampled.pixels, original.pixels,
            "sharpening must remain active"
        );
    }
    for scale in [1.0, 2.0, 0.0, -1.0, f32::NAN, f32::INFINITY] {
        let mut sampled = original.clone();
        sampled.nr_sampling_scale = scale;
        apply(&mut sampled, 75.0, radius_at_scale(2.0, scale), 25.0, 0.0);
        assert_eq!(sampled.pixels, native.pixels, "scale={scale}");
    }
}
