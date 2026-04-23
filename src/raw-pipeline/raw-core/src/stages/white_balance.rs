use crate::{
    color::matrices::{M_XYZ_D65_TO_REC2020, XYZ_D65},
    image::{ColorSpace, Image},
    math::Vec3,
};

/// CCT (Kelvin) → CIE xy chromaticity using the Hernández-Andrés (1999) polynomial.
/// Valid in [3000K, 15000K]; mild error outside.
pub fn cct_to_xy(cct: f32) -> (f32, f32) {
    let t = cct.clamp(2000.0, 15000.0);
    let x = if t <= 7000.0 {
         0.244_063
       + 99.11   / t
       + 2_967_800.0 / (t * t)
       - 4_607_000_000.0 / (t * t * t)
    } else {
         0.237_040
       + 247.48 / t
       + 1_901_800.0 / (t * t)
       - 2_006_400_000.0 / (t * t * t)
    };
    let y = -3.000 * x * x + 2.870 * x - 0.275;
    (x, y)
}

pub fn xy_to_xyz(x: f32, y: f32, big_y: f32) -> Vec3 {
    let big_x = (x / y) * big_y;
    let big_z = ((1.0 - x - y) / y) * big_y;
    [big_x, big_y, big_z]
}

/// Compute per-channel gains in linear Rec.2020 for a target (temperature, tint).
/// Tint in [-100, 100] with 0.001 per-unit scaling (spec § 3.5).
pub fn wb_gains(temperature: f32, tint: f32) -> Vec3 {
    let (x, mut y) = cct_to_xy(temperature);
    y += tint * 0.001;
    let xyz_target = xy_to_xyz(x, y, 1.0);
    // Transform both target and D65 reference to Rec.2020, then take ratio.
    // This preserves scene-referred scaling: gain = (M @ target) / (M @ D65).
    let target_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(xyz_target);
    let d65_rec2020 = M_XYZ_D65_TO_REC2020.mul_vec(XYZ_D65);
    let gain = [
        target_rec2020[0] / d65_rec2020[0],
        target_rec2020[1] / d65_rec2020[1],
        target_rec2020[2] / d65_rec2020[2],
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
    fn warm_temperature_boosts_red() {
        let gains = wb_gains(3000.0, 0.0);
        assert!(gains[0] > 1.2, "R should boost warm, got {}", gains[0]);
        assert!(gains[2] < 0.8, "B should cut warm, got {}", gains[2]);
    }

    #[test]
    fn cool_temperature_boosts_blue() {
        let gains = wb_gains(10000.0, 0.0);
        assert!(gains[2] > 1.05, "B should boost cool, got {}", gains[2]);
        assert!(gains[0] < 0.95, "R should cut cool, got {}", gains[0]);
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
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
        apply(&mut img, 3000.0, 0.0);
        for p in &img.pixels {
            assert!(p[0] > 0.3, "R should boost");
            assert!(p[2] < 0.3, "B should cut");
        }
    }
}
