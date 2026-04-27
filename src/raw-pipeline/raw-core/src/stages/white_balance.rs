use crate::{
    color::matrices::{M_XYZ_D65_TO_REC2020, XYZ_D65},
    image::{ColorSpace, Image},
    math::Vec3,
};

/// CCT (Kelvin) → CIE xy chromaticity on the **Planckian (blackbody) locus**
/// via Hernández-Andrés et al. 1999, "Calculating correlated color
/// temperatures across the entire gamut of daylight and skylight
/// chromaticities" (Applied Optics 38(27), 5703–5709).
///
/// Valid range: 1667K – 25000K. Clamped to [2000K, 25000K] here because
/// (a) ACR's slider exposes 2000K–50000K and (b) the polynomial is
/// not defined above 25000K — clamping the upper bound matches what
/// ACR appears to do internally.
///
/// Earlier versions of this function used the Krystek 1985 D-illuminant
/// polynomial. That fits the daylight locus (~4000K–25000K) and
/// extrapolates poorly at the warm end: at 2000K it under-cooled
/// vs ACR's slider. The slider-visual-matrix harness on test_0002
/// surfaced the magnitude error after the direction fix landed.
pub fn cct_to_xy(cct: f32) -> (f32, f32) {
    let t = cct.clamp(2000.0, 25000.0);
    let x = if t <= 4000.0 {
         0.179_910
       + 0.877_695_6e3 / t
       - 0.234_358_9e6 / (t * t)
       - 0.266_123_9e9 / (t * t * t)
    } else {
         0.240_390
       + 0.222_634_7e3 / t
       + 2.107_037_9e6 / (t * t)
       - 3.025_846_9e9 / (t * t * t)
    };
    let y = -3.000 * x * x + 2.870 * x - 0.275;
    (x, y)
}

pub fn xy_to_xyz(x: f32, y: f32, big_y: f32) -> Vec3 {
    let big_x = (x / y) * big_y;
    let big_z = ((1.0 - x - y) / y) * big_y;
    [big_x, big_y, big_z]
}

/// Compute per-channel gains in linear Rec.2020 for a SOURCE-LIGHT
/// (temperature, tint). Tint in [-100, 100] with 0.001 per-unit scaling
/// (spec § 3.5).
///
/// ACR convention: the temperature slider value is the COLOR TEMPERATURE
/// OF THE LIGHT THE PHOTO WAS TAKEN UNDER. To render the scene as
/// neutral D65 we apply the INVERSE of the source-light chromaticity:
///   gain = D65_rec2020 / source_rec2020
///
/// At source = 2000K (tungsten), `source_rec2020` has high R and low B,
/// so `gain = D65/source` gives low R and high B — cooling the image,
/// which is the correct ACR direction for "compensate warm tungsten".
///
/// The previous code computed `target / D65` which made warm-CCT
/// sliders WARM the image (the opposite of ACR). The slider-visual-
/// matrix harness on test_0002 surfaced this immediately:
/// temperature_min (2000K) rendered red/magenta on Maple where ACR
/// produced blue. Fix flipped the ratio direction.
pub fn wb_gains(temperature: f32, tint: f32) -> Vec3 {
    // ACR tint semantics differ from temperature: the slider VALUE is the
    // image-direction shift the user wants (positive = add green, negative
    // = add magenta), NOT the source-light direction. To produce that
    // image shift via a "source / D65" gain, the source must be in the
    // OPPOSITE chromaticity direction. Subtract (rather than add) tint
    // from y so positive tint moves source DOWN (toward magenta) → gain
    // = D65/source pushes image UP (toward green) → image gets greener.
    // Matches ACR's "drag right = greener" UI affordance.
    let (x, mut y) = cct_to_xy(temperature);
    y -= tint * 0.001;
    let xyz_source = xy_to_xyz(x, y, 1.0);
    let source_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(xyz_source);
    let d65_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(XYZ_D65);
    let gain = [
        d65_rec2020[0] / source_rec2020[0],
        d65_rec2020[1] / source_rec2020[1],
        d65_rec2020[2] / source_rec2020[2],
    ];
    // Normalize so green = 1.
    let g = gain[1].max(1e-6);
    [gain[0] / g, 1.0, gain[2] / g]
}

