//! Oklab color space (Björn Ottosson, 2020). Perceptually uniform and
//! gamut-invariant for chroma adjustments (spec § 3.7).
//!
//! Working space in raw-core is linear Rec.2020 D65; Oklab is defined
//! against linear sRGB D65. Since both share D65, we route via the
//! existing `M_REC2020_TO_SRGB` matrix and compose once.

use crate::{
    color::matrices::M_REC2020_TO_SRGB,
    math::{Matrix3, Vec3},
};

/// Ottosson's M1: linear sRGB → LMS. Published in his 2020 paper.
const M1_SRGB_TO_LMS: Matrix3 = Matrix3([
    [0.412_221_47, 0.536_332_54, 0.051_445_99],
    [0.211_903_50, 0.680_699_55, 0.107_396_96],
    [0.088_302_46, 0.281_718_84, 0.629_978_70],
]);

/// Ottosson's M2: cube-rooted LMS → Lab. Published in his 2020 paper.
const M2_LMS_TO_LAB: Matrix3 = Matrix3([
    [ 0.210_454_26,  0.793_617_79, -0.004_072_05],
    [ 1.977_998_50, -2.428_592_21,  0.450_593_71],
    [ 0.025_904_04,  0.782_771_77, -0.808_675_77],
]);

/// Scene-linear Rec.2020 D65 → Oklab.
/// Per-pixel cost: two 3×3 matrix multiplies + three cube roots.
pub fn rec2020_to_oklab(rgb: Vec3) -> Vec3 {
    // Rec.2020 → sRGB → LMS.
    let srgb = M_REC2020_TO_SRGB.mul_vec(rgb);
    let lms = M1_SRGB_TO_LMS.mul_vec(srgb);
    // Cube root — preserves sign on negatives (cbrt of a negative is negative).
    let lms_cube = [lms[0].cbrt(), lms[1].cbrt(), lms[2].cbrt()];
    M2_LMS_TO_LAB.mul_vec(lms_cube)
}

/// Inverse of `rec2020_to_oklab`.
pub fn oklab_to_rec2020(lab: Vec3) -> Vec3 {
    let m2_inv = M2_LMS_TO_LAB.inverse().expect("M2 is invertible");
    let lms_cube = m2_inv.mul_vec(lab);
    // Cube (inverse of cbrt) — sign-preserving.
    let lms = [
        lms_cube[0] * lms_cube[0] * lms_cube[0],
        lms_cube[1] * lms_cube[1] * lms_cube[1],
        lms_cube[2] * lms_cube[2] * lms_cube[2],
    ];
    let m1_inv = M1_SRGB_TO_LMS.inverse().expect("M1 is invertible");
    let srgb = m1_inv.mul_vec(lms);
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().expect("M_REC2020_TO_SRGB is invertible");
    m_srgb_to_rec2020.mul_vec(srgb)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Vec3, b: Vec3, eps: f32) -> bool {
        (a[0] - b[0]).abs() < eps && (a[1] - b[1]).abs() < eps && (a[2] - b[2]).abs() < eps
    }

    #[test]
    fn round_trip_preserves_neutral_gray() {
        let rgb = [0.18, 0.18, 0.18];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(approx(rgb, back, 1e-4), "round trip drifted: {:?} -> {:?}", rgb, back);
    }

    #[test]
    fn round_trip_preserves_saturated_red() {
        let rgb = [0.8, 0.1, 0.1];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(approx(rgb, back, 1e-4), "round trip drifted: {:?} -> {:?}", rgb, back);
    }

    #[test]
    fn round_trip_preserves_scene_headroom_values() {
        // Scene-linear values can exceed 1.0; Oklab must survive.
        let rgb = [5.0, 3.0, 1.5];
        let lab = rec2020_to_oklab(rgb);
        let back = oklab_to_rec2020(lab);
        assert!(approx(rgb, back, 1e-3), "round trip drifted: {:?} -> {:?}", rgb, back);
    }

    #[test]
    fn neutral_gray_has_zero_ab() {
        // Any R=G=B input should have no chroma in Oklab (a=b=0).
        let lab = rec2020_to_oklab([0.5, 0.5, 0.5]);
        assert!(lab[1].abs() < 1e-3, "a = {}", lab[1]);
        assert!(lab[2].abs() < 1e-3, "b = {}", lab[2]);
    }

    #[test]
    fn negative_inputs_do_not_produce_nan() {
        // Scene-referred values can be slightly negative (from DCP).
        let rgb = [-0.01, 0.1, 0.2];
        let lab = rec2020_to_oklab(rgb);
        for &c in &lab {
            assert!(c.is_finite(), "NaN in Oklab from negative input");
        }
    }
}
