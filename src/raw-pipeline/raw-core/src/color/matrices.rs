use crate::math::{Matrix3, Vec3};

/// D50 reference white in XYZ (CIE 1931, Y=1).
/// See spec docs/spec/04-color-management.md § Bradford adaptation.
pub const XYZ_D50: Vec3 = [0.9642, 1.0000, 0.8251];

/// Convert a correlated color temperature to CIE XYZ (Y=1) on the Planckian /
/// daylight locus via Hernández-Andrés (1999). Used by DCP's Bradford step to
/// derive the scene illuminant's white point from the interpolated CCT, not
/// the nearest calibration illuminant. Valid in [2000K, 15000K]; clamped.
pub fn cct_to_xyz(cct: f32) -> Vec3 {
    let t = cct.clamp(2000.0, 15000.0);
    let x = if t <= 7000.0 {
         0.244_063
       + 99.11 / t
       + 2_967_800.0 / (t * t)
       - 4_607_000_000.0 / (t * t * t)
    } else {
         0.237_040
       + 247.48 / t
       + 1_901_800.0 / (t * t)
       - 2_006_400_000.0 / (t * t * t)
    };
    let y = -3.0 * x * x + 2.870 * x - 0.275;
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// D65 reference white in XYZ (CIE 1931, Y=1).
pub const XYZ_D65: Vec3 = [0.9504, 1.0000, 1.0888];

/// Bradford chromatic adaptation matrix: XYZ → LMS (cone-fundamental-like).
pub const BRADFORD: Matrix3 = Matrix3([
    [ 0.8951,  0.2664, -0.1614],
    [-0.7502,  1.7135,  0.0367],
    [ 0.0389, -0.0685,  1.0296],
]);

/// ProPhoto RGB → XYZ D50. From the DNG specification, "ROMM" matrix.
pub const M_PRO_TO_XYZ_D50: Matrix3 = Matrix3([
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0000000, 0.0000000, 0.8252100],
]);

/// XYZ D65 → linear Rec.2020. ITU-R BT.2020.
pub const M_XYZ_D65_TO_REC2020: Matrix3 = Matrix3([
    [ 1.7166512, -0.3556708, -0.2533663],
    [-0.6666844,  1.6164812,  0.0157685],
    [ 0.0176399, -0.0427706,  0.9421031],
]);

/// Linear Rec.2020 → sRGB linear. ITU-R BT.2020 → IEC 61966-2-1.
pub const M_REC2020_TO_SRGB: Matrix3 = Matrix3([
    [ 1.6605, -0.5876, -0.0728],
    [-0.1246,  1.1329, -0.0083],
    [-0.0182, -0.1006,  1.1187],
]);

/// Compute Bradford chromatic-adaptation matrix for `src_white` → `dst_white`.
/// Both in XYZ. See spec § 3.15.
pub fn bradford_adapt(src_white: Vec3, dst_white: Vec3) -> Matrix3 {
    let br = BRADFORD;
    let br_inv = br.inverse().expect("Bradford is non-singular");
    let src_lms = br.mul_vec(src_white);
    let dst_lms = br.mul_vec(dst_white);
    let scale = Matrix3([
        [dst_lms[0] / src_lms[0], 0.0, 0.0],
        [0.0, dst_lms[1] / src_lms[1], 0.0],
        [0.0, 0.0, dst_lms[2] / src_lms[2]],
    ]);
    br_inv.mul_mat(&scale).mul_mat(&br)
}

/// Composed ProPhoto D50 → linear Rec.2020 D65 matrix.
/// Folds ProPhoto→XYZ D50 + Bradford D50→D65 + XYZ→Rec.2020.
/// See spec § 04 and § 3.4 step 6.
pub fn m_pro_to_rec2020() -> Matrix3 {
    let adapt = bradford_adapt(XYZ_D50, XYZ_D65);
    M_XYZ_D65_TO_REC2020.mul_mat(&adapt).mul_mat(&M_PRO_TO_XYZ_D50)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Vec3, b: Vec3, eps: f32) -> bool {
        (a[0] - b[0]).abs() < eps && (a[1] - b[1]).abs() < eps && (a[2] - b[2]).abs() < eps
    }

    #[test]
    fn bradford_identity_when_whites_match() {
        let m = bradford_adapt(XYZ_D65, XYZ_D65);
        let v = [0.5, 0.5, 0.5];
        assert!(approx(m.mul_vec(v), v, 1e-5));
    }

    #[test]
    fn bradford_maps_source_white_to_destination_white() {
        let m = bradford_adapt(XYZ_D50, XYZ_D65);
        assert!(approx(m.mul_vec(XYZ_D50), XYZ_D65, 1e-4));
    }

    #[test]
    fn pro_to_rec2020_maps_mid_gray_to_reasonable_rec2020() {
        let m = m_pro_to_rec2020();
        let out = m.mul_vec([0.18, 0.18, 0.18]);
        assert!((out[1] - 0.18).abs() < 0.01, "G was {}", out[1]);
        assert!((out[0] - 0.18).abs() < 0.02, "R was {}", out[0]);
        assert!((out[2] - 0.18).abs() < 0.02, "B was {}", out[2]);
    }

    #[test]
    fn rec2020_to_srgb_preserves_white() {
        let out = M_REC2020_TO_SRGB.mul_vec([1.0, 1.0, 1.0]);
        assert!((out[0] - 1.0).abs() < 1e-3);
        assert!((out[1] - 1.0).abs() < 1e-3);
        assert!((out[2] - 1.0).abs() < 1e-3);
    }
}