pub fn apply(img: &mut Image, temperature: f32, tint: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if (temperature - 6500.0).abs() < 0.5 && tint.abs() < 0.5 {
        return; // identity short-circuit
    }
    let g = wb_gains(temperature, tint);
    for p in &mut img.pixels {
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn d65_reference_at_6500k_tint_0() {
        let gains = wb_gains(6500.0, 0.0);
        // Gains should be close to (1, 1, 1) at the pipeline's native white.
        assert!((gains[0] - 1.0).abs() < 0.05, "R gain {}", gains[0]);
        assert!((gains[1] - 1.0).abs() < 1e-6, "G gain {}", gains[1]);
        assert!((gains[2] - 1.0).abs() < 0.05, "B gain {}", gains[2]);
    }

    #[test]
    fn warm_source_cools_image() {
        // ACR convention: temp slider value = source-light CCT. A warm
        // source (3000K, tungsten) means we apply COOLING to compensate
        // — gain[R] < 1, gain[B] > 1. Reversed in the previous version.
        let gains = wb_gains(3000.0, 0.0);
        assert!(gains[0] < 0.85,
            "R should cut to cool a warm-source scene, got {}", gains[0]);
        assert!(gains[2] > 1.20,
            "B should boost to cool a warm-source scene, got {}", gains[2]);
    }

    #[test]
    fn cool_source_warms_image() {
        // Cool source (10000K, overcast) → apply WARMING to compensate.
        let gains = wb_gains(10000.0, 0.0);
        assert!(gains[2] < 0.95,
            "B should cut to warm a cool-source scene, got {}", gains[2]);
        assert!(gains[0] > 1.05,
            "R should boost to warm a cool-source scene, got {}", gains[0]);
    }

    #[test]
    fn default_is_identity_on_image() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.4, 0.5]; }
        apply(&mut img, 6500.0, 0.0);
        for p in &img.pixels {
            assert_eq!(p, &[0.3, 0.4, 0.5]);
        }
    }

    #[test]
    fn non_default_mutates_pixels() {
        // Warm source = 3000K → cooling correction → R cut, B boost.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
        apply(&mut img, 3000.0, 0.0);
        for p in &img.pixels {
            assert!(p[0] < 0.3, "R should cut for warm-source cooling, got {}", p[0]);
            assert!(p[2] > 0.3, "B should boost for warm-source cooling, got {}", p[2]);
        }
    }

    #[test]
    fn negative_tint_adds_magenta() {
        // ACR convention: negative tint = add magenta to image (R+B up
        // relative to G). gain[G] is normalized to 1.0 so G stays put;
        // magenta manifests as R and B both rising above G.
        // Surfaced by slider_visual_matrix.py — earlier flipped-direction
        // bug had tint_min(-150) rendering green where ACR rendered magenta.
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
        apply(&mut img, 6500.0, -100.0);
        for p in &img.pixels {
            assert!(p[0] > p[1],
                "R should exceed G for magenta tint, got R={} G={}", p[0], p[1]);
            assert!(p[2] > p[1],
                "B should exceed G for magenta tint, got B={} G={}", p[2], p[1]);
        }
    }

    #[test]
    fn extreme_warm_2000k_cools_strongly() {
        // ACR exposes 2000K at the cool end of the Temperature slider.
        // Krystek's daylight polynomial under-cools at 2000K vs ACR;
        // Hernández-Andrés's Planckian polynomial cools much harder
        // (R drops to ~0.41, B rises to ~5.34 at 2000K).
        let gains = wb_gains(2000.0, 0.0);
        assert!(gains[0] < 0.6,
            "R should fall below 0.6 to deeply cool a 2000K source, got {}", gains[0]);
        assert!(gains[2] > 3.0,
            "B should exceed 3.0 to deeply cool a 2000K source, got {}", gains[2]);
    }

    #[test]
    fn extreme_cool_50000k_warms_strongly() {
        // ACR exposes 50000K at the warm end of the Temperature slider.
        // Hernández-Andrés is defined only to 25000K, so the polynomial
        // clamps above that — matches ACR's apparent behaviour. At the
        // 25000K clamp R~1.18 (warming) and B~0.57 (cool-source kill).
        let gains = wb_gains(50000.0, 0.0);
        assert!(gains[0] > 1.15,
            "R should boost above 1.15 to warm a 50000K (clamped 25000K) source, got {}", gains[0]);
        assert!(gains[2] < 0.6,
            "B should fall below 0.6 to warm a 50000K source, got {}", gains[2]);
    }

    #[test]
    fn positive_tint_adds_green() {
        // Symmetric: positive tint = add green to image — R and B both
        // drop below G (G normalized at 1.0).
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
        apply(&mut img, 6500.0, 100.0);
        for p in &img.pixels {
            assert!(p[1] > p[0],
                "G should exceed R for green tint, got G={} R={}", p[1], p[0]);
            assert!(p[1] > p[2],
                "G should exceed B for green tint, got G={} B={}", p[1], p[2]);
        }
    }
}
