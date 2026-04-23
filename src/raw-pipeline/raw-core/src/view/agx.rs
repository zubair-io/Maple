use crate::image::{ColorSpace, Image};

const MIN_EV: f32 = -10.0;
const MAX_EV: f32 = 6.5;
const MID_GRAY: f32 = 0.18;
const LUT_SIZE: usize = 512;

/// Slice-1 stand-in for AgX's Default_Contrast sigmoid: a power curve
/// `y = x^gamma` with gamma = log(0.18) / log(0.6061) ≈ 3.42.
/// This hits the critical mid-gray anchor (scene 0.18 → display 0.18 in
/// linear-light) and is monotone with y(0)=0, y(1)=1.
///
/// **Not real AgX.** The toe shape is wrong (too dark in deep shadows)
/// and there is no per-channel gamut compression. Slice 6 replaces this
/// with the Blender-reference 6-piece polynomial sigmoid (spec § 3.6a).
fn agx_sigmoid(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x.powf(3.42)
}

fn build_lut() -> [f32; LUT_SIZE] {
    let mut lut = [0.0f32; LUT_SIZE];
    for i in 0..LUT_SIZE {
        let t = (i as f32) / ((LUT_SIZE - 1) as f32);
        lut[i] = agx_sigmoid(t).clamp(0.0, 1.0);
    }
    lut
}

static LUT: std::sync::OnceLock<[f32; LUT_SIZE]> = std::sync::OnceLock::new();

fn sample_lut(x: f32) -> f32 {
    let lut = LUT.get_or_init(build_lut);
    let x = x.clamp(0.0, 1.0);
    let idx = x * ((LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    lut[i0] * (1.0 - f) + lut[i1] * f
}

/// Normalized-log position of scene-linear MID_GRAY (0.18) after log+clamp+normalize.
/// = (log2(MID_GRAY/MID_GRAY) - MIN_EV) / (MAX_EV - MIN_EV) = 10/16.5.
/// Contrast modulation pivots around this point so the mid-gray anchor is stable.
const MID_NORM: f32 = 10.0 / 16.5;

fn agx_per_channel(scene: f32, slope: f32) -> f32 {
    let floor = MID_GRAY * MIN_EV.exp2();
    let clamped = scene.max(floor);
    let log = (clamped / MID_GRAY).log2().clamp(MIN_EV, MAX_EV);
    let norm = (log - MIN_EV) / (MAX_EV - MIN_EV);
    // Apply contrast as a slope around the mid-gray normalized anchor.
    let contrast_adjusted = (MID_NORM + (norm - MID_NORM) * slope).clamp(0.0, 1.0);
    sample_lut(contrast_adjusted).clamp(0.0, 1.0)
}

/// AgX view transform with contrast routed to sigmoid slope (spec § 3.6a).
/// Scene-linear Rec.2020 → display-linear Rec.2020. `contrast` in [-100, +100];
/// 0 is the unmodified sigmoid.
pub fn apply(img: &mut Image, contrast: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    // Slope = 1 + (contrast/100) * 0.5. At +100 → 1.5x, at -100 → 0.5x.
    let slope = 1.0 + (contrast / 100.0) * 0.5;
    for p in &mut img.pixels {
        p[0] = agx_per_channel(p[0], slope);
        p[1] = agx_per_channel(p[1], slope);
        p[2] = agx_per_channel(p[2], slope);
    }
    img.space = ColorSpace::DisplayLinearRec2020;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_is_monotone() {
        let mut prev = agx_sigmoid(0.0);
        for i in 1..=200 {
            let x = (i as f32) / 200.0;
            let y = agx_sigmoid(x);
            assert!(y >= prev - 1e-3, "non-monotone at x={}: {} < {}", x, y, prev);
            prev = y;
        }
    }

    #[test]
    fn mid_gray_maps_near_display_mid() {
        // Scene-linear MID_GRAY (0.18) → display-linear MID_GRAY (~0.18).
        // The power-curve approximation hits this exactly at the anchor.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img, 0.0);
        let p = img.pixels[0];
        assert!(p[0] > 0.15 && p[0] < 0.22, "R was {} (expected near 0.18)", p[0]);
    }

    #[test]
    fn huge_scene_values_map_below_one() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [100.0, 50.0, 20.0];
        apply(&mut img, 0.0);
        for &c in &img.pixels[0] {
            assert!(c < 1.01, "{} should have rolled off below 1", c);
        }
    }

    #[test]
    fn negative_inputs_clamp_to_toe_not_nan() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [-0.3, 0.0, 0.1];
        apply(&mut img, 0.0);
        for &c in &img.pixels[0] {
            assert!(c.is_finite());
            assert!(c >= 0.0 && c <= 1.0);
        }
    }

    #[test]
    fn space_transitions_correctly() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img, 0.0);
        assert_eq!(img.space, ColorSpace::DisplayLinearRec2020);
    }

    #[test]
    fn contrast_zero_matches_previous_identity_behavior() {
        // Sanity: contrast=0 should produce identical output to the slice-1 AgX
        // (same sigmoid, slope=1).
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img, 0.0);
        let out = img.pixels[0];
        assert!((out[0] - 0.18).abs() < 0.05, "mid-gray should stay near 0.18, got {}", out[0]);
    }

    #[test]
    fn contrast_positive_steepens_around_mid_gray() {
        // Pivot around mid-gray. A value above mid-gray should go higher with +100
        // contrast than with 0 contrast; a value below should go lower.
        let scene_bright = 0.5; // above mid-gray 0.18
        let scene_dark = 0.05;  // below mid-gray 0.18

        let mut img = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene_bright; 3];
        img.pixels[1] = [scene_dark; 3];
        apply(&mut img, 0.0);
        let baseline_bright = img.pixels[0][0];
        let baseline_dark = img.pixels[1][0];

        let mut img2 = Image::new(2, 1, ColorSpace::SceneLinearRec2020);
        img2.pixels[0] = [scene_bright; 3];
        img2.pixels[1] = [scene_dark; 3];
        apply(&mut img2, 100.0);
        let contrasty_bright = img2.pixels[0][0];
        let contrasty_dark = img2.pixels[1][0];

        assert!(contrasty_bright > baseline_bright,
            "bright should go higher with +100 contrast: {} vs {}", contrasty_bright, baseline_bright);
        assert!(contrasty_dark < baseline_dark,
            "dark should go lower with +100 contrast: {} vs {}", contrasty_dark, baseline_dark);
    }
}
