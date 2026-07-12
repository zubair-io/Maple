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
        0.244_063 + 99.11 / t + 2_967_800.0 / (t * t) - 4_607_000_000.0 / (t * t * t)
    } else {
        0.237_040 + 247.48 / t + 1_901_800.0 / (t * t) - 2_006_400_000.0 / (t * t * t)
    };
    let y = -3.0 * x * x + 2.870 * x - 0.275;
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// D65 reference white in XYZ (CIE 1931, Y=1).
pub const XYZ_D65: Vec3 = [0.9504, 1.0000, 1.0888];

/// Bradford chromatic adaptation matrix: XYZ → LMS (cone-fundamental-like).
pub const BRADFORD: Matrix3 = Matrix3([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
]);

/// CAT16 chromatic adaptation matrix: XYZ → LMS (cone-fundamental-like).
///
/// Reference: Li, Ronnier, Pointer, Hellwig, Melgosa, Cui (2017),
/// "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS",
/// *Color Research & Application*, 42(6): 703–718, Table 4.
/// (Equivalent constants appear in CIE 248:2022.)
///
/// CAT16 is the modern replacement for CAT02 (which has known
/// out-of-gamut behaviour for extreme XYZ vectors) and the older
/// Bradford. Darktable's `iop/channelmixerrgb.c` uses CAT16 as the
/// default chromatic-adaptation transform for user WB; we mirror that
/// choice.
pub const CAT16: Matrix3 = Matrix3([
    [0.401288, 0.650173, -0.051461],
    [-0.250268, 1.204414, 0.045854],
    [-0.002079, 0.048952, 0.953127],
]);

/// XYZ D65 → linear Rec.2020 inverse, pre-folded.
///
/// `M_XYZ_D65_TO_REC2020.inverse()` at runtime would work too, but the
/// user-WB path multiplies this matrix into the per-pixel CAT16 update
/// matrix once per (T, tint) — having the constant avoids the
/// `.inverse().expect()` call on the hot path.
pub const M_REC2020_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.6369580, 0.1446169, 0.1688810],
    [0.2627002, 0.6779981, 0.0593017],
    [0.0000000, 0.0280727, 1.0609851],
]);

/// ProPhoto RGB → XYZ D50. From the DNG specification, "ROMM" matrix.
pub const M_PRO_TO_XYZ_D50: Matrix3 = Matrix3([
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0000000, 0.0000000, 0.8252100],
]);

/// XYZ D65 → linear Rec.2020. ITU-R BT.2020.
pub const M_XYZ_D65_TO_REC2020: Matrix3 = Matrix3([
    [1.7166512, -0.3556708, -0.2533663],
    [-0.6666844, 1.6164812, 0.0157685],
    [0.0176399, -0.0427706, 0.9421031],
]);

/// Linear Rec.2020 → sRGB linear. ITU-R BT.2020 → IEC 61966-2-1.
pub const M_REC2020_TO_SRGB: Matrix3 = Matrix3([
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
]);

/// Linear Rec.2020 → linear Display P3 (SMPTE RP 431-2, D65 white point).
///
/// Derived from first principles via XYZ D65:
///   `M_XYZ_D65_TO_P3 · M_REC2020_TO_XYZ_D65`
/// where `M_XYZ_D65_TO_P3` is computed from the Display P3 chromaticities
/// (R: 0.680/0.320, G: 0.265/0.690, B: 0.150/0.060) and D65 white
/// (0.3127/0.3290) — the same derivation procedure as `M_REC2020_TO_SRGB`.
///
/// Cross-checked: white `[1,1,1]` maps to `[1,1,1]` within floating-point
/// precision; the sRGB constant matches the analogous derivation bit-for-bit.
///
/// Used by the `display_encode` view-tail when `TargetPrimaries::P3` is
/// selected (ticket #1337). The OETF is identical for sRGB and Display P3
/// (IEC 61966-2-1 / 2.4-gamma), so `srgb_gamma_encode` is unchanged.
///
/// As of #1921 this is the **first** step of the P3 path: the working triple is
/// rotated Rec.2020 → linear P3 here, and the Oklab gamut compression then runs
/// against the P3 hull (via `p3_linear_to_oklab` / `oklab_to_p3_linear`). The
/// pre-#1921 order compressed to the sRGB hull first and rotated afterward,
/// which capped P3 output at sRGB gamut.
pub const M_REC2020_TO_P3: Matrix3 = Matrix3([
    [1.3436, -0.2822, -0.0614],
    [-0.0653, 1.0758, -0.0105],
    [0.0028, -0.0196, 1.0168],
]);

/// Linear sRGB → linear Display P3 (SMPTE RP 431-2, D65 white point).
///
/// Derived from IEC 61966-2-1 (sRGB) and SMPTE RP 431-2 (Display P3)
/// chromaticities, both at the D65 white point (0.3127/0.3290):
///   `M_XYZ_D65_TO_P3 · M_SRGB_TO_XYZ_D65`
///
/// White `[1,1,1]` maps to `[1,1,1]` exactly (both primaries share D65).
/// The two off-diagonal near-zero entries are exactly 0.0 to floating-point
/// precision of the chromaticity derivation.
///
/// Used by the `display_encode` view-tail (`rec2020_to_display`, ticket
/// #1337): the P3 path applies Oklab gamut compression in **linear sRGB**
/// (where the Oklab helpers are defined), then applies this matrix to rotate
/// from sRGB primaries to P3 primaries. The order is:
///   1. Rec.2020 → sRGB (`M_REC2020_TO_SRGB`)
///   2. Oklab gamut compress (valid in linear sRGB)
///   3. sRGB → P3 (`M_SRGB_TO_P3`) ← this matrix
pub const M_SRGB_TO_P3: Matrix3 = Matrix3([
    [0.822_462_0, 0.177_538_0, 0.000_000_0],
    [0.033_194_2, 0.966_805_8, 0.000_000_0],
    [0.017_082_6, 0.072_397_4, 0.910_519_9],
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
    M_XYZ_D65_TO_REC2020
        .mul_mat(&adapt)
        .mul_mat(&M_PRO_TO_XYZ_D50)
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

    #[test]
    fn rec2020_to_xyz_and_back_round_trips() {
        // M_REC2020_TO_XYZ_D65 is the pre-folded inverse of M_XYZ_D65_TO_REC2020
        // (primary source: BT.2020). Verify the round-trip on a few non-trivial
        // colours.
        let cases = [
            [1.0, 1.0, 1.0],
            [0.18, 0.18, 0.18],
            [0.5, 0.3, 0.7],
            [0.0, 1.0, 0.0],
        ];
        for rgb in cases {
            let xyz = M_REC2020_TO_XYZ_D65.mul_vec(rgb);
            let back = M_XYZ_D65_TO_REC2020.mul_vec(xyz);
            assert!(
                approx(back, rgb, 1e-3),
                "round-trip {:?} -> XYZ {:?} -> {:?}",
                rgb,
                xyz,
                back
            );
        }
    }

    #[test]
    fn cat16_d65_maps_to_d65_in_lms_identity() {
        // Sanity: CAT16 · D65_XYZ should produce a finite LMS triplet
        // (no zero / negative components) — CAT16 is positivity-preserving
        // for typical illuminants.
        let lms = CAT16.mul_vec(XYZ_D65);
        for c in 0..3 {
            assert!(
                lms[c] > 0.5 && lms[c] < 1.5,
                "CAT16(D65) cone {} = {} outside expected band",
                c,
                lms[c]
            );
        }
    }
}
